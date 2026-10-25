import type { QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import type { BankScope } from "../../../src/integrations/contracts";
import type {
  BankReturnEvidence,
  Settlement,
} from "../../../src/ap-system/quickbooks/types";
import { assertRowScope } from "../demoAuth";
import { canonical, sha256Hex } from "../kernel";
import { caseRow, deny } from "./shared";
import { loadRecognizedBusinessExport } from "./businessExport";
import { appliedCredits } from "./accountingCredits";
import { assertFrozenBankCommand } from "../../../src/payments/domain/validation";
import {
  assertCommandMatchesSnapshot,
  assertObservationMatchesCommand,
  assertPostingEvidence,
  safeSumCents,
} from "../../../src/payments/domain/rules";
export async function openPeriod(
  ctx: QueryCtx,
  scope: BankScope,
  date: string,
) {
  const period = await ctx.db
    .query("periods")
    .withIndex("by_run_period", (q) =>
      q.eq("runId", scope.runId).eq("period", date.slice(0, 7)),
    )
    .unique();
  if (!period || period.status !== "open")
    deny(
      "accounting_period_closed",
      "Correction replication needs an explicitly open accounting period",
    );
}
export async function paymentEvidence(
  ctx: QueryCtx,
  scope: BankScope,
  caseId: string,
  versionId: string,
  mode: "settled" | "returned",
) {
  if (scope.provider !== "increase" || scope.environment !== "sandbox")
    deny(
      "increase_sandbox_required",
      "Verified Increase sandbox bank evidence is required",
    );
  const row = await caseRow(ctx, scope, caseId);
  if (!row.billId)
    deny("recognized_bill_required", "Correction must link a recognized bill");
  const recognized = await loadRecognizedBusinessExport(ctx, scope, caseId);
  if (recognized.kind !== "invoice")
    deny("invoice_required", "Invoice recognition required");
  const bill = await ctx.db.get(row.billId);
  assertRowScope(bill, scope);
  if (!bill) throw Error("bill");
  const id = ctx.db.normalizeId("demoVersions", versionId);
  const version = id ? await ctx.db.get(id) : null;
  assertRowScope(version, scope);
  if (
    !version ||
    version.status !== mode ||
    version.reservations !== "consumed" ||
    version.snapshot.bills.length !== 1 ||
    version.snapshot.bills[0]!.billId !== bill._id ||
    version.snapshot.amountCents <= 0 ||
    version.snapshot.bills[0]!.amountCents > recognized.amountCents ||
    safeSumCents([
      version.snapshot.amountCents,
      ...version.snapshot.credits.map((c) => c.amountCents),
    ]) !== version.snapshot.bills[0]!.amountCents ||
    (await sha256Hex(canonical(version.snapshot))) !== version.snapshotHash ||
    !version.approvals.some((a) => a.snapshotHash === version.snapshotHash)
  )
    deny(
      "bank_payment_evidence",
      "Exact consumed single-bill payment evidence required",
    );
  const command = await ctx.db
    .query("demoCommands")
    .withIndex("by_command", (q) =>
      q.eq("scope.runId", scope.runId).eq("command.commandId", version._id),
    )
    .unique();
  assertRowScope(command, scope);
  if (
    !command ||
    command.versionId !== version._id ||
    command.execution !== mode ||
    command.posting !== (mode === "settled" ? "posted" : "returned") ||
    command.reconciliation !== "matched" ||
    command.release ||
    command.lateTransferId ||
    !command.providerTransferId
  )
    deny("bank_command_evidence", "Matched immutable bank command required");
  await assertFrozenBankCommand(command.command);
  assertCommandMatchesSnapshot(command.command, version.snapshot, version._id);
  const observation = await ctx.db
    .query("demoObservations")
    .withIndex("by_transfer", (q) =>
      q
        .eq("scope.runId", scope.runId)
        .eq("transferId", command.providerTransferId!),
    )
    .unique();
  assertRowScope(observation, scope);
  if (
    !observation ||
    observation.observation.status !== mode ||
    !observation.observation.originalTransactionId ||
    (mode === "settled" && observation.observation.returnTransactionId)
  )
    deny(
      "bank_observation_evidence",
      "Exact verified bank observation required",
    );
  assertObservationMatchesCommand(
    command.command,
    observation.observation,
    command,
  );
  const debit = await ctx.db
    .query("demoTransactions")
    .withIndex("by_transaction", (q) =>
      q
        .eq("scope.runId", scope.runId)
        .eq("transaction.id", observation.observation.originalTransactionId!),
    )
    .unique();
  assertRowScope(debit, scope);
  if (
    !debit ||
    debit.state !== "posted" ||
    !debit.entryId ||
    debit.commandRowId !== command._id ||
    debit.transaction.purpose !== "debit" ||
    debit.transaction.amountCents >= 0
  )
    deny("posted_debit_required", "Original matched posted debit required");
  assertPostingEvidence(
    command.command,
    observation.observation,
    debit.transaction,
  );
  const amount = command.command.amountCents;
  const checkJournal = async (
    tx: Doc<"demoTransactions">,
    returning: boolean,
  ) => {
    const j = tx.entryId ? await ctx.db.get(tx.entryId) : null;
    const key = `${scope.organizationId}:${scope.runId}:${scope.provider}:${scope.environment}:${scope.accountId}:${tx.transaction.id}:${returning ? "return" : "debit"}`;
    const expected = returning
      ? [
          { account: "1000", debit: amount, credit: 0 },
          { account: "2000", debit: 0, credit: amount },
        ]
      : [
          { account: "2000", debit: amount, credit: 0 },
          { account: "1000", debit: 0, credit: amount },
        ];
    if (
      !j ||
      j.runId !== scope.runId ||
      j.status !== "posted" ||
      j.source.kind !== "payment_settlement" ||
      j.source.ref !== key ||
      j.idempotencyKey !== key ||
      j.date !== tx.transaction.postedAt?.slice(0, 10) ||
      canonical(
        j.lines.map(({ account, debit, credit }) => ({
          account,
          debit,
          credit,
        })),
      ) !== canonical(expected)
    )
      deny("bank_journal_mismatch", "Exact posted bank journal required");
    return j;
  };
  const journal = await checkJournal(debit, false);
  const settlement: Settlement = {
    paymentVersionId: version._id,
    commandId: command._id,
    requestHash: command.command.requestHash,
    bankTransactionId: debit.transaction.id,
    providerTransferId: command.providerTransferId,
    journalId: journal._id,
    amountCents: amount,
    date: journal.date,
    grossAppliedCents: version.snapshot.bills[0]!.amountCents,
    credits: await appliedCredits(
      ctx,
      scope,
      bill.vendor,
      version.snapshot.credits,
    ),
  };
  const related = (
    await ctx.db
      .query("demoTransactions")
      .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
      .collect()
  ).filter(
    (t) =>
      t.commandRowId === command._id ||
      t.transaction.commandId === version._id ||
      t.transaction.transferId === command.providerTransferId,
  );
  for (const t of related) {
    assertRowScope(t, scope);
    if (
      t.state !== "posted" ||
      !t.entryId ||
      !["debit", "return"].includes(t.transaction.purpose)
    )
      deny(
        "bank_evidence_unresolved",
        "Unresolved related bank evidence blocks correction",
      );
  }
  if (related.filter((t) => t.transaction.purpose === "debit").length !== 1)
    deny("bank_evidence_ambiguous", "Exactly one original debit required");
  if (mode === "settled") {
    if (related.some((t) => t.transaction.purpose === "return"))
      deny("returned_payment", "Payment has returned evidence");
    return {
      row,
      bill,
      recognized,
      version,
      command,
      settlement,
      returned: null,
    };
  }
  const returns = related.filter((t) => t.transaction.purpose === "return");
  if (returns.length !== 1)
    deny(
      "bank_return_ambiguous",
      "Exactly one verified posted return required",
    );
  const returned = returns[0]!;
  if (
    returned.transaction.amountCents !== amount ||
    returned.transaction.originalTransactionId !== debit.transaction.id ||
    observation.observation.returnTransactionId !== returned.transaction.id ||
    returned.commandRowId !== command._id
  )
    deny(
      "bank_return_mismatch",
      "Positive return must bind original debit and command",
    );
  assertPostingEvidence(
    command.command,
    observation.observation,
    returned.transaction,
    { transaction: debit.transaction, entryId: debit.entryId },
  );
  const rj = await checkJournal(returned, true);
  await openPeriod(ctx, scope, rj.date);
  const evidence: BankReturnEvidence = {
    kind: "bank_return",
    caseId: row._id,
    billId: bill._id,
    supplierId: bill.vendor,
    recognitionJournalId: recognized.journalId,
    amountCents: amount,
    currency: "USD",
    date: rj.date,
    bankAccount: "1000",
    apAccount: "2000",
    original: settlement,
    originalJournalHash: journal.hash,
    returnTransactionId: returned.transaction.id,
    returnTransactionRowId: returned._id,
    observationId: observation._id,
    returnJournalId: rj._id,
    returnJournalHash: rj.hash,
  };
  return {
    row,
    bill,
    recognized,
    version,
    command,
    settlement,
    returned: evidence,
  };
}
