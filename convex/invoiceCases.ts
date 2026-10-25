import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { authSeat, checkIdempotency, fail, getRun, storeIdempotency, type Fail } from "./lib/kernel";
import { extractTextDocument, type CustomerIdentity } from "../src/invoice-mvp/text-extraction";
import { evidenceValidator, modeValidator, invoiceSourceValidator as sourceValidator, conclusionValidator, toolCallValidator } from "./schema";
import type { BackendResult, CaseDetail, CaseStatus, CaseSummary, Conclusion, Contribution, DecisionResult, EvidenceRef, IngestBatchResult, ModelBudget, ModelReservationResult, Proposal, SeatAuth, SourceInput, SourceVersion, SubmitProposalResult, WorkspaceSnapshot } from "../src/invoice-mvp/contracts";

/** "INV-2025-1013", "inv 2025 1013" and "INV20251013" are the same document number. */
export function normalizeDocumentNumber(n: string): string {
  return n.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export const seatArgs = { runId: v.string(), seatId: v.string(), token: v.string() };
const ok = <T>(value: T): BackendResult<T> => ({ ok: true, value });
const terminal = new Set<CaseStatus>(["recorded", "excluded", "superseded", "duplicate"]);
type Case = Doc<"invoiceCaseRecords">;
type Source = Doc<"invoiceSources">;

/** Existing seats establish run membership. Role AND kind are checked; callers cannot select authority. */
async function authorize(ctx: QueryCtx, args: SeatAuth, operation: "read" | "human" | "investigate" | "register") {
  const a = await authSeat(ctx, args.runId, args.seatId, args.token);
  if (!a.ok) return a;
  const human = a.seat.role === "human_cfo" && a.seat.kind === "human";
  const investigator = ["invoice_investigator", "controller"].includes(a.seat.role) && a.seat.kind === "agent";
  const reader = human || investigator || a.seat.role === "auditor";
  if (!(operation === "read" ? reader : operation === "human" ? human : operation === "investigate" ? investigator : human || investigator)) return fail("forbidden", `Seat may not perform invoice ${operation} operations`);
  const run = await getRun(ctx, args.runId);
  if (!run) return fail("not_found", "Workspace does not exist");
  if (operation !== "read" && run.status !== "active") return fail("workspace_closed", "Workspace is no longer active");
  return { ok: true as const, seat: a.seat, run, human };
}
async function caseOf(ctx: QueryCtx, runId: string, id: string) {
  const normalized = ctx.db.normalizeId("invoiceCaseRecords", id);
  const row = normalized ? await ctx.db.get(normalized) : null;
  return row?.runId === runId ? row : null;
}
async function sourceOf(ctx: QueryCtx, runId: string, id: string) {
  const normalized = ctx.db.normalizeId("invoiceSources", id);
  const row = normalized ? await ctx.db.get(normalized) : null;
  return row?.runId === runId ? row : null;
}
const summarize = (c: Case): CaseSummary => {
  const { _id, _creationTime: _t, runId: _r, ...rest } = c;
  return { ...rest, caseId: _id };
};
const sourceView = (s: Source): SourceVersion => {
  const { _id, _creationTime: _t, runId: _r, ...rest } = s;
  return { ...rest, documentId: _id };
};
const proposalView = (p: Doc<"invoiceProposals">): Proposal => {
  const { _id, _creationTime: _t, runId: _r, ...rest } = p;
  return { ...rest, proposalId: _id };
};
const contributionView = (p: Doc<"invoiceContributions">): Contribution => {
  const { _id, _creationTime: _t, runId: _r, normalizedNumber: _n, ...rest } = p;
  return { ...rest, contributionId: _id };
};
async function audit(ctx: MutationCtx, auth: SeatAuth, caseId: string, kind: string, summary: string, extra: Partial<Pick<Doc<"invoiceAudit">, "proposalId" | "evidenceVersion" | "toolCall">> = {}) {
  return await ctx.db.insert("invoiceAudit", { runId: auth.runId, caseId, kind, summary, actor: auth.seatId, at: Date.now(), ...extra });
}
async function transition(ctx: MutationCtx, auth: SeatAuth, c: Case, status: CaseStatus, summary: string, patch: Partial<Omit<Case, "_id" | "_creationTime" | "runId">> = {}) {
  // Evidence invalidation is a separately audited event, not an unrecorded status reset.
  const allowed: Record<CaseStatus, CaseStatus[]> = {
    received: ["investigating", "superseded"], investigating: ["needs_review", "evidence_missing", "recorded", "excluded", "superseded"],
    needs_review: ["recorded", "excluded", "evidence_missing", "superseded"], evidence_missing: ["investigating", "excluded", "superseded"],
    recorded: ["superseded"], excluded: ["superseded"], superseded: [], duplicate: ["superseded"],
  };
  if (c.status !== status && !allowed[c.status].includes(status)) throw new Error(`Invalid invoice transition ${c.status} -> ${status}`);
  await ctx.db.patch(c._id, { ...patch, status, updatedAt: Date.now() });
  await audit(ctx, auth, c._id, "transition", `${c.status} → ${status}: ${summary}`, { evidenceVersion: patch.evidenceVersion ?? c.evidenceVersion });
  return (await ctx.db.get(c._id))!;
}
async function replay<T>(ctx: MutationCtx, args: SeatAuth & { idempotencyKey: string }, scope: string, payload: unknown) {
  if (!args.idempotencyKey.trim()) return { error: fail("invalid", "Idempotency key is required") } as const;
  const result = await checkIdempotency(ctx, args.runId, `invoice:${args.idempotencyKey}`, scope, payload);
  if ("conflict" in result) return { error: result.conflict } as const;
  if (result.hit) return { result: { ...(result.result as BackendResult<T>), replayed: true } as BackendResult<T> } as const;
  return { hash: result.payloadHash } as const;
}
async function remember<T>(ctx: MutationCtx, args: SeatAuth & { idempotencyKey: string }, scope: string, hash: string, value: T) {
  const result = ok(value);
  await storeIdempotency(ctx, args.runId, `invoice:${args.idempotencyKey}`, scope, hash, result);
  return result;
}
const withoutToken = <T extends SeatAuth>(args: T) => { const { token: _t, ...payload } = args; return payload; };
async function validateEvidence(ctx: QueryCtx, runId: string, refs: EvidenceRef[], current = true): Promise<Fail | null> {
  for (const ref of refs) {
    const source = await sourceOf(ctx, runId, ref.documentId);
    if (!source || source.version !== ref.version || source.contentHash !== ref.contentHash) return fail("invalid_evidence", "Evidence must identify an exact source version in this workspace");
    if (ref.quote !== undefined && (!ref.quote.trim() || !source.text.includes(ref.quote))) return fail("invalid_evidence", "Evidence quote is not present verbatim in the original source");
    const c = await caseOf(ctx, runId, source.caseId);
    if (current && c?.status === "superseded") return fail("stale_evidence", "Evidence source has been superseded");
  }
  return null;
}
async function contentHash(input: SourceInput) {
  const bytes = input.contentBase64 === undefined ? new TextEncoder().encode(input.text) : Uint8Array.from(atob(input.contentBase64), (c) => c.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function allCases(ctx: QueryCtx, runId: string) {
  return await ctx.db.query("invoiceCaseRecords").withIndex("by_run", (q) => q.eq("runId", runId)).collect();
}
async function deactivate(ctx: MutationCtx, runId: string, documentId: string) {
  const rows = await ctx.db.query("invoiceContributions").withIndex("by_run_document", (q) => q.eq("runId", runId).eq("documentId", documentId)).collect();
  for (const row of rows) if (row.active) await ctx.db.patch(row._id, { active: false });
}

export const ingestBatch = mutation({
  args: { ...seatArgs, label: v.string(), documents: v.array(sourceValidator), idempotencyKey: v.string() },
  handler: async (ctx, args): Promise<BackendResult<IngestBatchResult>> => {
    const auth = await authorize(ctx, args, "human"); if (!auth.ok) return auth;
    const idem = await replay<IngestBatchResult>(ctx, args, "ingest", withoutToken(args));
    if (idem.error) return idem.error; if (idem.result) return idem.result;
    if (!args.label.trim() || !args.documents.length || args.documents.length > 100) return fail("invalid", "Provide a label and 1–100 documents");
    if (new Set(args.documents.map((d) => d.externalId)).size !== args.documents.length) return fail("invalid", "Each external ID must appear only once in a batch");
    if (new TextEncoder().encode(JSON.stringify(args.documents)).length > 10_000_000) return fail("invalid", "Batch exceeds the 10 MB transaction limit; import smaller batches");
    const sources = await ctx.db.query("invoiceSources").withIndex("by_run", (q) => q.eq("runId", args.runId)).collect();
    const cases = await allCases(ctx, args.runId);
    const byId = new Map(cases.map((c) => [c._id as string, c]));
    const replacements = args.documents.map((d) => d.replacesExternalId).filter((id) => id !== undefined);
    if (new Set(replacements).size !== replacements.length) return fail("invalid_replacement", "A batch cannot replace the same source twice");
    const prepared: { input: SourceInput; hash: string; prior?: Source; replace?: Source; same?: Source }[] = [];
    for (const input of args.documents) {
      if (!input.externalId.trim() || !input.name.trim() || !input.mimeType.trim() || (!input.text.trim() && !input.contentBase64)) return fail("invalid", "Sources require identity, name, MIME type, and text or original bytes");
      if (input.contentBase64 !== undefined && (!input.contentBase64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.contentBase64))) return fail("invalid", "Original bytes must be valid padded base64");
      if (new TextEncoder().encode(input.text).length > 750_000) return fail("invalid", "Extracted source text exceeds 750 KB; split this document with explicit provenance");
      const hash = await contentHash(input);
      const prior = sources.filter((s) => s.externalId === input.externalId).sort((a, b) => b.version - a.version)[0];
      // An old import retry must never roll back the latest version. Match all history.
      const same = sources.find((s) => s.externalId === input.externalId && s.contentHash === hash && s.text === input.text && s.replacesExternalId === input.replacesExternalId);
      if (prior?.contentHash === hash && (prior.text !== input.text || prior.replacesExternalId !== input.replacesExternalId)) return fail("source_conflict", "The same original bytes cannot acquire different extracted text or replacement metadata");
      // A reused ID is a new version only when the importer says so. File names are not identities.
      if (prior && !same && !input.newVersion) return fail("external_id_conflict", `External ID ${input.externalId} already names a different source; give this document its own ID, or set newVersion to import it as a new version`);
      if (input.newVersion && !prior) return fail("invalid_version", `newVersion needs an existing external ID; ${input.externalId} is new`);
      if (input.newVersion && input.replacesExternalId) return fail("invalid_replacement", "A document is either a new version of its own ID or a replacement of another, not both");
      let replace: Source | undefined;
      if (input.replacesExternalId) {
        replace = sources.filter((s) => s.externalId === input.replacesExternalId).sort((a, b) => b.version - a.version)[0];
        if (!replace || input.replacesExternalId === input.externalId) return fail("invalid_replacement", "Replacement must name an existing different external ID; for a new version of the same ID set newVersion");
        if (!same && byId.get(replace.caseId)?.status === "superseded") return fail("stale_replacement", "Replacement target is already superseded");
        if (!same && replace.contentHash === hash) return fail("invalid_replacement", "Identical bytes are a duplicate, not a replacement; omit replacesExternalId");
        if (args.documents.some((d) => d.externalId === input.replacesExternalId)) return fail("invalid_replacement", "Import replacement and target changes in separate batches");
      }
      prepared.push({ input, hash, prior, replace, same });
    }
    // No writes before input validation, so a rejected batch cannot partially import.
    const batchId = await ctx.db.insert("invoiceBatches", { runId: args.runId, label: args.label, documentIds: [], createdAt: Date.now() });
    const documentIds: string[] = [], caseIds: string[] = [];
    const newCaseIds = new Set<string>();
    for (const p of prepared) {
      if (p.same) { documentIds.push(p.same._id); caseIds.push(p.same.caseId); continue; }
      let replacesDocumentId: string | undefined;
      for (const old of [p.prior, p.replace]) {
        const oldCase = old && await caseOf(ctx, args.runId, old.caseId);
        if (!oldCase || oldCase.status === "superseded") continue;
        // A recorded case counts toward customer totals: only a human-accepted proposal on the new
        // case may supersede it (see submitProposal). Pending work is superseded at once.
        if (oldCase.status === "recorded") { replacesDocumentId = oldCase.documentId; continue; }
        await deactivate(ctx, args.runId, oldCase.documentId);
        await transition(ctx, args, oldCase, "superseded", `Explicit importer version/replacement by ${p.input.externalId}`, { evidenceVersion: oldCase.evidenceVersion + 1, currentProposalId: undefined });
      }
      const canonical = sources.find((s) => s.contentHash === p.hash);
      const version = (p.prior?.version ?? 0) + 1;
      const now = Date.now();
      const caseId = await ctx.db.insert("invoiceCaseRecords", {
        runId: args.runId, batchId, documentId: "", externalId: p.input.externalId, name: p.input.name, version, contentHash: p.hash,
        status: canonical ? "duplicate" : "received", evidenceVersion: 1,
        ...(canonical ? { canonicalDocumentId: canonical.canonicalDocumentId ?? canonical._id, reason: "Identical source bytes already received" } : {}),
        ...(replacesDocumentId ? { replacesDocumentId } : {}),
        contradictions: [], missingEvidence: [], createdAt: now, updatedAt: now,
      });
      const { contentBase64: originalBytes, newVersion: _newVersion, ...sourceInput } = p.input;
      const documentId = await ctx.db.insert("invoiceSources", {
        runId: args.runId, ...sourceInput, caseId, batchId, version, contentHash: p.hash, createdAt: now,
        ...(canonical ? { canonicalDocumentId: canonical.canonicalDocumentId ?? canonical._id } : {}),
      });
      if (originalBytes !== undefined) {
        for (let offset = 0; offset < originalBytes.length; offset += 128_000) await ctx.db.insert("invoiceSourceChunks", { runId: args.runId, documentId, index: offset / 128_000, content: originalBytes.slice(offset, offset + 128_000) });
      }
      await ctx.db.patch(caseId, { documentId });
      await audit(ctx, args, caseId, "ingested", canonical ? `Duplicate of ${canonical.canonicalDocumentId ?? canonical._id}` : `Received immutable source version ${version}${replacesDocumentId ? `; replaces recorded source ${replacesDocumentId} only if a human accepts` : ""}`, { evidenceVersion: 1 });
      sources.push((await ctx.db.get(documentId))!);
      documentIds.push(documentId); caseIds.push(caseId); newCaseIds.add(caseId);
    }
    if (newCaseIds.size) {
      // Conservative pending-only invalidation. Accepted work changes only via explicit replacement.
      for (const c of await allCases(ctx, args.runId)) {
        if (newCaseIds.has(c._id) || terminal.has(c.status)) continue;
        const evidenceVersion = c.evidenceVersion + 1;
        let current = c;
        if (c.status === "needs_review") current = await transition(ctx, args, c, "evidence_missing", "Proposal invalidated by new workspace evidence", { currentProposalId: undefined });
        if (current.status === "evidence_missing") current = await transition(ctx, args, current, "investigating", "New evidence resumes investigation");
        await ctx.db.patch(c._id, { evidenceVersion, currentProposalId: undefined, updatedAt: Date.now() });
        await audit(ctx, args, c._id, "evidence_changed", "New source invalidates prior pending proposal; history retained", { evidenceVersion });
      }
    }
    await ctx.db.patch(batchId, { documentIds });
    return await remember(ctx, args, "ingest", idem.hash!, { batchId, caseIds, documentIds });
  },
});

export const beginInvestigation = mutation({
  args: { ...seatArgs, caseId: v.string() },
  handler: async (ctx, args): Promise<BackendResult<CaseSummary>> => {
    const auth = await authorize(ctx, args, "investigate"); if (!auth.ok) return auth;
    const c = await caseOf(ctx, args.runId, args.caseId); if (!c) return fail("not_found", "Case not found");
    if (c.status === "investigating") return ok(summarize(c)); // Crash recovery: no permanent lease.
    if (c.status !== "received") return fail("invalid_transition", "Case is not pending investigation");
    return ok(summarize(await transition(ctx, args, c, "investigating", "Investigator started")));
  },
});

/** Routine auto-accept is a deliberately narrow printed-document grammar, checked server-side. */
function routineMatches(source: Source, conclusion: Conclusion): boolean {
  if (!conclusion.treatment.startsWith("include_")) return false;
  const lines = source.text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const title = lines[0]?.toUpperCase();
  if (title !== (conclusion.treatment === "include_invoice" ? "INVOICE" : "CREDIT MEMO")) return false;
  const one = (pattern: RegExp) => { const matches = lines.map((l) => l.match(pattern)).filter((m) => m !== null); return matches.length === 1 ? matches[0]![1]!.trim() : undefined; };
  const allowed = /^(?:INVOICE|CREDIT MEMO|Customer ID:\s*.+|Customer:\s*.+|(?:Invoice Number|Credit Memo Number|Document Number):\s*.+|Amount Cents:\s*\d+|Total:\s*USD\s+[\d,]+\.\d{2}|Currency:\s*USD|Status:\s*(?:issued|final|open|paid|partial))$/i;
  if (lines.some((line) => !allowed.test(line))) return false;
  if (lines.filter((line) => /^(?:Invoice Number|Credit Memo Number|Document Number):/i.test(line)).length !== 1) return false;
  const customer = one(/^Customer ID:\s*(.+)$/i);
  const number = one(/^(?:Invoice Number|Credit Memo Number|Document Number):\s*(.+)$/i);
  const cents = one(/^Amount Cents:\s*(\d+)$/i);
  const total = one(/^Total:\s*USD\s+([\d,]+\.\d{2})$/i);
  const amount = cents !== undefined ? Number(cents) : total !== undefined ? Number(total.replace(/[,\.]/g, "")) : NaN;
  if (cents !== undefined && total !== undefined && Number(cents) !== Number(total.replace(/[,\.]/g, ""))) return false;
  // Compare parsed values instead of a whitespace-backtracking negative lookahead.
  const currencies = lines.filter((line) => /^Currency:/i.test(line));
  if (currencies.length > 1 || currencies.some((line) => line.split(":")[1]?.trim().toUpperCase() !== "USD")) return false;
  if (lines.filter((line) => /^Status:/i.test(line)).length > 1) return false;
  return customer === conclusion.customerId && number === conclusion.documentNumber && amount === conclusion.amountCents;
}
function supportingOnly(source: Source): boolean {
  const head = source.text.trim().split(/\r?\n/).slice(0, 5).join("\n");
  return /(?:message\/rfc822|email)/i.test(source.mimeType) || /\.(?:eml|msg)$/i.test(source.name) || /^(?:from|subject):/im.test(head) || /\b(?:bank (?:statement|export|deposit)|account statement|statement of account|customer statement)\b/i.test(head);
}
function containsToken(text: string, value: string) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(text);
}
function sourceSupports(source: Source, conclusion: Conclusion, customer: Doc<"customers">, customers: readonly CustomerIdentity[]): boolean {
  if (["text/plain", "application/pdf"].includes(source.mimeType)) {
    const extracted = extractTextDocument(source, { documentId: source._id, version: source.version, contentHash: source.contentHash }, customers)?.conclusion;
    // For recognized layouts validate the actual fields, not mere occurrence of an amount
    // somewhere in the packet. This also blocks choosing a subtotal or resolving a conflict by omission.
    if (extracted) return extracted.treatment === conclusion.treatment && !extracted.missingEvidence.length
      && extracted.customerId === conclusion.customerId && extracted.documentNumber === conclusion.documentNumber && extracted.amountCents === conclusion.amountCents;
  }
  const text = source.text;
  const head = text.trim().split(/\r?\n/).slice(0, 5).join("\n");
  const title = conclusion.treatment === "include_invoice" ? /\binvoice\b/i : /\bcredit (?:memo|note)\b/i;
  const amount = conclusion.amountCents!;
  const decimal = (amount / 100).toFixed(2);
  const amountPattern = new RegExp(`(?:^|[^\\d])${decimal.replace(".", "\\.")}(?!\\d)`);
  const centsPattern = new RegExp(`(?:Amount Cents|amountCents)["\\s:]+${amount}(?!\\d)`, "i");
  const customerMatches = [customer.customerId, customer.legalName, ...customer.aliases].some((n) => n.trim() && containsToken(text, n));
  return title.test(head) && customerMatches && containsToken(text, conclusion.documentNumber!) && (amountPattern.test(text.replace(/,/g, "")) || centsPattern.test(text));
}
async function validateConclusion(ctx: QueryCtx, runId: string, c: Case, conclusion: Conclusion): Promise<Fail | null> {
  if (!conclusion.reason.trim()) return fail("invalid", "Conclusion requires a concise reason");
  const badEvidence = await validateEvidence(ctx, runId, conclusion.evidence); if (badEvidence) return badEvidence;
  if (!conclusion.evidence.some((ref) => ref.documentId === c.documentId)) return fail("invalid_evidence", "Conclusion must cite its own source document");
  if (conclusion.treatment === "needs_evidence" && (!conclusion.question?.trim() || !conclusion.missingEvidence.length)) return fail("invalid", "Missing evidence requires a specific question and missing items");
  if (conclusion.supersedesDocumentId && !conclusion.treatment.startsWith("include_")) return fail("invalid_replacement", "Only a proposed replacement invoice or credit can supersede another source");
  if (!conclusion.treatment.startsWith("include_")) return null;
  if (!Number.isSafeInteger(conclusion.amountCents) || conclusion.amountCents! <= 0 || !conclusion.customerId?.trim() || !conclusion.documentNumber?.trim() || !normalizeDocumentNumber(conclusion.documentNumber)) return fail("invalid_amount", "Inclusion requires customer, document number, and positive safe integer cents");
  const customers = await ctx.db.query("customers").withIndex("by_run_customer", (q) => q.eq("runId", runId)).collect();
  const customer = customers.find((row) => row.customerId === conclusion.customerId);
  if (!customer || customer.status !== "active") return fail("unknown_customer", "Customer must first be registered from evidence or a human decision");
  const source = (await sourceOf(ctx, runId, c.documentId))!;
  if (/Currency\s*:\s*(?!USD\b)[A-Z]{3}\b|\b(?:EUR|GBP|CAD|AUD|JPY|CHF|CNY)\s*\d/i.test(source.text)) return fail("unsupported_currency", "This workspace only accepts USD documents");
  if (supportingOnly(source)) return fail("unsupported_document", "Supporting emails, statements and bank exports cannot constitute an invoice or credit");
  if (!sourceSupports(source, conclusion, customer, customers.filter((row) => row.status === "active"))) return fail("unsupported_conclusion", "Source must support one invoice/credit identity, registered customer and final total without unresolved field conflicts");
  if (conclusion.supersedesDocumentId) {
    const target = await sourceOf(ctx, runId, conclusion.supersedesDocumentId);
    if (!target || target._id === c.documentId) return fail("invalid_replacement", "Replacement target must be another source in this workspace");
    if (!conclusion.evidence.some((ref) => ref.documentId === target._id)) return fail("invalid_evidence", "Revision proposal must cite the original it would replace");
  }
  return null;
}
async function acceptanceProblem(ctx: QueryCtx, runId: string, c: Case, conclusion: Conclusion): Promise<Fail | null> {
  if (conclusion.treatment === "needs_evidence" || conclusion.missingEvidence.length) return fail("evidence_missing", "Missing evidence must be resolved in a new proposal before recording");
  if (!conclusion.treatment.startsWith("include_")) return null;
  const all = await ctx.db.query("invoiceContributions").withIndex("by_run", (q) => q.eq("runId", runId)).collect();
  const active = all.filter((r) => r.active && r.documentId !== conclusion.supersedesDocumentId);
  const number = normalizeDocumentNumber(conclusion.documentNumber!);
  if (active.some((r) => r.documentId === c.documentId || r.customerId === conclusion.customerId && r.normalizedNumber === number)) return fail("duplicate_document", "An accepted contribution already uses this source or customer document number");
  const customerRows = active.filter((r) => r.customerId === conclusion.customerId);
  const invoiceSum = customerRows.filter((r) => r.kind === "invoice").reduce((n, r) => n + BigInt(r.amountCents), 0n) + (conclusion.treatment === "include_invoice" ? BigInt(conclusion.amountCents!) : 0n);
  const creditSum = customerRows.filter((r) => r.kind === "credit").reduce((n, r) => n + BigInt(r.amountCents), 0n) + (conclusion.treatment === "include_credit" ? BigInt(conclusion.amountCents!) : 0n);
  if (invoiceSum > BigInt(Number.MAX_SAFE_INTEGER) || creditSum > BigInt(Number.MAX_SAFE_INTEGER)) return fail("amount_overflow", "Customer totals would exceed exact integer cents");
  if (conclusion.supersedesDocumentId) {
    const source = await sourceOf(ctx, runId, conclusion.supersedesDocumentId);
    const target = source && await caseOf(ctx, runId, source.caseId);
    if (!target || target.status === "superseded" || target.status === "duplicate") return fail("stale_replacement", "Revision target is no longer current and canonical");
    const prior = all.find((r) => r.active && r.documentId === conclusion.supersedesDocumentId);
    if (prior && prior.customerId !== conclusion.customerId) return fail("invalid_replacement", "Revision cannot move another customer's contribution");
  }
  return null;
}
async function accept(ctx: MutationCtx, args: SeatAuth, c: Case, proposal: Doc<"invoiceProposals">) {
  const conclusion = proposal.conclusion;
  if (conclusion.supersedesDocumentId) {
    const source = (await sourceOf(ctx, args.runId, conclusion.supersedesDocumentId))!;
    const original = (await caseOf(ctx, args.runId, source.caseId))!;
    await deactivate(ctx, args.runId, source._id);
    await transition(ctx, args, original, "superseded", "Human-accepted revision replaces this source", { evidenceVersion: original.evidenceVersion + 1, currentProposalId: undefined });
  }
  if (conclusion.treatment.startsWith("include_")) {
    await ctx.db.insert("invoiceContributions", {
      runId: args.runId, caseId: c._id, documentId: c.documentId, proposalId: proposal._id, customerId: conclusion.customerId!,
      documentNumber: conclusion.documentNumber!, normalizedNumber: normalizeDocumentNumber(conclusion.documentNumber!),
      kind: conclusion.treatment === "include_invoice" ? "invoice" : "credit", amountCents: conclusion.amountCents!, evidence: conclusion.evidence, active: true, createdAt: Date.now(),
    });
  }
  return await transition(ctx, args, c, conclusion.treatment === "exclude" ? "excluded" : "recorded", conclusion.reason, { acceptedProposalId: proposal._id, reason: conclusion.reason, customerId: conclusion.customerId, question: undefined, missingEvidence: [] });
}

/**
 * A case imported as a version or replacement of a recorded source carries `replacesDocumentId`.
 * An inclusion proposal on it is bound to that replacement, which makes it non-routine: the
 * recorded original is superseded only when a human accepts (see accept). Exclusion keeps it.
 */
async function withRecordedReplacement(ctx: QueryCtx, runId: string, c: Case, conclusion: Conclusion): Promise<Conclusion | Fail> {
  if (!c.replacesDocumentId || !conclusion.treatment.startsWith("include_")) return conclusion;
  const target = await sourceOf(ctx, runId, c.replacesDocumentId);
  const targetCase = target && await caseOf(ctx, runId, target.caseId);
  if (!target || targetCase?.status !== "recorded") return conclusion;
  if (conclusion.supersedesDocumentId && conclusion.supersedesDocumentId !== target._id) return fail("invalid_replacement", `This import replaces recorded source ${target._id}; a proposal cannot name another replacement target`);
  const cited = conclusion.evidence.some((ref) => ref.documentId === target._id);
  return {
    ...conclusion, supersedesDocumentId: target._id,
    evidence: cited ? conclusion.evidence : [...conclusion.evidence, { documentId: target._id, version: target.version, contentHash: target.contentHash }],
    question: conclusion.question ?? `This source replaces recorded “${target.name}” (${target.externalId} v${target.version}). Accept to replace its contribution, or exclude this source to keep the original.`,
  };
}

export const submitProposal = mutation({
  args: { ...seatArgs, caseId: v.string(), evidenceVersion: v.number(), conclusion: conclusionValidator, mode: modeValidator, model: v.optional(v.string()), idempotencyKey: v.string() },
  handler: async (ctx, args): Promise<BackendResult<SubmitProposalResult>> => {
    const auth = await authorize(ctx, args, "investigate"); if (!auth.ok) return auth;
    const idem = await replay<SubmitProposalResult>(ctx, args, "proposal", withoutToken(args)); if (idem.error) return idem.error; if (idem.result) return idem.result;
    const c = await caseOf(ctx, args.runId, args.caseId); if (!c) return fail("not_found", "Case not found");
    if (c.evidenceVersion !== args.evidenceVersion) return fail("stale_proposal", "Case evidence changed; investigate the current source set");
    if (!["investigating", "needs_review"].includes(c.status)) return fail("invalid_transition", "Only an investigating or review case may receive a proposal");
    const conclusion = await withRecordedReplacement(ctx, args.runId, c, args.conclusion); if ("ok" in conclusion) return conclusion;
    const invalid = await validateConclusion(ctx, args.runId, c, conclusion); if (invalid) return invalid;
    const source = (await sourceOf(ctx, args.runId, c.documentId))!;
    const routine = args.mode === "deterministic" && !conclusion.contradictions.length && !conclusion.missingEvidence.length && !conclusion.supersedesDocumentId && (routineMatches(source, conclusion) || conclusion.treatment === "exclude" && (supportingOnly(source) || /^(?:customerId|customer_id),legal(?:Name|_name)(?:,|$)/i.test(source.text.trim().split(/\r?\n/)[0]!)));
    const problem = routine ? await acceptanceProblem(ctx, args.runId, c, conclusion) : null;
    const proposalId = await ctx.db.insert("invoiceProposals", { runId: args.runId, caseId: c._id, evidenceVersion: args.evidenceVersion, conclusion, author: args.seatId, mode: args.mode, ...(args.model ? { model: args.model } : {}), createdAt: Date.now() });
    await ctx.db.patch(c._id, { currentProposalId: proposalId, reason: conclusion.reason, customerId: conclusion.customerId, contradictions: [...conclusion.contradictions, ...(problem ? [problem.error] : [])], missingEvidence: conclusion.missingEvidence, question: conclusion.question, updatedAt: Date.now() });
    await audit(ctx, args, c._id, "proposal", conclusion.reason, { proposalId, evidenceVersion: args.evidenceVersion });
    let current = (await ctx.db.get(c._id))!;
    if (routine && !problem) current = await accept(ctx, args, current, (await ctx.db.get(proposalId))!);
    else current = await transition(ctx, args, current, conclusion.treatment === "needs_evidence" || conclusion.missingEvidence.length ? "evidence_missing" : "needs_review", problem?.error ?? (conclusion.question || "Human review required before acceptance"));
    return await remember(ctx, args, "proposal", idem.hash!, { proposalId, case: summarize(current) });
  },
});

export const decide = mutation({
  args: { ...seatArgs, caseId: v.string(), proposalId: v.string(), evidenceVersion: v.number(), idempotencyKey: v.string(), action: v.union(v.literal("accept"), v.literal("exclude"), v.literal("request_evidence")), note: v.optional(v.string()) },
  handler: async (ctx, args): Promise<BackendResult<DecisionResult>> => {
    const auth = await authorize(ctx, args, "human"); if (!auth.ok) return auth;
    const idem = await replay<DecisionResult>(ctx, args, "decision", withoutToken(args)); if (idem.error) return idem.error; if (idem.result) return idem.result;
    const c = await caseOf(ctx, args.runId, args.caseId); if (!c) return fail("not_found", "Case not found");
    const prior = await ctx.db.query("invoiceDecisions").withIndex("by_run_proposal", (q) => q.eq("runId", args.runId).eq("proposalId", args.proposalId)).first();
    if (prior) return fail("decision_conflict", "This immutable proposal already has a human decision; replay its original idempotency key");
    if (c.currentProposalId !== args.proposalId || c.evidenceVersion !== args.evidenceVersion) return fail("stale_proposal", "Approval is bound to an outdated proposal or evidence set");
    const proposalId = ctx.db.normalizeId("invoiceProposals", args.proposalId);
    const proposal = proposalId ? await ctx.db.get(proposalId) : null;
    if (!proposal || proposal.runId !== args.runId || proposal.caseId !== c._id || proposal.evidenceVersion !== args.evidenceVersion) return fail("stale_proposal", "Proposal does not match this case and evidence version");
    if (!["needs_review", "evidence_missing"].includes(c.status)) return fail("invalid_transition", "Case is not awaiting a human decision");
    if (args.action === "accept") {
      const invalid = await validateConclusion(ctx, args.runId, c, proposal.conclusion) ?? await acceptanceProblem(ctx, args.runId, c, proposal.conclusion); if (invalid) return invalid;
      if (c.status === "evidence_missing") return fail("evidence_missing", "Supply the missing evidence before accepting a new proposal");
    }
    const { runId, seatId: _s, token: _t, ...decision } = args;
    const decisionId = await ctx.db.insert("invoiceDecisions", { runId, ...decision, actor: args.seatId, createdAt: Date.now() });
    await audit(ctx, args, c._id, "decision", `${args.action}${args.note ? `: ${args.note}` : ""}`, { proposalId: args.proposalId, evidenceVersion: args.evidenceVersion });
    let current: Case;
    if (args.action === "accept") current = await accept(ctx, args, c, proposal);
    else if (args.action === "exclude") current = await transition(ctx, args, c, "excluded", args.note || "Human excluded this document", { reason: args.note || "Human excluded this document", question: undefined, missingEvidence: [] });
    else current = await transition(ctx, args, c, "evidence_missing", args.note || "Human requested more evidence", { question: args.note || c.question || "Please provide evidence supporting the proposed treatment.", missingEvidence: c.missingEvidence.length ? c.missingEvidence : [args.note || "Additional supporting evidence requested by the operator"] });
    return await remember(ctx, args, "decision", idem.hash!, { decisionId, case: summarize(current) });
  },
});

export const registerCustomer = mutation({
  args: { ...seatArgs, customerId: v.string(), legalName: v.string(), aliases: v.array(v.string()), evidence: v.array(evidenceValidator), idempotencyKey: v.string() },
  handler: async (ctx, args): Promise<BackendResult<{ customerId: string }>> => {
    const auth = await authorize(ctx, args, "register"); if (!auth.ok) return auth;
    const idem = await replay<{ customerId: string }>(ctx, args, "customer", withoutToken(args)); if (idem.error) return idem.error; if (idem.result) return idem.result;
    if (!args.customerId.trim() || !args.legalName.trim() || !args.evidence.length || args.aliases.some((a) => !a.trim())) return fail("invalid", "Customer identity, name and source evidence are required");
    const invalid = await validateEvidence(ctx, args.runId, args.evidence); if (invalid) return invalid;
    const texts = await Promise.all(args.evidence.map(async (e) => (await sourceOf(ctx, args.runId, e.documentId))!.text));
    if (!auth.human && ![args.customerId, args.legalName, ...args.aliases].every((value) => texts.some((text) => text.toLowerCase().includes(value.toLowerCase())))) return fail("unsupported_customer", "Customer identity and aliases must appear in source evidence or be explicitly registered by the human operator");
    const existing = await ctx.db.query("customers").withIndex("by_run_customer", (q) => q.eq("runId", args.runId).eq("customerId", args.customerId)).unique();
    if (existing && (existing.legalName !== args.legalName || args.aliases.some((alias) => !existing.aliases.includes(alias)))) return fail("customer_conflict", "Existing customer identity is immutable in this MVP");
    if (!existing) await ctx.db.insert("customers", { runId: args.runId, customerId: args.customerId, legalName: args.legalName, aliases: args.aliases, status: "active", registeredBy: args.seatId, sourceDocumentId: args.evidence[0]!.documentId, at: Date.now() });
    const source = (await sourceOf(ctx, args.runId, args.evidence[0]!.documentId))!;
    await audit(ctx, args, source.caseId, "customer_registered", `${auth.human ? "Human confirmed" : "Source-supported"} customer ${args.customerId}: ${args.legalName}`);
    return await remember(ctx, args, "customer", idem.hash!, { customerId: args.customerId });
  },
});

export const recordToolCall = mutation({
  args: { ...seatArgs, caseId: v.string(), evidenceVersion: v.number(), call: toolCallValidator, idempotencyKey: v.string() },
  handler: async (ctx, args): Promise<BackendResult<{ auditId: string }>> => {
    const auth = await authorize(ctx, args, "investigate"); if (!auth.ok) return auth;
    const idem = await replay<{ auditId: string }>(ctx, args, "tool", withoutToken(args)); if (idem.error) return idem.error; if (idem.result) return idem.result;
    const c = await caseOf(ctx, args.runId, args.caseId); if (!c) return fail("not_found", "Case not found");
    if (c.evidenceVersion !== args.evidenceVersion) return fail("stale_proposal", "Tool result belongs to an outdated evidence set");
    if (!args.call.tool.trim() || !args.call.summary.trim()) return fail("invalid", "Tool name and concise summary are required");
    const invalid = await validateEvidence(ctx, args.runId, args.call.evidence); if (invalid) return invalid;
    for (const value of [args.call.inputTokens, args.call.outputTokens, args.call.costMicros, args.call.durationMs]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) return fail("invalid", "Usage values must be nonnegative safe integers");
    const auditId = await audit(ctx, args, c._id, "tool_call", args.call.summary, { evidenceVersion: args.evidenceVersion, toolCall: args.call });
    return await remember(ctx, args, "tool", idem.hash!, { auditId });
  },
});

export const caseDetail = query({
  args: { ...seatArgs, caseId: v.string() },
  handler: async (ctx, args): Promise<BackendResult<CaseDetail>> => {
    const auth = await authorize(ctx, args, "read"); if (!auth.ok) return auth;
    const c = await caseOf(ctx, args.runId, args.caseId); if (!c) return fail("not_found", "Case not found");
    const source = (await sourceOf(ctx, args.runId, c.documentId))!;
    const sourceVersions = await ctx.db.query("invoiceSources").withIndex("by_run_external", (q) => q.eq("runId", args.runId).eq("externalId", c.externalId)).collect();
    const proposals = (await ctx.db.query("invoiceProposals").withIndex("by_run_case", (q) => q.eq("runId", args.runId).eq("caseId", c._id)).collect()).map(proposalView);
    const decisions = (await ctx.db.query("invoiceDecisions").withIndex("by_run_case", (q) => q.eq("runId", args.runId).eq("caseId", c._id)).collect()).map(({ _id, _creationTime: _t, runId: _r, ...rest }) => ({ ...rest, decisionId: _id }));
    const entries = (await ctx.db.query("invoiceAudit").withIndex("by_run_case", (q) => q.eq("runId", args.runId).eq("caseId", c._id)).collect()).map(({ _id, _creationTime: _t, runId: _r, ...rest }) => ({ ...rest, auditId: _id }));
    const contributions = (await ctx.db.query("invoiceContributions").withIndex("by_run_document", (q) => q.eq("runId", args.runId).eq("documentId", c.documentId)).collect()).map(contributionView);
    const currentProposal = proposals.find((p) => p.proposalId === c.currentProposalId), acceptedProposal = proposals.find((p) => p.proposalId === c.acceptedProposalId);
    const originals = await Promise.all(sourceVersions.sort((a, b) => a.version - b.version).map(async (s) => {
      const chunks = await ctx.db.query("invoiceSourceChunks").withIndex("by_run_document", (q) => q.eq("runId", args.runId).eq("documentId", s._id)).collect();
      return { ...sourceView(s), ...(chunks.length ? { contentBase64: chunks.sort((a, b) => a.index - b.index).map((chunk) => chunk.content).join("") } : {}) };
    }));
    return ok({ case: summarize(c), source: originals.find((s) => s.documentId === source._id)!, sourceVersions: originals, proposals, ...(currentProposal ? { currentProposal } : {}), ...(acceptedProposal ? { acceptedProposal } : {}), decisions, audit: entries, contributions });
  },
});

export const pendingCases = query({
  args: seatArgs,
  handler: async (ctx, args): Promise<BackendResult<CaseSummary[]>> => {
    const auth = await authorize(ctx, args, "read"); if (!auth.ok) return auth;
    return ok((await allCases(ctx, args.runId)).filter((c) => c.status === "received" || c.status === "investigating").map(summarize));
  },
});

export const workspace = query({
  args: seatArgs,
  handler: async (ctx, args): Promise<BackendResult<WorkspaceSnapshot>> => {
    const auth = await authorize(ctx, args, "read"); if (!auth.ok) return auth;
    const cases = (await allCases(ctx, args.runId)).map(summarize);
    const customers = await ctx.db.query("customers").withIndex("by_run_customer", (q) => q.eq("runId", args.runId)).collect();
    const contributions = (await ctx.db.query("invoiceContributions").withIndex("by_run", (q) => q.eq("runId", args.runId)).collect()).filter((c) => c.active).map(contributionView);
    const customerTotals = customers.map((customer) => {
      const rows = contributions.filter((c) => c.customerId === customer.customerId);
      const invoices = rows.filter((c) => c.kind === "invoice");
      const grossCents = invoices.reduce((sum, c) => sum + c.amountCents, 0);
      const creditCents = rows.filter((c) => c.kind === "credit").reduce((sum, c) => sum + c.amountCents, 0);
      return { customerId: customer.customerId, legalName: customer.legalName, aliases: customer.aliases, validInvoiceCount: invoices.length, grossCents, creditCents, netCents: grossCents - creditCents, contributions: rows };
    });
    const batches = (await ctx.db.query("invoiceBatches").withIndex("by_run", (q) => q.eq("runId", args.runId)).collect()).map(({ _id, _creationTime: _t, runId: _r, ...rest }) => ({ ...rest, batchId: _id }));
    const proposals = await ctx.db.query("invoiceProposals").withIndex("by_run_case", (q) => q.eq("runId", args.runId)).collect();
    const modes = new Set(proposals.filter((p) => p.runId === args.runId).map((p) => p.mode));
    const count = (status: CaseStatus) => cases.filter((c) => c.status === status).length;
    return ok({ runId: args.runId, company: auth.run.company, currency: "USD", identity: { seatId: auth.seat.seatId, kind: auth.seat.kind, simulated: true }, runtimeMode: modes.has("live_model") ? "live_model" : modes.has("mock_model") ? "mock_model" : "deterministic", batches, cases, customerTotals,
      progress: { total: cases.length, pending: count("received") + count("investigating"), needsReview: count("needs_review"), evidenceMissing: count("evidence_missing"), recorded: count("recorded"), excluded: count("excluded"), duplicate: count("duplicate"), superseded: count("superseded") } });
  },
});

export const modelBudget = query({
  args: seatArgs,
  handler: async (ctx, args): Promise<BackendResult<ModelBudget | null>> => {
    const auth = await authorize(ctx, args, "read"); if (!auth.ok) return auth;
    const row = await ctx.db.query("invoiceModelBudgets").withIndex("by_run", (q) => q.eq("runId", args.runId)).unique();
    return ok(row ? { maxRequests: row.maxRequests, maxCostMicros: row.maxCostMicros, requestsReserved: row.requestsReserved, costReservedMicros: row.costReservedMicros } : null);
  },
});

/** Reserve worst-case spend before dispatch. A replay is NOT authorization to dispatch again. */
export const reserveModelRequest = mutation({
  args: { ...seatArgs, caseId: v.string(), evidenceVersion: v.number(), idempotencyKey: v.string(), model: v.string(), maxCostMicros: v.number(), budget: v.object({ maxRequests: v.number(), maxCostMicros: v.number() }) },
  handler: async (ctx, args): Promise<BackendResult<ModelReservationResult>> => {
    const auth = await authorize(ctx, args, "investigate"); if (!auth.ok) return auth;
    const idem = await replay<ModelReservationResult>(ctx, args, "model_reservation", withoutToken(args)); if (idem.error) return idem.error; if (idem.result) return idem.result;
    if (!args.model.trim() || ![args.maxCostMicros, args.budget.maxRequests, args.budget.maxCostMicros].every((n) => Number.isSafeInteger(n) && n > 0)) return fail("invalid", "Model and positive safe-integer reservation/budget limits are required");
    const c = await caseOf(ctx, args.runId, args.caseId); if (!c) return fail("not_found", "Case not found");
    if (c.evidenceVersion !== args.evidenceVersion) return fail("stale_proposal", "Model request belongs to an outdated evidence set");
    if (c.status !== "investigating") return fail("invalid_transition", "Model calls are only reserved for current investigations");
    const existing = await ctx.db.query("invoiceModelBudgets").withIndex("by_run", (q) => q.eq("runId", args.runId)).unique();
    if (existing && (existing.maxRequests !== args.budget.maxRequests || existing.maxCostMicros !== args.budget.maxCostMicros)) return fail("budget_conflict", "This workspace's initial model budget is immutable");
    const requestsReserved = (existing?.requestsReserved ?? 0) + 1;
    const costReservedMicros = (existing?.costReservedMicros ?? 0) + args.maxCostMicros;
    if (!Number.isSafeInteger(costReservedMicros) || requestsReserved > args.budget.maxRequests || costReservedMicros > args.budget.maxCostMicros) return fail("budget_exhausted", "Model request would exceed the persistent request or worst-case spend budget");
    if (existing) await ctx.db.patch(existing._id, { requestsReserved, costReservedMicros });
    else await ctx.db.insert("invoiceModelBudgets", { runId: args.runId, ...args.budget, requestsReserved, costReservedMicros, createdAt: Date.now() });
    const reservationId = await ctx.db.insert("invoiceModelReservations", { runId: args.runId, caseId: c._id, evidenceVersion: c.evidenceVersion, idempotencyKey: args.idempotencyKey, model: args.model, maxCostMicros: args.maxCostMicros, actor: args.seatId, createdAt: Date.now() });
    await audit(ctx, args, c._id, "model_reserved", `Reserved one ${args.model} request, at most ${args.maxCostMicros} cost micros; reservation remains charged after interruption`, { evidenceVersion: c.evidenceVersion });
    return await remember(ctx, args, "model_reservation", idem.hash!, { reservationId, ...args.budget, requestsReserved, costReservedMicros });
  },
});
