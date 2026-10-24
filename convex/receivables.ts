import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  authSeat,
  checkIdempotency,
  fail,
  getRun,
  logActivity,
  recordViolation,
  storeIdempotency,
  type Fail,
  type Seat,
} from "./lib/kernel";
import { appendEntry } from "./lib/post";
import { receivedDocument } from "./lib/evidence";
import { lineIssues } from "../src/integrations/ar-document";

const seatArgs = { runId: v.string(), seatId: v.string(), token: v.string() };

const AR_DOCUMENTS = ["ar_document"];
const MASTER_DOCUMENTS = ["customer_master"];
const LIVE = new Set(["open", "held"]);

const lineArg = v.object({
  sku: v.optional(v.string()),
  description: v.string(),
  quantity: v.number(),
  unitCents: v.number(),
  amountCents: v.number(),
});

/** "INV-2025-1013", "inv 2025 1013" and "INV20251013" are the same document number. */
export function normalizeDocumentNumber(n: string): string {
  return n.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

type Disposition = Omit<Doc<"dispositions">, "_id" | "_creationTime" | "runId" | "at">;

async function pathOf(ctx: QueryCtx, documentEventId: string): Promise<string> {
  const id = ctx.db.normalizeId("events", documentEventId);
  const event = id ? await ctx.db.get(id) : null;
  return String((event?.payload as { path?: string } | undefined)?.path ?? documentEventId);
}

/** Every received document ends with exactly one disposition; the latest decision about it wins. */
async function setDisposition(ctx: MutationCtx, runId: string, d: Disposition): Promise<void> {
  const existing = await ctx.db
    .query("dispositions")
    .withIndex("by_run_document", (q) => q.eq("runId", runId).eq("documentEventId", d.documentEventId))
    .unique();
  if (existing) await ctx.db.patch(existing._id, { ...d, at: Date.now() });
  else await ctx.db.insert("dispositions", { runId, ...d, at: Date.now() });
}

async function customerOf(ctx: QueryCtx, runId: string, customerId: string) {
  return await ctx.db
    .query("customers")
    .withIndex("by_run_customer", (q) => q.eq("runId", runId).eq("customerId", customerId))
    .unique();
}

/** Invoice: Dr receivables / Cr revenue and sales tax. A credit memo is the mirror image. */
function receivableLines(kind: "invoice" | "credit_memo", customerId: string, subtotal: number, discount: number, tax: number, total: number) {
  const revenue = subtotal - discount;
  const debitAr = kind === "invoice";
  const dims = { customer: customerId };
  const side = (amount: number, debit: boolean) => ({ debit: debit ? amount : 0, credit: debit ? 0 : amount, dims });
  return [
    { account: "1170", ...side(total, debitAr) },
    ...(revenue > 0 ? [{ account: "4030", ...side(revenue, !debitAr) }] : []),
    ...(tax > 0 ? [{ account: "2300", ...side(tax, !debitAr) }] : []),
  ];
}

async function reverse(ctx: MutationCtx, runId: string, seat: Seat, doc: Doc<"customerDocuments">, date: string, reason: string, key: string, decisionPath?: string) {
  if (!doc.entryId) return { ok: true as const, entryId: undefined };
  const original = await ctx.db.get(doc.entryId);
  if (!original || original.status === "reversed") return { ok: true as const, entryId: undefined };
  const res = await appendEntry(ctx, {
    runId,
    seat,
    date,
    memo: `Reversal of #${original.sequence}: ${reason}`,
    source: { kind: "reversal", ref: String(original.sequence) },
    lines: original.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
    idempotencyKey: key,
    decisionPath,
    reversalOf: original._id,
  });
  if (!res.ok) return res;
  await ctx.db.patch(original._id, { status: "reversed", reversedBy: res.entryId });
  return { ok: true as const, entryId: res.entryId };
}

async function authReceivables(ctx: MutationCtx, args: { runId: string; seatId: string; token: string }, op: string): Promise<{ ok: true; seat: Seat } | Fail> {
  const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
  if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
  if (!auth.seat.caps.receivablesRecord) {
    return await recordViolation(ctx, args.runId, args.seatId, op, fail("forbidden", `${auth.seat.role} may not record receivables`));
  }
  return auth;
}

/** Register a customer from a customer master the company received. An import may add a customer, never rename one. */
export const registerCustomer = mutation({
  args: {
    ...seatArgs,
    idempotencyKey: v.string(),
    customerId: v.string(),
    legalName: v.string(),
    aliases: v.array(v.string()),
    emailDomain: v.optional(v.string()),
    documentEventId: v.string(),
  },
  handler: async (ctx, args) => {
    const op = "receivables.registerCustomer";
    const auth = await authReceivables(ctx, args, op);
    if (!auth.ok) return auth;
    const { token: _t, ...payload } = args;
    const idem = await checkIdempotency(ctx, args.runId, args.idempotencyKey, op, payload);
    if ("conflict" in idem) return await recordViolation(ctx, args.runId, args.seatId, op, idem.conflict);
    if (idem.hit) return { ...(idem.result as { ok: true; created: boolean }), replayed: true };

    const evidence = await receivedDocument(ctx, args.runId, args.documentEventId, MASTER_DOCUMENTS);
    if (!evidence.ok) return await recordViolation(ctx, args.runId, args.seatId, op, evidence);
    const existing = await customerOf(ctx, args.runId, args.customerId);
    if (existing && existing.legalName !== args.legalName) {
      return await recordViolation(ctx, args.runId, args.seatId, op,
        fail("customer_conflict", `${args.customerId} is already registered as ${existing.legalName}`));
    }
    if (!existing) {
      await ctx.db.insert("customers", {
        runId: args.runId, customerId: args.customerId, legalName: args.legalName, aliases: args.aliases,
        emailDomain: args.emailDomain, status: "active", registeredBy: args.seatId, sourceDocumentId: args.documentEventId, at: Date.now(),
      });
      await logActivity(ctx, args.runId, args.seatId, "registered", `Registered customer ${args.customerId} ${args.legalName}`);
    }
    const result = { ok: true as const, created: !existing };
    await storeIdempotency(ctx, args.runId, args.idempotencyKey, op, idem.payloadHash, result);
    return result;
  },
});

/**
 * Record a customer invoice or credit memo. The kernel enforces:
 *  - the header adds up (subtotal - discount + tax = total), in integer cents
 *  - line problems keep the document out of the books until the controller reviews it
 *  - it cites a received customer document, and one document backs one record
 *  - a number is counted once per customer, never after it was voided or replaced by a revision
 *  - a revision takes its original out of the books in the same transaction
 */
export const recordCustomerDocument = mutation({
  args: {
    ...seatArgs,
    idempotencyKey: v.string(),
    kind: v.union(v.literal("invoice"), v.literal("credit_memo")),
    customerId: v.string(),
    displayNumber: v.string(),
    revisionOf: v.optional(v.string()),
    documentDate: v.string(),
    subtotalCents: v.number(),
    discountCents: v.number(),
    taxCents: v.number(),
    totalCents: v.number(),
    lines: v.array(lineArg),
    documentEventId: v.string(),
    decision: v.union(v.literal("record"), v.literal("hold")),
    exceptions: v.array(v.string()),
    decisionPath: v.optional(v.string()),
    memorySha: v.optional(v.string()),
    taskId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const op = "receivables.recordCustomerDocument";
    const auth = await authReceivables(ctx, args, op);
    if (!auth.ok) return auth;
    const { token: _t, ...payload } = args;
    const idem = await checkIdempotency(ctx, args.runId, args.idempotencyKey, op, payload);
    if ("conflict" in idem) return await recordViolation(ctx, args.runId, args.seatId, op, idem.conflict);
    if (idem.hit) return { ...(idem.result as { ok: true; documentId: Id<"customerDocuments">; entryId: Id<"journalEntries"> | null }), replayed: true };
    const violation = (code: string, error: string) => recordViolation(ctx, args.runId, args.seatId, op, fail(code, error));

    const { subtotalCents: sub, discountCents: disc, taxCents: tax, totalCents: total } = args;
    if (![sub, disc, tax, total].every((n) => Number.isSafeInteger(n) && n >= 0)) {
      return await violation("invalid_document", "amounts must be non-negative integer cents (credit memos are recorded as positive amounts)");
    }
    if (total <= 0) return await violation("invalid_document", "total must be positive");
    if (disc > sub) return await violation("invalid_document", `discount ${disc} exceeds subtotal ${sub}`);
    if (sub - disc + tax !== total) return await violation("invalid_document", `subtotal ${sub} - discount ${disc} + tax ${tax} != total ${total}`);
    for (const l of args.lines) {
      if (![l.unitCents, l.amountCents].every(Number.isSafeInteger)) return await violation("invalid_document", "line cents must be integers");
    }
    const issues = lineIssues(args.lines, sub);
    if (issues.length && args.decision === "record") {
      return await violation("policy", `document has arithmetic exceptions (${issues.join("; ")}); hold it for the controller`);
    }
    if (args.decision === "hold" && args.exceptions.length === 0) return await violation("policy", "a held document needs at least one exception");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.documentDate)) return await violation("invalid_document", `bad date ${args.documentDate}`);

    const evidence = await receivedDocument(ctx, args.runId, args.documentEventId, AR_DOCUMENTS);
    if (!evidence.ok) return await recordViolation(ctx, args.runId, args.seatId, op, evidence);
    const customer = await customerOf(ctx, args.runId, args.customerId);
    if (!customer || customer.status !== "active") return await violation("unknown_customer", `${args.customerId} is not an active registered customer`);

    const number = normalizeDocumentNumber(args.displayNumber);
    const revisionOf = args.revisionOf ? normalizeDocumentNumber(args.revisionOf) : undefined;
    if (revisionOf === number) return await violation("invalid_document", "a document cannot revise itself");

    const sameDoc = await ctx.db
      .query("customerDocuments")
      .withIndex("by_run_document", (q) => q.eq("runId", args.runId).eq("documentEventId", args.documentEventId))
      .collect();
    const docLive = sameDoc.find((d) => d.status !== "rejected");
    if (docLive) return await violation("document_already_recorded", `document ${args.documentEventId} already backs ${docLive.displayNumber} (${docLive.status})`);

    const sameNumber = await ctx.db
      .query("customerDocuments")
      .withIndex("by_run_customer_number", (q) => q.eq("runId", args.runId).eq("customerId", args.customerId).eq("number", number))
      .collect();
    const live = sameNumber.find((d) => LIVE.has(d.status));
    if (live) return await violation("duplicate_document", `${args.displayNumber} for ${args.customerId} is already recorded (${live.status}) from another document`);
    if (sameNumber.some((d) => d.status === "void")) return await violation("number_voided", `${args.displayNumber} was voided; it cannot be counted`);
    if (sameNumber.some((d) => d.status === "superseded")) return await violation("number_superseded", `${args.displayNumber} was replaced by a revision`);
    const revisions = await ctx.db
      .query("customerDocuments")
      .withIndex("by_run_customer_revision", (q) => q.eq("runId", args.runId).eq("customerId", args.customerId).eq("revisionOf", number))
      .collect();
    const revisedBy = revisions.find((d) => LIVE.has(d.status));
    if (revisedBy) return await violation("superseded_by_revision", `${args.displayNumber} was replaced by ${revisedBy.displayNumber}`);

    const status = args.decision === "record" ? "open" : "held";
    const documentId = await ctx.db.insert("customerDocuments", {
      runId: args.runId,
      customerId: args.customerId,
      kind: args.kind,
      number,
      displayNumber: args.displayNumber,
      revisionOf,
      documentDate: args.documentDate,
      subtotalCents: sub,
      discountCents: disc,
      taxCents: tax,
      totalCents: total,
      documentEventId: args.documentEventId,
      status,
      exceptions: [...args.exceptions, ...issues.filter((i) => !args.exceptions.includes(i))],
      decisionPath: args.decisionPath,
      createdBy: args.seatId,
    });
    let entryId: Id<"journalEntries"> | null = null;
    if (status === "open") {
      const posted = await appendEntry(ctx, {
        runId: args.runId,
        seat: auth.seat,
        date: args.documentDate,
        memo: `${args.kind === "invoice" ? "Invoice" : "Credit memo"} ${args.displayNumber} to ${args.customerId}`,
        source: { kind: "receivable", ref: documentId },
        lines: receivableLines(args.kind, args.customerId, sub, disc, tax, total),
        idempotencyKey: `${args.idempotencyKey}:entry`,
        taskId: args.taskId,
        decisionPath: args.decisionPath,
        memorySha: args.memorySha,
      });
      if (!posted.ok) {
        // A returned failure commits the transaction; the provisional record must not outlive it.
        await ctx.db.delete(documentId);
        return await recordViolation(ctx, args.runId, args.seatId, op, posted);
      }
      entryId = posted.entryId;
      await ctx.db.patch(documentId, { entryId });
    }

    // A revision replaces its original: take the original out of the books.
    if (revisionOf) {
      const originals = await ctx.db
        .query("customerDocuments")
        .withIndex("by_run_customer_number", (q) => q.eq("runId", args.runId).eq("customerId", args.customerId).eq("number", revisionOf))
        .collect();
      for (const o of originals.filter((d) => LIVE.has(d.status))) {
        const rev = await reverse(ctx, args.runId, auth.seat, o, args.documentDate, `replaced by ${args.displayNumber}`, `${args.idempotencyKey}:supersede:${o._id}`, args.decisionPath);
        if (!rev.ok) return await recordViolation(ctx, args.runId, args.seatId, op, rev);
        await ctx.db.patch(o._id, { status: "superseded", supersededBy: number, reversalEntryId: rev.entryId });
        await setDisposition(ctx, args.runId, {
          documentEventId: o.documentEventId, path: await pathOf(ctx, o.documentEventId), documentNumber: o.displayNumber, customerId: o.customerId,
          category: "superseded_original", treatment: "excluded_from_spend", reason: `replaced by revision ${args.displayNumber}`, by: args.seatId, decisionPath: args.decisionPath,
        });
      }
    }

    await setDisposition(ctx, args.runId, {
      documentEventId: args.documentEventId,
      path: await pathOf(ctx, args.documentEventId),
      documentNumber: args.displayNumber,
      customerId: args.customerId,
      category: status === "held" ? "data_quality" : args.kind === "invoice" ? "counted" : "credit_memo",
      treatment: status === "held" ? "held" : args.kind === "invoice" ? "counted" : "subtracted_as_credit",
      reason: status === "held" ? `held for the controller: ${args.exceptions.join("; ")}` : args.kind === "invoice" ? "valid invoice" : "credit memo subtracted from net spend",
      by: args.seatId,
      decisionPath: args.decisionPath,
    });
    await logActivity(ctx, args.runId, args.seatId, status === "open" ? "recorded" : "held",
      `${status === "open" ? "Recorded" : "Held"} ${args.kind.replace("_", " ")} ${args.displayNumber} for ${args.customerId} (${(total / 100).toFixed(2)})`, { documentId });
    const result = { ok: true as const, documentId, entryId };
    await storeIdempotency(ctx, args.runId, args.idempotencyKey, op, idem.payloadHash, result);
    return result;
  },
});

/**
 * Void an invoice number on the strength of a received copy marked void. A live record with that
 * number is reversed; either way the number is blocked from being counted later.
 */
export const voidCustomerDocument = mutation({
  args: {
    ...seatArgs,
    idempotencyKey: v.string(),
    customerId: v.string(),
    displayNumber: v.string(),
    documentDate: v.string(),
    subtotalCents: v.number(),
    discountCents: v.number(),
    taxCents: v.number(),
    totalCents: v.number(),
    documentEventId: v.string(),
    reason: v.string(),
    decisionPath: v.optional(v.string()),
    memorySha: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const op = "receivables.voidCustomerDocument";
    const auth = await authReceivables(ctx, args, op);
    if (!auth.ok) return auth;
    const { token: _t, ...payload } = args;
    const idem = await checkIdempotency(ctx, args.runId, args.idempotencyKey, op, payload);
    if ("conflict" in idem) return await recordViolation(ctx, args.runId, args.seatId, op, idem.conflict);
    if (idem.hit) return { ...(idem.result as { ok: true; reversed: number }), replayed: true };

    // Evidence must be a customer document (a copy marked void). An email alone can't void revenue.
    const evidence = await receivedDocument(ctx, args.runId, args.documentEventId, AR_DOCUMENTS);
    if (!evidence.ok) return await recordViolation(ctx, args.runId, args.seatId, op, evidence);
    if (!(await customerOf(ctx, args.runId, args.customerId))) {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("unknown_customer", `${args.customerId} is not a registered customer`));
    }
    const sameDoc = await ctx.db
      .query("customerDocuments")
      .withIndex("by_run_document", (q) => q.eq("runId", args.runId).eq("documentEventId", args.documentEventId))
      .collect();
    if (sameDoc.some((d) => d.status !== "rejected")) {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("document_already_recorded", `document ${args.documentEventId} is already recorded`));
    }
    const number = normalizeDocumentNumber(args.displayNumber);
    const live = (await ctx.db
      .query("customerDocuments")
      .withIndex("by_run_customer_number", (q) => q.eq("runId", args.runId).eq("customerId", args.customerId).eq("number", number))
      .collect()).filter((d) => LIVE.has(d.status));
    for (const o of live) {
      const rev = await reverse(ctx, args.runId, auth.seat, o, args.documentDate, `voided: ${args.reason}`, `${args.idempotencyKey}:void:${o._id}`, args.decisionPath);
      if (!rev.ok) return await recordViolation(ctx, args.runId, args.seatId, op, rev);
      await ctx.db.patch(o._id, { status: "void", reversalEntryId: rev.entryId });
      await setDisposition(ctx, args.runId, {
        documentEventId: o.documentEventId, path: await pathOf(ctx, o.documentEventId), documentNumber: o.displayNumber, customerId: o.customerId,
        category: "void", treatment: "excluded_from_spend", reason: `voided: ${args.reason}`, by: args.seatId, decisionPath: args.decisionPath,
      });
    }
    await ctx.db.insert("customerDocuments", {
      runId: args.runId, customerId: args.customerId, kind: "invoice", number, displayNumber: args.displayNumber,
      documentDate: args.documentDate, subtotalCents: args.subtotalCents, discountCents: args.discountCents, taxCents: args.taxCents,
      totalCents: args.totalCents, documentEventId: args.documentEventId, status: "void", exceptions: [], decisionPath: args.decisionPath, createdBy: args.seatId,
    });
    await setDisposition(ctx, args.runId, {
      documentEventId: args.documentEventId, path: await pathOf(ctx, args.documentEventId), documentNumber: args.displayNumber, customerId: args.customerId,
      category: "void", treatment: "excluded_from_spend", reason: args.reason, by: args.seatId, decisionPath: args.decisionPath,
    });
    await logActivity(ctx, args.runId, args.seatId, "voided", `Voided ${args.displayNumber} for ${args.customerId}${live.length ? ` (reversed ${live.length} record)` : ""}: ${args.reason}`);
    const result = { ok: true as const, reversed: live.length };
    await storeIdempotency(ctx, args.runId, args.idempotencyKey, op, idem.payloadHash, result);
    return result;
  },
});

/** Controller resolves a held customer document. The seat that recorded it cannot. */
export const resolveHeldCustomerDocument = mutation({
  args: {
    ...seatArgs,
    idempotencyKey: v.string(),
    documentId: v.id("customerDocuments"),
    decision: v.union(v.literal("approve"), v.literal("reject")),
    note: v.string(),
    decisionPath: v.optional(v.string()),
    memorySha: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const op = "receivables.resolveHeld";
    const auth = await authReceivables(ctx, args, op);
    if (!auth.ok) return auth;
    if (auth.seat.role !== "controller") return await recordViolation(ctx, args.runId, args.seatId, op, fail("forbidden", "only the controller resolves held receivables"));
    const { token: _t, ...payload } = args;
    const idem = await checkIdempotency(ctx, args.runId, args.idempotencyKey, op, payload);
    if ("conflict" in idem) return await recordViolation(ctx, args.runId, args.seatId, op, idem.conflict);
    if (idem.hit) return { ...(idem.result as { ok: true; entryId: Id<"journalEntries"> | null }), replayed: true };

    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.runId !== args.runId) return fail("not_found", "document not found");
    if (doc.status !== "held") return fail("bad_state", `document is ${doc.status}, not held`);
    if (doc.createdBy === args.seatId) return await recordViolation(ctx, args.runId, args.seatId, op, fail("sod", "the seat that recorded a document cannot resolve it"));
    let entryId: Id<"journalEntries"> | null = null;
    if (args.decision === "approve") {
      const posted = await appendEntry(ctx, {
        runId: args.runId,
        seat: auth.seat,
        date: doc.documentDate,
        memo: `${doc.kind === "invoice" ? "Invoice" : "Credit memo"} ${doc.displayNumber} to ${doc.customerId} (approved by controller)`,
        source: { kind: "receivable", ref: doc._id },
        lines: receivableLines(doc.kind, doc.customerId, doc.subtotalCents, doc.discountCents, doc.taxCents, doc.totalCents),
        idempotencyKey: `${args.idempotencyKey}:entry`,
        decisionPath: args.decisionPath,
        memorySha: args.memorySha,
      });
      if (!posted.ok) return await recordViolation(ctx, args.runId, args.seatId, op, posted);
      entryId = posted.entryId;
      await ctx.db.patch(doc._id, { status: "open", entryId, decisionPath: args.decisionPath ?? doc.decisionPath });
    } else {
      await ctx.db.patch(doc._id, { status: "rejected", decisionPath: args.decisionPath ?? doc.decisionPath });
    }
    await setDisposition(ctx, args.runId, {
      documentEventId: doc.documentEventId, path: await pathOf(ctx, doc.documentEventId), documentNumber: doc.displayNumber, customerId: doc.customerId,
      category: args.decision === "approve" ? (doc.kind === "invoice" ? "data_quality" : "credit_memo") : "data_quality",
      treatment: args.decision === "approve" ? (doc.kind === "invoice" ? "counted_with_flag" : "subtracted_as_credit") : "excluded_from_spend",
      reason: `${args.note}${doc.exceptions.length ? ` (${doc.exceptions.join("; ")})` : ""}`,
      by: args.seatId,
      decisionPath: args.decisionPath,
    });
    await logActivity(ctx, args.runId, args.seatId, args.decision === "approve" ? "approved" : "rejected",
      `${args.decision === "approve" ? "Approved" : "Rejected"} held ${doc.displayNumber} for ${doc.customerId}: ${args.note}`, { documentId: doc._id });
    const result = { ok: true as const, entryId };
    await storeIdempotency(ctx, args.runId, args.idempotencyKey, op, idem.payloadHash, result);
    return result;
  },
});

/**
 * Disposition for a document that is not a receivable (statements, emails, bank exports,
 * duplicates, reference files). It can only exclude or hold: counting goes through
 * recordCustomerDocument, and a recorded document can't be excluded by a label.
 */
export const recordDisposition = mutation({
  args: {
    ...seatArgs,
    idempotencyKey: v.string(),
    documentEventId: v.string(),
    category: v.string(),
    treatment: v.union(v.literal("excluded_from_spend"), v.literal("held"), v.literal("unreadable")),
    reason: v.string(),
    documentNumber: v.optional(v.string()),
    customerId: v.optional(v.string()),
    decisionPath: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const op = "receivables.recordDisposition";
    const auth = await authReceivables(ctx, args, op);
    if (!auth.ok) return auth;
    const { token: _t, ...payload } = args;
    const idem = await checkIdempotency(ctx, args.runId, args.idempotencyKey, op, payload);
    if ("conflict" in idem) return await recordViolation(ctx, args.runId, args.seatId, op, idem.conflict);
    if (idem.hit) return { ...(idem.result as { ok: true }), replayed: true };

    const evidence = await receivedDocument(ctx, args.runId, args.documentEventId);
    if (!evidence.ok) return await recordViolation(ctx, args.runId, args.seatId, op, evidence);
    const records = await ctx.db
      .query("customerDocuments")
      .withIndex("by_run_document", (q) => q.eq("runId", args.runId).eq("documentEventId", args.documentEventId))
      .collect();
    if (records.some((d) => LIVE.has(d.status))) {
      return await recordViolation(ctx, args.runId, args.seatId, op,
        fail("document_is_recorded", `document ${args.documentEventId} backs a recorded ${records[0]!.displayNumber}; void or replace it instead`));
    }
    await setDisposition(ctx, args.runId, {
      documentEventId: args.documentEventId, path: await pathOf(ctx, args.documentEventId), documentNumber: args.documentNumber, customerId: args.customerId,
      category: args.category, treatment: args.treatment, reason: args.reason, by: args.seatId, decisionPath: args.decisionPath,
    });
    const result = { ok: true as const };
    await storeIdempotency(ctx, args.runId, args.idempotencyKey, op, idem.payloadHash, result);
    return result;
  },
});

export const customers = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.query("customers").withIndex("by_run_customer", (q) => q.eq("runId", args.runId)).collect();
  },
});

export const documents = query({
  args: { runId: v.string(), customerId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("customerDocuments")
      .withIndex("by_run_customer_number", (q) => (args.customerId ? q.eq("runId", args.runId).eq("customerId", args.customerId) : q.eq("runId", args.runId)))
      .collect();
  },
});

export const document = query({
  args: { runId: v.string(), documentId: v.id("customerDocuments") },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.documentId);
    return d && d.runId === args.runId ? d : null;
  },
});

export const dispositionFor = query({
  args: { runId: v.string(), documentEventId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("dispositions")
      .withIndex("by_run_document", (q) => q.eq("runId", args.runId).eq("documentEventId", args.documentEventId))
      .unique();
  },
});

export const dispositions = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.query("dispositions").withIndex("by_run_document", (q) => q.eq("runId", args.runId)).collect();
  },
});

/** Per-customer totals straight from the kernel's records: only open documents count. */
export const customerTotals = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("customers").withIndex("by_run_customer", (q) => q.eq("runId", args.runId)).collect();
    const docs = await ctx.db.query("customerDocuments").withIndex("by_run_customer_number", (q) => q.eq("runId", args.runId)).collect();
    return all.map((c) => {
      const open = docs.filter((d) => d.customerId === c.customerId && d.status === "open");
      const invoices = open.filter((d) => d.kind === "invoice");
      const grossCents = invoices.reduce((s, d) => s + d.totalCents, 0);
      const creditCents = open.filter((d) => d.kind === "credit_memo").reduce((s, d) => s + d.totalCents, 0);
      return { customerId: c.customerId, legalName: c.legalName, validInvoiceCount: invoices.length, grossCents, creditCents, netCents: grossCents - creditCents };
    });
  },
});

/** Documents received with no disposition yet: the close must not run while this is non-empty. */
export const undisposed = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const run = await getRun(ctx, args.runId);
    if (!run) return [];
    const docs = await ctx.db.query("events").withIndex("by_run_type", (q) => q.eq("runId", args.runId).eq("type", "document.received")).collect();
    const disposed = new Set((await ctx.db.query("dispositions").withIndex("by_run_document", (q) => q.eq("runId", args.runId)).collect()).map((d) => d.documentEventId));
    const arKinds = new Set(["customer_master", "ar_document", "ar_email", "bank_export", "reference"]);
    return docs
      .filter((e) => arKinds.has(String((e.payload as { kind?: string }).kind)) && !disposed.has(e._id))
      .map((e) => ({ eventId: e._id, path: String((e.payload as { path?: string }).path ?? e.externalId), kind: String((e.payload as { kind?: string }).kind) }));
  },
});
