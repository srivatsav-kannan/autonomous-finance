import { businessProjection } from "./businessProjection";
import type { QueryCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import {
  AP_CONTRACT_VERSION,
  AP_POLICY_VERSION,
  intakeSchema,
  historicalPaymentHoldSchema,
  decisionSchema,
  type APCaseDetail,
  type SourceDocument,
  type SourceBinding,
  type Processor,
} from "../../../src/ap-system/contracts";
import { evaluatePolicy } from "../../../src/ap-system/policy";
import { getPaymentConfig } from "../demoAuth";

function safeProcessor(p: Processor): Processor {
  const safe = (a: Processor["rawArtifact"]) =>
    a ? { ref: `artifact:${a.sha256}`, sha256: a.sha256 } : null;
  return {
    ...p,
    configArtifact: safe(p.configArtifact),
    rawArtifact: safe(p.rawArtifact),
    tokenArtifact: safe(p.tokenArtifact),
    rasterArtifact: safe(p.rasterArtifact),
  };
}
function safeSource(d: SourceDocument): SourceDocument {
  const { originalBase64: _, ...source } = d;
  return {
    ...source,
    originalRef: `source:${d.sourceId}:${d.revision}:${d.sha256}`,
    parser: d.parser ? safeProcessor(d.parser) : null,
  };
}
export async function projectCase(
  ctx: QueryCtx,
  row: Doc<"apCaseRecords">,
): Promise<APCaseDetail & { currentSourceBindings: SourceBinding[] }> {
  const input = intakeSchema.parse(row.intake);
  const config = await getPaymentConfig(ctx, row.scope);
  const decisions = (
    await ctx.db
      .query("apCaseDecisions")
      .withIndex("by_case", (q) =>
        q.eq("scope.runId", row.scope.runId).eq("caseId", row._id),
      )
      .collect()
  ).map((d) => decisionSchema.parse(d.decision));
  const revisions = await ctx.db
    .query("apCaseRevisions")
    .withIndex("by_case", (q) =>
      q.eq("scope.runId", row.scope.runId).eq("caseId", row._id),
    )
    .collect();
  const deliveries = await ctx.db
    .query("apCaseDeliveries")
    .withIndex("by_case", (q) =>
      q.eq("scope.runId", row.scope.runId).eq("caseId", row._id),
    )
    .collect();
  const retained = await Promise.all(
    deliveries.map((d) =>
      ctx.db
        .query("apCaseSources")
        .withIndex("by_source", (q) =>
          q
            .eq("scope.runId", row.scope.runId)
            .eq("sourceId", d.sourceId)
            .eq("revision", d.revision),
        )
        .unique(),
    ),
  );
  const sources = [
    ...new Map(
      retained
        .filter((d) => d !== null)
        .map((d) => [`${d.sourceId}:${d.revision}`, safeSource(d.document)]),
    ).values(),
  ];
  const bill = row.billId ? await ctx.db.get(row.billId) : null;
  const versions = bill
    ? (
        await ctx.db
          .query("demoVersions")
          .withIndex("by_run", (q) => q.eq("scope.runId", row.scope.runId))
          .collect()
      ).filter((v) => v.snapshot.bills.some((b) => b.billId === bill._id))
    : [];
  const business = await businessProjection(ctx, row, bill, versions);
  const commands = (
    await ctx.db
      .query("demoCommands")
      .withIndex("by_run", (q) => q.eq("scope.runId", row.scope.runId))
      .collect()
  ).filter((c) => versions.some((v) => v._id === c.versionId));
  const transactions = (
    await ctx.db
      .query("demoTransactions")
      .withIndex("by_run", (q) => q.eq("scope.runId", row.scope.runId))
      .collect()
  ).filter(
    (t) => t.commandRowId && commands.some((c) => c._id === t.commandRowId),
  );
  // Proven never-dispatched cancellations have no bank outcome to reconcile.
  // Preserve every historical command, and retain any canceled command with attempts or activity.
  const reconciliationCommands = commands.filter(c => !(c.execution === "cancelled" && c.attemptCount === 0 &&
    c.firstAttemptAt === undefined && !c.providerTransferId && !transactions.some(t => t.commandRowId === c._id)));
  const journalIds = [
    ...new Set(
      [bill?.entryId, business?.credit?.entryId, ...(business?.domain.creditLinks.map((l) => l.entryId as NonNullable<typeof bill>["entryId"]) ?? []), ...transactions.map((t) => t.entryId)].filter(
        (id): id is NonNullable<typeof id> => !!id,
      ),
    ),
  ];
  const journals = (
    await Promise.all(journalIds.map((id) => ctx.db.get(id)))
  ).filter((j) => j !== null);
  const latest = commands.at(-1);
  const payment = versions.at(-1);
  const evidence = (input.candidate?.evidence ?? []).map((e) => ({
    ...e,
    grounding: {
      ...e.grounding,
      processor: safeProcessor(e.grounding.processor),
    },
  }));
  const exceptions = business?.exceptions ?? evaluatePolicy(
    input,
    config.beneficiary.vendor,
    row.documentStatus === "reviewed",
  );
  const historicalPaymentHold = row.historicalPaymentHold ? historicalPaymentHoldSchema.parse(row.historicalPaymentHold) : undefined;
  if (historicalPaymentHold) exceptions.push({
    exceptionId: "historical_payment_hold", code: "historical_payment_hold",
    reason: `Historical source ${historicalPaymentHold.sourceRecordId} reports this invoice paid on ${historicalPaymentHold.paidDate} (${historicalPaymentHold.reference}). New approval and payment are blocked. No new bank settlement or journal is inferred.`,
    ownerRole: "controller", permittedActions: ["inspect_historical_payment_evidence"], requiredEvidence: [], blocking: true, status: "open", resolution: null,
  });
  if (!business && bill?.entryId && row.businessStatus !== "approved")
    exceptions.push({
      exceptionId: "posted_correction_required",
      code: "posted_correction_required",
      reason:
        "Recognized bill has new evidence; resolve through the controlled correction workflow before new payment.",
      ownerRole: "controller",
      permittedActions: ["authorized_credit_or_correction"],
      requiredEvidence: ["correction_review"],
      blocking: true,
      status: "open",
      resolution: null,
    });
  const approved = bill?.approvedCents ?? business?.credit?.amountCents ?? null;
  return {
    ...(business ? { domain: business.domain } : {}),
    ...(historicalPaymentHold ? { historicalPaymentHold } : {}),
    contractVersion: AP_CONTRACT_VERSION,
    caseId: row._id,
    runId: row.scope.runId,
    organizationId: row.scope.organizationId,
    revision: row.currentRevision,
    currentSourceBindings: input.documents.map(
      ({ sourceId, revision, sha256 }) => ({ sourceId, revision, sha256 }),
    ),
    candidate: input.candidate ? { ...input.candidate, evidence } : null,
    extraction: {
      ...input.extraction,
      evidence: input.extraction.evidence.map((e) => ({
        ...e,
        grounding: {
          ...e.grounding,
          processor: safeProcessor(e.grounding.processor),
        },
      })),
    },
    sources,
    purchasingEvidence: input.purchasingEvidence,
    decisions,
    exceptions,
    amounts: {
      invoicedCents: input.candidate?.totalCents ?? null,
      acceptedCents: approved,
      disputedCents:
        approved === null
          ? null
          : Math.max(0, (input.candidate?.totalCents ?? approved) - approved),
      creditedCents: business?.domain.appliedCreditCents ?? 0,
      instructedCents: versions
        .filter((v) => ["queued", "settled", "returned"].includes(v.status))
        .reduce(
          (sum, v) => {
            let remainingCredits = v.snapshot.credits.reduce((n, c) => n + c.amountCents, 0);
            let cash = 0;
            for (const item of v.snapshot.bills) {
              const credit = Math.min(remainingCredits, item.amountCents);
              remainingCredits -= credit;
              if (item.billId === bill?._id) cash = item.amountCents - credit;
            }
            return sum + cash;
          },
          0,
        ),
      settledCents: business?.domain.cashSettledCents ?? bill?.paidCents ?? 0,
      outstandingCents:
        approved === null ? null : business?.credit ? 0 : approved - (bill?.paidCents ?? 0),
    },
    states: {
      document: row.documentStatus,
      business: historicalPaymentHold ? "held" : row.businessStatus,
      accounting: bill?.entryId || business?.credit?.entryId ? "recognized" : "unposted",
      authorization: !payment
        ? "not_requested"
        : payment.status === "cancelled"
          ? "invalidated"
          : payment.status === "awaiting_approval"
            ? "awaiting_approval"
            : "authorized",
      execution: latest?.execution ?? "not_started",
      reconciliation:
        reconciliationCommands.length && reconciliationCommands.every((c) => c.reconciliation === "matched")
          ? "matched"
          : "unmatched",
    },
    policyVersion: business?.policyVersion ?? AP_POLICY_VERSION,
    snapshotHash: row.snapshotHash,
    scope: row.scope,
    identityMode: row.identityMode,
    payments: versions.map((v) => {
      const c = commands.find((c) => c.versionId === v._id);
      return {
        versionId: v._id,
        commandId: c?._id ?? null,
        amountCents: v.snapshot.amountCents,
        status: v.status,
        beneficiaryVersion: v.snapshot.destination.version,
        providerTransferId: c?.providerTransferId ?? null,
        authorizedBy: v.approvals.map((a) => a.subject),
      };
    }),
    journals: journals.map((j) => ({
      entryId: j._id,
      kind:
        j.source.kind === "bill"
          ? "recognition"
          : j.source.kind === "payment_settlement"
            ? "settlement"
            : j.source.kind.includes("return")
              ? "return"
              : j.source.kind.includes("credit")
                ? "credit"
                : "correction",
      date: j.date,
      lines: j.lines.map((l) => ({
        account: l.account,
        debit: l.debit,
        credit: l.credit,
      })),
      bankTransactionId:
        transactions.find((t) => t.entryId === j._id)?.transaction.id ?? null,
    })),
    links: {
      billId: bill?._id ?? null,
      billVersion: bill?.version ?? null,
      recognitionJournalId: bill?.entryId ?? business?.credit?.entryId ?? null,
      paymentVersionIds: versions.map((v) => v._id),
      commandIds: commands.map((c) => c._id),
      bankTransactionIds: transactions.map((t) => t.transaction.id),
      settlementJournalIds: transactions.flatMap((t) =>
        t.entryId ? [t.entryId] : [],
      ),
      externalAccountingIds: [],
      duplicateOfCaseId: null,
    },
    timeline: [
      ...revisions.map((r) => ({
        eventId: r._id,
        at: r.at,
        actor: r.actor,
        kind: "source_revision",
        summary: `Source case revision ${r.revision} retained`,
        references: [r.snapshotHash],
      })),
      ...deliveries.map((d) => ({
        eventId: d._id,
        at: d.at,
        actor: row.createdBy,
        kind: "source_delivery",
        summary: `Received ${d.name}`,
        references: [d.sourceId, d.sha256],
      })),
      ...decisions.map((d) => ({
        eventId: d.decisionId,
        at: d.at,
        actor: d.actor,
        kind: d.kind,
        summary: d.reason,
        references: [d.snapshotHash],
      })),
    ].sort((a, b) => a.at - b.at),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
