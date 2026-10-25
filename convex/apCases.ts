import { retainedSourceOutcome, assertSourcePayable } from "./lib/apSystem/sourceOutcome";
import { activeBusinessPolicy } from "./lib/apSystem/businessAuthority";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { scopeValidator } from "./demoSchema";
import {
  accountingSeat,
  assertRowScope,
  auditDemo,
  requirePaymentHuman,
  requirePaymentSeat,
} from "./lib/demoAuth";
import { canonical, sha256Hex } from "./lib/kernel";
import { appendDemoEntry } from "./lib/demoPost";
import { cancelUnsent } from "./lib/payments/applyCommand";
import {
  AP_POLICY_VERSION,
  intakeSchema,
  sourceOutcomeSchema,
  decisionSchema,
  reviewRequestSchema,
  billApprovalRequestSchema,
  type APIntake,
  type APDecision,
} from "../src/ap-system/contracts";
import {
  evaluatePolicy,
  obligationKey,
  sourceKey,
} from "../src/ap-system/policy";
import { recognitionLines } from "../src/ap-system/accounting";
import {
  bindings,
  caseRow,
  currentReview,
  deny,
  readAuth,
  receipt,
  replay,
  saveSources,
  snapshot,
  verifyOriginal,
  storedIntake,
  sourceBytes,
} from "./lib/apSystem/shared";
import { projectCase } from "./lib/apSystem/projection";
import { normalizeInvoiceNumber } from "./lib/invoiceIdentity";

const scoped = { scope: scopeValidator };
const agent = { ...scoped, seatId: v.string(), token: v.string() };
const readable = {
  ...scoped,
  seatId: v.optional(v.string()),
  token: v.optional(v.string()),
};
/** Duplicate bytes can add delivery provenance; changed extraction requires an explicit revision. */
function economicFacts(input: APIntake) {
  if (!input.candidate) return null;
  const {
    candidateId: _,
    revision: __,
    sources: ___,
    evidence: ____,
    parseWarnings: _____,
    ...facts
  } = input.candidate;
  return {
    ...facts,
    lines: facts.lines.map(({ evidenceIds: _, ...line }) => line),
    purchasing: input.purchasingEvidence.map(({ source: _, ...p }) => p),
  };
}
export const ingest = mutation({
  args: { ...agent, input: v.any() },
  handler: async (ctx, args) => {
    const { config, seat } = await requirePaymentSeat(ctx, args, ["ap_clerk"]);
    const parsed = intakeSchema.safeParse(args.input);
    if (!parsed.success)
      deny(
        "invalid_intake",
        parsed.error.issues.map((i) => i.message).join("; "),
      );
    const input = parsed.data;
    if (
      input.documents.reduce((sum, d) => sum + d.byteLength, 0) >
      8 * 1024 * 1024
    )
      deny(
        "source_too_large",
        "AP intake packet exceeds the supported 8 MiB original-byte bound",
      );
    if (input.documents.length > 10)
      deny(
        "too_many_sources",
        "AP intake supports at most 10 original documents per packet",
      );
    if (
      new TextEncoder().encode(JSON.stringify(storedIntake(input))).byteLength >
      750_000
    )
      deny(
        "metadata_too_large",
        "Parsed metadata exceeds the bounded case-row size; retain upload error for explicit review",
      );
    for (const document of input.documents) await verifyOriginal(document);
    const operation = await replay(
      ctx,
      args.scope,
      `ingest:${input.idempotencyKey}`,
      { input: storedIntake(input), actor: seat.seatId },
    );
    if (operation.prior)
      return operation.prior.result as {
        caseId: string;
        revision: number;
        replayed: boolean;
        duplicate: boolean;
      };
    const invoices = input.documents.filter(
      (d) => d.kind === "invoice" || d.kind === "credit_note",
    );
    if (invoices.length !== 1)
      deny(
        "invoice_source_required",
        "One primary invoice/credit source is required per case; supporting documents remain separate",
      );
    const primaryHash = invoices[0]!.sha256;
    const key = input.candidate ? obligationKey(input.candidate) : undefined;
    const newHash = await snapshot(input);
    const now = Date.now();
    let row: Doc<"apCaseRecords"> | null = null;
    let duplicate = false;
    if (input.explicitRevisionOf) {
      row = await caseRow(ctx, args.scope, input.explicitRevisionOf);
      const retainedOutcome = retainedSourceOutcome(row);
      if (retainedOutcome && input.sourceOutcome && canonical(retainedOutcome) !== canonical(input.sourceOutcome))
        deny("historical_source_outcome_immutable", "Retained historical payment evidence cannot be changed or cleared by reimport");
      if (key && row.obligationKey && key !== row.obligationKey)
        deny(
          "obligation_identity_changed",
          "A revision cannot change supplier/invoice identity; use an independently reviewed correction case",
        );
      if (
        input.candidate &&
        input.candidate.revision !== row.currentRevision + 1
      )
        deny(
          "candidate_revision_conflict",
          "Candidate revision must advance the current case exactly once",
        );
      if (row.billId) {
        const bill = await ctx.db.get(row.billId);
        assertRowScope(bill, args.scope);
        const b = bill as Doc<"demoBills">;
        if (b.reservedVersionId) {
          const version = await ctx.db.get(b.reservedVersionId);
          const command = await ctx.db
            .query("demoCommands")
            .withIndex("by_command", (q) =>
              q
                .eq("scope.runId", args.scope.runId)
                .eq("command.commandId", b.reservedVersionId!),
            )
            .unique();
          const attempted =
            command &&
            (command.attemptCount > 0 ||
              command.firstAttemptAt !== undefined ||
              command.generation !== 0 ||
              !!command.providerTransferId);
          if (version && !attempted) await cancelUnsent(ctx, version);
          else
            await auditDemo(
              ctx,
              args.scope,
              seat.seatId,
              "ap_revision_after_dispatch",
              {
                caseId: row._id,
                billId: b._id,
                commandId: command?._id,
                reason:
                  "Retain original operation and reservations until bank outcome resolves",
              },
            );
        }
        await ctx.db.patch(b._id, {
          flags: [...new Set([...b.flags, "ap_case_revision_requires_review"])],
          version: b.version + 1,
        });
      }
      await ctx.db.patch(row._id, {
        intake: storedIntake(input),
        ...(input.sourceOutcome ? {sourceOutcome: input.sourceOutcome} : {}),
        currentRevision: row.currentRevision + 1,
        snapshotHash: newHash,
        primaryHash,
        ...(key ? { obligationKey: key } : {}),
        fieldReviewId: undefined,
        documentStatus:
          input.extraction.status === "failed" ? "failed" : "review_required",
        businessStatus: "held",
        updatedAt: now,
      });
      row = (await ctx.db.get(row._id))!;
    } else {
      const byHash = await ctx.db
        .query("apCaseRecords")
        .withIndex("by_hash", (q) =>
          q.eq("scope.runId", args.scope.runId).eq("primaryHash", primaryHash),
        )
        .unique();
      const byKey = key
        ? await ctx.db
            .query("apCaseRecords")
            .withIndex("by_obligation", (q) =>
              q.eq("scope.runId", args.scope.runId).eq("obligationKey", key),
            )
            .unique()
        : null;
      row = byHash ?? byKey;
      if (row) {
        assertRowScope(row, args.scope);
        if (byHash && byKey && byHash._id !== byKey._id)
          deny(
            "obligation_conflict",
            "Source and invoice identity point to different existing cases",
          );
        if (
          canonical(economicFacts(intakeSchema.parse(row.intake))) !==
          canonical(economicFacts(input))
        )
          deny(
            "explicit_revision_required",
            "Existing invoice/source has different facts; import an explicit revision, preserving its history",
          );
        const retainedOutcome = retainedSourceOutcome(row);
        if (input.sourceOutcome && canonical(retainedOutcome ?? null) !== canonical(input.sourceOutcome))
          deny("historical_source_outcome_update_required", "Record historical source outcome explicitly before reimporting an existing case");
        duplicate = true;
      } else {
        if (input.candidate && input.candidate.revision !== 1)
          deny(
            "candidate_revision_conflict",
            "A new case starts at candidate revision 1",
          );
        const holds = evaluatePolicy(input, config.beneficiary.vendor);
        const id = await ctx.db.insert("apCaseRecords", {
          scope: args.scope,
          ...(key ? { obligationKey: key } : {}),
          primaryHash,
          currentRevision: 1,
          snapshotHash: newHash,
          intake: storedIntake(input),
          ...(input.sourceOutcome ? {sourceOutcome: input.sourceOutcome} : {}),
          createdBy: seat.seatId,
          documentStatus:
            input.extraction.status === "failed" ? "failed" : "review_required",
          businessStatus: holds.length ? "held" : "unreviewed",
          identityMode:
            args.scope.environment === "local"
              ? "simulated_human"
              : "authenticated_human",
          createdAt: now,
          updatedAt: now,
        });
        row = (await ctx.db.get(id))!;
      }
    }
    await saveSources(ctx, args.scope, row._id, input);
    if (!duplicate)
      await ctx.db.insert("apCaseRevisions", {
        scope: args.scope,
        caseId: row._id,
        revision: row.currentRevision,
        intake: storedIntake(input),
        snapshotHash: row.snapshotHash,
        actor: seat.seatId,
        at: now,
      });
    await auditDemo(
      ctx,
      args.scope,
      seat.seatId,
      duplicate ? "ap_duplicate_delivery" : "ap_source_received",
      {
        caseId: row._id,
        revision: row.currentRevision,
        sourceHashes: input.documents.map((d) => d.sha256),
      },
    );
    const result = {
      caseId: row._id,
      revision: row.currentRevision,
      replayed: false,
      duplicate,
    };
    await receipt(
      ctx,
      args.scope,
      `ingest:${input.idempotencyKey}`,
      operation.payloadHash,
      result,
    );
    return result;
  },
});
/** A monotonic safety annotation: retains source history without inventing a local settlement. */
export const recordSourceOutcome = mutation({
  args: {...agent, caseId:v.string(), sourceOutcome:v.any()},
  handler: async (ctx,args) => {
    const {seat}=await requirePaymentSeat(ctx,args,["ap_clerk"]);
    const row=await caseRow(ctx,args.scope,args.caseId);
    const parsed=sourceOutcomeSchema.safeParse(args.sourceOutcome);
    if(!parsed.success) deny("invalid_source_outcome",parsed.error.message);
    const outcome=parsed.data, prior=retainedSourceOutcome(row);
    if(prior) {
      if(canonical(prior)!==canonical(outcome)) deny("historical_source_outcome_immutable","Retained historical payment evidence cannot be changed or cleared");
      return {caseId:row._id,sourceOutcome:prior,replayed:true};
    }
    // Validate amount and every evidence binding against this case's current originals.
    const checked=intakeSchema.safeParse({...row.intake,sourceOutcome:outcome});
    if(!checked.success) deny("invalid_source_outcome",checked.error.message);
    await ctx.db.patch(row._id,{sourceOutcome:outcome,updatedAt:Date.now()});
    await auditDemo(ctx,args.scope,seat.seatId,"ap_historical_source_paid",{caseId:row._id,sourceOutcome:outcome});
    return {caseId:row._id,sourceOutcome:outcome,replayed:false};
  },
});
export const list = query({
  args: readable,
  handler: async (ctx, args) => {
    await readAuth(ctx, args);
    const rows = await ctx.db
      .query("apCaseRecords")
      .withIndex("by_run", (q) => q.eq("scope.runId", args.scope.runId))
      .collect();
    return Promise.all(
      rows.map((r) => {
        assertRowScope(r, args.scope);
        return projectCase(ctx, r);
      }),
    );
  },
});
export const detail = query({
  args: { ...readable, caseId: v.string() },
  handler: async (ctx, args) => {
    await readAuth(ctx, args);
    return projectCase(ctx, await caseRow(ctx, args.scope, args.caseId));
  },
});
/** The HTTP service serves bytes; it must not expose private filesystem/artifact references. */
export const source = query({
  args: {
    ...readable,
    sourceId: v.string(),
    revision: v.number(),
    sha256: v.string(),
  },
  handler: async (ctx, args) => {
    await readAuth(ctx, args);
    const row = await ctx.db
      .query("apCaseSources")
      .withIndex("by_source", (q) =>
        q
          .eq("scope.runId", args.scope.runId)
          .eq("sourceId", args.sourceId)
          .eq("revision", args.revision),
      )
      .unique();
    if (!row || row.sha256 !== args.sha256)
      deny("source_not_found", "Exact original source binding not found");
    assertRowScope(row, args.scope);
    const document = row.document as APIntake["documents"][number];
    return {
      ...document,
      originalBase64: await sourceBytes(ctx, args.scope, document),
    };
  },
});
export const reviewFields = mutation({
  args: { ...scoped, input: v.any() },
  handler: async (ctx, args) => {
    const { seat, subject } = await requirePaymentHuman(ctx, args.scope);
    const parsed = reviewRequestSchema.safeParse(args.input);
    if (!parsed.success) deny("invalid_review", parsed.error.message);
    const request = parsed.data;
    const op = await replay(
      ctx,
      args.scope,
      `review:${request.idempotencyKey}`,
      { request, subject },
    );
    if (op.prior)
      return op.prior.result as { caseId: string; decisionId: string };
    const row = await caseRow(ctx, args.scope, request.caseId);
    const input = currentReview(row, request);
    if (row.createdBy === seat.seatId)
      deny("self_approval", "The case creator cannot review their own intake");
    if (row.billId && !row.domainApprovalId && !(await activeBusinessPolicy(ctx, args.scope)))
      deny(
        "posted_correction_required",
        "A recognized bill requires the controlled correction workflow",
      );
    if (request.outcome === "approved") {
      if (
        !input.candidate ||
        input.extraction.status !== "complete" ||
        input.candidate.evidence.some((e) => e.contentStatus !== "supported")
      )
        deny(
          "unresolved_content",
          "Incomplete/conflicting extracted content cannot be approved",
        );
      if (
        input.candidate.evidence.some(
          (e) => !request.evidenceIds.includes(e.evidenceId),
        )
      )
        deny(
          "review_coverage",
          "Explicitly review all candidate field evidence, including unresolved geometry",
        );
    }
    const decisionId = `${row._id}:field:${request.idempotencyKey}`;
    const decision: APDecision = {
      decisionId,
      kind: "field_review",
      actor: subject,
      actorKind: "human",
      authority: "configured_human_cfo",
      at: Date.now(),
      candidateRevision: row.currentRevision,
      sourceBindings: bindings(input),
      snapshotHash: row.snapshotHash,
      policyVersion: AP_POLICY_VERSION,
      outcome: request.outcome,
      reason: request.reason,
      evidenceIds: request.evidenceIds,
    };
    await ctx.db.insert("apCaseDecisions", {
      scope: args.scope,
      caseId: row._id,
      decision,
    });
    await ctx.db.patch(row._id, {
      fieldReviewId: request.outcome === "approved" ? decisionId : undefined,
      documentStatus:
        request.outcome === "approved" ? "reviewed" : "review_required",
      businessStatus: request.outcome === "rejected" ? "rejected" : "held",
      updatedAt: Date.now(),
    });
    await auditDemo(ctx, args.scope, seat.seatId, "ap_fields_reviewed", {
      caseId: row._id,
      decisionId,
      revision: row.currentRevision,
      outcome: request.outcome,
    });
    const result = { caseId: row._id, decisionId };
    await receipt(
      ctx,
      args.scope,
      `review:${request.idempotencyKey}`,
      op.payloadHash,
      result,
    );
    return result;
  },
});
export const approveBill = mutation({
  args: { ...scoped, input: v.any() },
  handler: async (ctx, args) => {
    const { config, seat, subject } = await requirePaymentHuman(
      ctx,
      args.scope,
    );
    const parsed = billApprovalRequestSchema.safeParse(args.input);
    if (!parsed.success) deny("invalid_approval", parsed.error.message);
    const request = parsed.data;
    const op = await replay(
      ctx,
      args.scope,
      `approve:${request.idempotencyKey}`,
      { request, subject },
    );
    if (op.prior)
      return op.prior.result as {
        caseId: string;
        billId: string;
        entryId: string;
        decisionId: string;
      };
    const row = await caseRow(ctx, args.scope, request.caseId);
    assertSourcePayable(row);
    if (row.domainApprovalId || await activeBusinessPolicy(ctx, args.scope))
      deny("business_route_required", "Configured business governance requires the explicit amount/allocation and sequential group approval route");
    const input = currentReview(row, request);
    const c = input.candidate;
    if (row.createdBy === seat.seatId)
      deny(
        "self_approval",
        "The case creator cannot approve their own obligation",
      );
    if (request.outcome !== "approved")
      deny(
        "invalid_approval",
        "Bill approval requires an explicit approved decision; use field review for rejection or evidence requests",
      );
    if (!c || row.documentStatus !== "reviewed" || !row.fieldReviewId)
      deny(
        "field_review_required",
        "Current source fields require a separate authenticated review before bill approval",
      );
    const decisions = (
      await ctx.db
        .query("apCaseDecisions")
        .withIndex("by_case", (q) =>
          q.eq("scope.runId", args.scope.runId).eq("caseId", row._id),
        )
        .collect()
    ).map((d) => decisionSchema.parse(d.decision));
    const field = decisions.find((d) => d.decisionId === row.fieldReviewId);
    if (
      !field ||
      field.outcome !== "approved" ||
      field.snapshotHash !== row.snapshotHash ||
      field.candidateRevision !== row.currentRevision
    )
      deny(
        "stale_field_review",
        "Field review is not bound to current evidence",
      );
    if (request.acceptedCents !== c.totalCents)
      deny(
        "adjustment_authority_required",
        "First-wave policy requires full invoiced amount; adjustments need a separately supported allocation and authority",
      );
    const holds = evaluatePolicy(input, config.beneficiary.vendor, true).filter(
      (e) => e.blocking,
    );
    if (holds.length)
      deny(
        "policy_hold",
        holds.map((h) => `${h.code}: ${h.reason}`).join("; "),
      );
    if (c.evidence.some((e) => !request.evidenceIds.includes(e.evidenceId)))
      deny(
        "review_coverage",
        "Bill approval must reference the complete reviewed field set",
      );
    if (row.billId) {
      const existing = await ctx.db.get(row.billId);
      assertRowScope(existing, args.scope);
      const b = existing as Doc<"demoBills">;
      if (
        row.businessStatus !== "approved" ||
        b.flags.length ||
        b.approvedCents !== request.acceptedCents ||
        !b.entryId
      )
        deny(
          "posted_correction_required",
          "Recognized amounts are immutable; new evidence requires authorized correction",
        );
      const priorApproval = decisions.find(
        (d) =>
          d.kind === "bill_approval" &&
          d.outcome === "approved" &&
          d.snapshotHash === row.snapshotHash &&
          d.candidateRevision === row.currentRevision,
      );
      if (!priorApproval)
        deny(
          "approval_history_missing",
          "Recognized bill has no matching retained approval decision",
        );
      const result = {
        caseId: row._id,
        billId: b._id,
        entryId: b.entryId,
        decisionId: priorApproval.decisionId,
      };
      await receipt(
        ctx,
        args.scope,
        `approve:${request.idempotencyKey}`,
        op.payloadHash,
        result,
      );
      return result;
    }
    // The first wave reserves each received line for one recognized obligation. B3 may
    // add explicit partial allocations; an invoice cannot silently reuse another bill's receipt.
    const receiptKeys = (i: APIntake) =>
      new Set(
        i.purchasingEvidence
          .filter((p) => p.kind === "receipt")
          .flatMap((p) =>
            p.lines.map((l) => `${sourceKey(p.source)}:${l.lineId}`),
          ),
      );
    const mine = receiptKeys(input);
    const otherCases = await ctx.db
      .query("apCaseRecords")
      .withIndex("by_run", (q) => q.eq("scope.runId", args.scope.runId))
      .collect();
    for (const other of otherCases)
      if (other._id !== row._id && other.billId) {
        const approved = (
          await ctx.db
            .query("apCaseDecisions")
            .withIndex("by_case", (q) =>
              q.eq("scope.runId", args.scope.runId).eq("caseId", other._id),
            )
            .collect()
        )
          .map((d) => decisionSchema.parse(d.decision))
          .find((d) => d.kind === "bill_approval" && d.outcome === "approved");
        if (!approved)
          deny(
            "approval_history_missing",
            "Recognized obligation has no retained approval decision",
          );
        const recognized = await ctx.db
          .query("apCaseRevisions")
          .withIndex("by_case", (q) =>
            q
              .eq("scope.runId", args.scope.runId)
              .eq("caseId", other._id)
              .eq("revision", approved.candidateRevision),
          )
          .unique();
        if (!recognized || recognized.snapshotHash !== approved.snapshotHash)
          deny(
            "approval_history_missing",
            "Recognized obligation has no retained approved source snapshot",
          );
        if (
          [...receiptKeys(intakeSchema.parse(recognized.intake))].some((k) =>
            mine.has(k),
          )
        )
          deny(
            "receipt_already_recognized",
            "Receipt evidence already supports another recognized obligation; an explicit allocation/correction is required",
          );
      }
    const normalized = normalizeInvoiceNumber(c.invoiceNumber);
    if (!normalized)
      deny("invoice_identity_required", "Invoice number normalizes to empty");
    const existing = await ctx.db
      .query("demoBills")
      .withIndex("by_invoice", (q) =>
        q
          .eq("scope.runId", args.scope.runId)
          .eq("vendor", c.supplierId!)
          .eq("invoiceNumber", normalized),
      )
      .unique();
    if (existing)
      deny(
        "existing_obligation",
        "An existing scoped bill already owns this invoice; reconcile its case association before creating any posting",
      );
    const decisionId = `${row._id}:bill:${request.idempotencyKey}`;
    const billId = await ctx.db.insert("demoBills", {
      scope: args.scope,
      vendor: c.supplierId!,
      invoiceNumber: normalized,
      invoiceDate: c.invoiceDate,
      recordHash: await sha256Hex(canonical(economicFacts(input))),
      originalCents: c.totalCents,
      paidCents: 0,
      version: 1,
      evidence: bindings(input).map(sourceKey),
      flags: [],
      expenseAccount: c.lines[0]!.allocations[0]!.account,
      createdBy: row.createdBy,
      status: "recorded",
      createdAt: Date.now(),
    });
    const posted = await appendDemoEntry(ctx, {
      runId: args.scope.runId,
      seat: accountingSeat(args.scope.runId),
      date: c.invoiceDate,
      memo: `Recognized reviewed invoice ${c.supplierId}/${c.invoiceNumber}`,
      source: { kind: "bill", ref: billId },
      lines: recognitionLines(c),
      idempotencyKey: `ap:recognition:${row._id}`,
      decisionPath: decisionId,
    });
    if (!posted.ok) deny(posted.code, posted.error);
    await ctx.db.patch(billId, {
      approvedCents: c.totalCents,
      status: "approved",
      version: 2,
      entryId: posted.entryId,
    });
    const decision: APDecision = {
      decisionId,
      kind: "bill_approval",
      actor: subject,
      actorKind: "human",
      authority: "configured_human_cfo",
      at: Date.now(),
      candidateRevision: row.currentRevision,
      sourceBindings: bindings(input),
      snapshotHash: row.snapshotHash,
      policyVersion: AP_POLICY_VERSION,
      outcome: "approved",
      reason: request.reason,
      evidenceIds: request.evidenceIds,
    };
    await ctx.db.insert("apCaseDecisions", {
      scope: args.scope,
      caseId: row._id,
      decision,
    });
    await ctx.db.patch(row._id, {
      billId,
      acceptedCents: c.totalCents,
      businessStatus: "approved",
      updatedAt: Date.now(),
    });
    await auditDemo(ctx, args.scope, seat.seatId, "ap_bill_recognized", {
      caseId: row._id,
      billId,
      entryId: posted.entryId,
      decisionId,
      revision: row.currentRevision,
    });
    const result = {
      caseId: row._id,
      billId,
      entryId: posted.entryId,
      decisionId,
    };
    await receipt(
      ctx,
      args.scope,
      `approve:${request.idempotencyKey}`,
      op.payloadHash,
      result,
    );
    return result;
  },
});
