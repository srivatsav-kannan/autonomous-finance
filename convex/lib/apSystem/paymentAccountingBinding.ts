import type { QueryCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import type {
  BankScope,
  PaymentSnapshot,
} from "../../../src/payments/contracts";
import {
  assertCommandAccountingBinding,
  assertAccountingBindingCoverage,
  type PaymentAccountingBinding,
  type BindingSnapshot,
} from "../../../src/payments/domain/accounting-binding";
import {
  loadRecognizedBusinessExport,
  type RecognizedBusinessExport,
} from "./businessExport";
import { assertRowScope } from "../demoAuth";
import { canonical, sha256Hex } from "../kernel";
import { deny } from "./shared";
/** Historical recognition only; current authority is checked separately before requesting/authorizing new money. */
export async function derivePaymentAccountingBinding(
  ctx: QueryCtx,
  scope: BankScope,
  bills: readonly { billId: string; amountCents: number }[],
  credits: readonly { creditId: string; amountCents: number }[],
): Promise<PaymentAccountingBinding | undefined> {
  const br: Array<{
      r: RecognizedBusinessExport | null;
      billId: string;
      amountCents: number;
    }> = [],
    cr: Array<{
      r: RecognizedBusinessExport | null;
      creditId: string;
      amountCents: number;
    }> = [];
  for (const b of bills) {
    const id = ctx.db.normalizeId("demoBills", b.billId);
    if (!id) throw Error("binding_bill_id");
    const row = await ctx.db
      .query("apCaseRecords")
      .withIndex("by_bill", (q) =>
        q.eq("scope.runId", scope.runId).eq("billId", id),
      )
      .unique();
    const r = row?.domainApprovalId
      ? await loadRecognizedBusinessExport(ctx, scope, row._id)
      : null;
    if (
      r &&
      (r.kind !== "invoice" ||
        r.billId !== b.billId ||
        b.amountCents > r.amountCents)
    )
      throw Error("binding_bill_recognition");
    br.push({ ...b, r });
  }
  for (const c of credits) {
    const id = ctx.db.normalizeId("demoCredits", c.creditId);
    if (!id) throw Error("binding_credit_id");
    const link = await ctx.db
      .query("apCreditLinks")
      .withIndex("by_credit", (q) =>
        q.eq("scope.runId", scope.runId).eq("creditId", id),
      )
      .unique();
    const r = link
      ? await loadRecognizedBusinessExport(ctx, scope, link.caseId)
      : null;
    if (
      r &&
      (r.kind !== "credit" ||
        r.creditId !== c.creditId ||
        c.amountCents > r.amountCents)
    )
      throw Error("binding_credit_recognition");
    cr.push({ ...c, r });
  }
  br.sort((a, b) => a.billId.localeCompare(b.billId));
  cr.sort((a, b) => a.creditId.localeCompare(b.creditId));
  const all = [...br, ...cr];
  if (!all.some((x) => x.r?.settlementAuthority)) return undefined;
  if (all.some((x) => !x.r?.settlementAuthority))
    deny(
      "mixed_settlement_scope",
      "Settlement cannot mix legacy/cost-only and governed payable scopes",
    );
  const recognized = all.map((x) => x.r!);
  const department = recognized[0]!.settlementAuthority!.department;
  if (
    recognized.some(
      (r) =>
        r.settlementAuthority!.department !== department ||
        r.supplierId !== recognized[0]!.supplierId,
    )
  )
    deny(
      "mixed_settlement_department",
      "Settlement must preserve one department and supplier across exact bill/credit authority",
    );
  const authority = async (
    r: RecognizedBusinessExport,
    amountCents: number,
  ) => ({
    recognitionEntryId: r.journalId,
    approvalId: r.approvalId,
    approvalHash: r.settlementAuthority!.approvalHash,
    policyHash: r.settlementAuthority!.policyHash,
    accountingAuthorityHash: await sha256Hex(
      canonical({
        caseId: r.caseId,
        billId: r.billId,
        creditId: r.creditId,
        supplierId: r.supplierId,
        currency: "USD",
        amountCents: r.amountCents,
        settlementAuthority: r.settlementAuthority,
      }),
    ),
    appliedCents: amountCents,
  });
  const result: PaymentAccountingBinding = {
    version: "ap-payment-accounting-v1",
    mode: "department_as_location",
    department,
    bills: await Promise.all(
      br.map(async (b) => ({
        billId: b.billId,
        ...(await authority(b.r!, b.amountCents)),
      })),
    ),
    credits: await Promise.all(
      cr.map(async (c) => ({
        creditId: c.creditId,
        ...(await authority(c.r!, c.amountCents)),
      })),
    ),
  };
  assertAccountingBindingCoverage({
    bills,
    credits,
    accountingBinding: result,
  });
  return result;
}
export async function assertPaymentAccountingBinding(
  ctx: QueryCtx,
  scope: BankScope,
  snapshot: BindingSnapshot,
) {
  assertAccountingBindingCoverage(snapshot);
  const expected = await derivePaymentAccountingBinding(
    ctx,
    scope,
    snapshot.bills,
    snapshot.credits,
  );
  if (
    canonical(snapshot.accountingBinding ?? null) !==
    canonical(expected ?? null)
  )
    deny(
      "accounting_binding_authority_changed",
      "Frozen settlement binding differs from its original recognition authority",
    );
}
export async function assertFrozenPaymentAccounting(
  ctx: QueryCtx,
  scope: BankScope,
  version: Doc<"demoVersions">,
  command: Doc<"demoCommands">,
) {
  assertRowScope(version, scope);
  assertRowScope(command, scope);
  if (
    command.versionId !== version._id ||
    (await sha256Hex(canonical(version.snapshot))) !== version.snapshotHash
  )
    throw Error("accounting_snapshot_changed");
  await assertCommandAccountingBinding(version.snapshot, command.command);
}

/** New dimension-bearing journal proofs must retain the exact append-only journal hash. */
export async function assertAccountingJournalHash(
  journal: Doc<"journalEntries">,
) {
  const value = await sha256Hex(
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
  if (value !== journal.hash) throw Error("accounting_journal_hash_changed");
}
