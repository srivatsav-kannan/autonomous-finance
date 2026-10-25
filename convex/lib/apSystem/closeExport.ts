import { CHART } from "../../../src/core/accounts";
import type { QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import type { BankScope } from "../../../src/integrations/contracts";
import {
  closeActionSchema,
  type CloseAccountingExport,
  type CloseExportRequest,
} from "../../../src/ap-system/close-contracts";
import { domainRequestSchema } from "../../../src/ap-system/domain-contracts";
import { canonical, sha256Hex } from "../kernel";
import { assertRowScope } from "../demoAuth";
import { deny } from "./shared";
import {
  assertApprovalVotes,
  requireBusinessPolicy,
  type BusinessVote,
} from "./businessAuthority";

/** Authoritative export of an approved, exact posted B4 journal. No new posting. */
export async function loadApprovedCloseExport(
  ctx: QueryCtx,
  scope: BankScope,
  request: CloseExportRequest,
): Promise<CloseAccountingExport> {
  const policy = await requireBusinessPolicy(ctx, scope);
  let action: Doc<"apCloseActions"> | null = null;
  let application: Doc<"apAccrualApplications"> | null = null;
  if (request.actionId) {
    const id = ctx.db.normalizeId("apCloseActions", request.actionId);
    action = id ? await ctx.db.get(id) : null;
    if (!action)
      deny("close_export_action", "Approved close accounting action not found");
    assertRowScope(action, scope);
    if (
      action.status !== "approved" ||
      !action.entryId ||
      !["accrual", "reverse_accrual", "adjustment"].includes(action.kind)
    )
      deny(
        "close_export_approval",
        "Only approved posted accounting actions can be exported",
      );
    if (action.kind === "reverse_accrual")
      application =
        (
          await ctx.db
            .query("apAccrualApplications")
            .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
            .collect()
        ).find((a) => a.actionId === action!._id) ?? null;
  } else {
    const id = ctx.db.normalizeId(
      "apAccrualApplications",
      request.accrualApplicationId!,
    );
    application = id ? await ctx.db.get(id) : null;
    if (!application)
      deny(
        "close_export_application",
        "Approved accrual application not found",
      );
    assertRowScope(application, scope);
    if (application.actionId) action = await ctx.db.get(application.actionId);
  }
  let authority: Doc<"apCloseActions"> | Doc<"apApprovalProposals"> | null =
    action;
  let caseId: Id<"apCaseRecords"> | null = application?.caseId ?? null;
  let billId: Id<"demoBills"> | null = application?.billId ?? null;
  let originalEntryId: Id<"journalEntries"> | null = null;
  let accrualId: Id<"apAccruals"> | null = null;
  let supplierId: string | null = null;
  let kind: CloseAccountingExport["kind"];
  let entryId: Id<"journalEntries">;
  let expected: {
    account: string;
    debit: number;
    credit: number;
    store: string | null;
    supplierId: string | null;
  }[];
  let expectedSource: { kind: string; ref: string };
  if (application) {
    const accrual = await ctx.db.get(application.accrualId);
    if (!accrual)
      deny("close_export_original", "Original accrual is unavailable");
    assertRowScope(accrual, scope);
    accrualId = accrual._id;
    originalEntryId = accrual.entryId;
    supplierId = accrual.supplierId;
    kind = "accrual_reversal";
    entryId = application.entryId;
    if (action) {
      if (
        action.status !== "approved" ||
        action.entryId !== entryId ||
        action.kind !== "reverse_accrual"
      )
        deny(
          "close_export_approval",
          "Reversal action does not bind this application",
        );
    } else {
      const bill = billId ? await ctx.db.get(billId) : null;
      if (!bill?.entryId || !caseId)
        deny(
          "close_export_approval",
          "Invoice accrual application lacks its recognized bill/case approval",
        );
      assertRowScope(bill, scope);
      const approvals = await ctx.db
        .query("apApprovalProposals")
        .withIndex("by_case", (q) =>
          q.eq("scope.runId", scope.runId).eq("caseId", caseId!),
        )
        .collect();
      authority =
        approvals.find(
          (a) =>
            a.status === "approved" &&
            a.entryId === bill.entryId &&
            domainRequestSchema
              .parse(a.request)
              .accrualApplications?.some(
                (x) =>
                  x.accrualId === accrual._id &&
                  x.quantity === application!.quantity,
              ),
        ) ?? null;
      if (!authority)
        deny(
          "close_export_approval",
          "No approved immutable invoice plan binds this exact accrual reversal",
        );
    }
    expected = [
      {
        account: "2010",
        debit: application.amountCents,
        credit: 0,
        store: null,
        supplierId,
      },
      ...application.allocations
        .filter((a: { amountCents: number }) => a.amountCents > 0)
        .map(
          (a: {
            account: string;
            amountCents: number;
            store: string | null;
          }) => ({
            account: a.account,
            debit: 0,
            credit: a.amountCents,
            store: a.store,
            supplierId,
          }),
        ),
    ];
    expectedSource = { kind: "ap_accrual_reversal", ref: accrual._id };
  } else if (action) {
    const payload = closeActionSchema.parse(action.payload);
    entryId = action.entryId!;
    if (payload.kind === "accrual") {
      const accrual = (
        await ctx.db
          .query("apAccruals")
          .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
          .collect()
      ).find((a) => a.actionId === action!._id);
      if (!accrual || accrual.entryId !== entryId)
        deny(
          "close_export_original",
          "Approved accrual does not bind its original journal",
        );
      accrualId = accrual._id;
      supplierId = payload.accrual.supplierId;
      caseId = accrual.expectedInvoiceCaseId ?? null;
      kind = "accrual";
      expected = [
        ...payload.accrual.allocations
          .filter((a) => a.amountCents > 0)
          .map((a) => ({
            account: a.account,
            debit: a.amountCents,
            credit: 0,
            store: a.store,
            supplierId,
          })),
        {
          account: "2010",
          debit: 0,
          credit: action.amountCents,
          store: null,
          supplierId,
        },
      ];
      expectedSource = { kind: "ap_accrual", ref: action._id };
    } else if (payload.kind === "adjustment") {
      const originalId = ctx.db.normalizeId(
        "journalEntries",
        payload.originalEntryId,
      );
      const original = originalId ? await ctx.db.get(originalId) : null;
      if (!original || original.runId !== scope.runId)
        deny(
          "close_export_original",
          "Original correction journal is unavailable",
        );
      originalEntryId = original._id;
      const costLines = original.lines.filter((l) => {
        const a = CHART.find((a) => a.code === l.account);
        return a && !a.cash && ["asset", "expense"].includes(a.type);
      });
      const suppliers = new Set(costLines.map((l) => l.dims?.vendor ?? null));
      if (suppliers.size !== 1)
        deny(
          "close_export_original",
          "Original correction supplier is ambiguous",
        );
      supplierId = [...suppliers][0]!;
      kind = "cost_reclassification";
      const bill = (
        await ctx.db
          .query("demoBills")
          .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
          .collect()
      ).find((b) => b.entryId === original._id);
      billId = bill?._id ?? null;
      if (billId) {
        const row = await ctx.db
          .query("apCaseRecords")
          .withIndex("by_bill", (q) =>
            q.eq("scope.runId", scope.runId).eq("billId", billId!),
          )
          .unique();
        caseId = row?._id ?? null;
      }
      expected = [
        {
          account: payload.toAccount,
          debit: payload.amountCents,
          credit: 0,
          store: payload.store,
          supplierId,
        },
        {
          account: payload.fromAccount,
          debit: 0,
          credit: payload.amountCents,
          store: payload.store,
          supplierId,
        },
      ];
      expectedSource = { kind: "ap_cost_adjustment", ref: original._id };
    } else
      deny(
        "close_export_kind",
        "This action has no independent exportable journal",
      );
  } else
    deny(
      "close_export_approval",
      "Accounting export requires an immutable source approval",
    );
  if (
    !authority ||
    authority.status !== "approved" ||
    !authority.completedAt ||
    authority.policyHash !== policy.hash
  )
    deny(
      "close_export_authority",
      "Current approved policy and retained accounting authority required; no automatic rebooking or approval inference",
    );
  const approvalPayload = action
    ? {
        action: action.payload,
        policyHash: action.policyHash,
        contextHash: action.contextHash,
        amountCents: action.amountCents,
        route: action.route,
      }
    : {
        request: (authority as Doc<"apApprovalProposals">).request,
        policyHash: authority.policyHash,
        supplierHash: (authority as Doc<"apApprovalProposals">).supplierHash,
        amountCents: authority.amountCents,
        route: authority.route,
      };
  if ((await sha256Hex(canonical(approvalPayload))) !== authority.hash)
    deny(
      "close_export_approval",
      "Retained accounting approval payload does not match its immutable hash",
    );
  assertRowScope(authority, scope);
  await assertApprovalVotes(ctx, scope, policy.value, authority);
  const journal = await ctx.db.get(entryId);
  if (
    !journal ||
    journal.runId !== scope.runId ||
    journal.status !== "posted" ||
    journal.source.kind !== expectedSource.kind ||
    journal.source.ref !== expectedSource.ref
  )
    deny(
      "close_export_journal",
      "Exact posted journal and source binding required",
    );
  const journalHash = await sha256Hex(
    journal.prevHash +
      canonical({
        sequence: journal.sequence,
        date: journal.date,
        memo: journal.memo,
        source: journal.source,
        lines: journal.lines,
        postedBy: journal.postedBy,
        decisionPath: journal.decisionPath,
        memorySha: journal.memorySha,
      }),
  );
  if (journalHash !== journal.hash)
    deny(
      "close_export_journal",
      "Journal content no longer matches its original ledger hash",
    );
  const lines = journal.lines.map((l) => ({
    account: l.account,
    debit: l.debit,
    credit: l.credit,
    store: l.dims?.store ?? null,
    supplierId: l.dims?.vendor ?? null,
  }));
  if (
    canonical(lines) !== canonical(expected) ||
    journal.lines.some((l) =>
      Object.keys(l.dims ?? {}).some((k) => !["vendor", "store"].includes(k)),
    )
  )
    deny(
      "close_export_journal",
      "Posted journal differs from original approved exact allocations or has unsupported dimensions",
    );
  const amountCents = lines.reduce((n, l) => n + l.debit, 0);
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents !== lines.reduce((n, l) => n + l.credit, 0)
  )
    deny(
      "close_export_journal",
      "Export journal must balance in exact positive cents",
    );
  return {
    version: "ap-close-accounting-v1",
    exportId: `${kind}:${journal._id}`,
    kind,
    actionId: action?._id ?? null,
    accrualApplicationId: application?._id ?? null,
    caseId,
    billId,
    accrualId,
    originalEntryId,
    supplierId,
    amountCents,
    approval: {
      id: authority._id,
      kind: action ? "close" : "business",
      hash: authority.hash,
      policyHash: authority.policyHash,
      approvedAt: authority.completedAt,
      votes: authority.votes as BusinessVote[],
    },
    journal: {
      id: journal._id,
      hash: journal.hash,
      date: journal.date,
      memo: journal.memo,
      source: expectedSource,
      lines,
    },
  };
}
