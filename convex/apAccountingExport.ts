import { query } from "./_generated/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import { assertRowScope, requirePaymentHuman } from "./lib/demoAuth";
import { loadRecognizedBusinessExport } from "./lib/apSystem/businessExport";
import { projectCase } from "./lib/apSystem/projection";
import { canonical, sha256Hex } from "./lib/kernel";
import { recognitionLines } from "../src/ap-system/accounting";
import { assertFrozenBankCommand } from "../src/payments/domain/validation";
import {
  assertCommandMatchesSnapshot,
  assertObservationMatchesCommand,
  assertPostingEvidence,
} from "../src/payments/domain/rules";
import type {
  AccountingExport,
  Settlement,
} from "../src/ap-system/quickbooks/types";
/** Human-authenticated export, computed in one consistent database read. No caller proof flags. */
export const current = query({
  args: {
    scope: scopeValidator,
    caseId: v.id("apCaseRecords"),
    paymentVersionId: v.optional(v.id("demoVersions")),
  },
  handler: async (ctx, args): Promise<AccountingExport> => {
    const { subject } = await requirePaymentHuman(ctx, args.scope);
    const row = await ctx.db.get(args.caseId);
    assertRowScope(row, args.scope);
    if (
      !row ||
      !row.billId ||
      row.businessStatus !== "approved" ||
      row.documentStatus !== "reviewed" ||
      !row.fieldReviewId
    )
      throw Error("Approved reviewed case required");
    const bill = await ctx.db.get(row.billId);
    assertRowScope(bill, args.scope);
    if (
      !bill ||
      !bill.entryId ||
      !bill.recordHash ||
      !bill.approvedCents ||
      !["approved", "paid"].includes(bill.status)
    )
      throw Error("Recognized bill required");
    const detail = await projectCase(ctx, row);
    const c = detail.candidate;
    const journal = await ctx.db.get(bill.entryId);
    const recognized = row.domainApprovalId
      ? await loadRecognizedBusinessExport(ctx, args.scope, row._id)
      : null;
    if (recognized && recognized.kind !== "invoice")
      throw Error("Invoice recognition required");
    if (
      !recognized &&
      (!c ||
        c.kind !== "invoice" ||
        c.supplierId !== bill.vendor ||
        bill.originalCents !== c.totalCents ||
        bill.approvedCents !== c.totalCents ||
        !journal ||
        journal.runId !== args.scope.runId ||
        journal.status !== "posted" ||
        journal.source.kind !== "bill" ||
        journal.source.ref !== bill._id ||
        canonical(
          journal.lines.map(({ account, debit, credit }) => ({
            account,
            debit,
            credit,
          })),
        ) !==
          canonical(
            recognitionLines(c).map(({ account, debit, credit }) => ({
              account,
              debit,
              credit,
            })),
          ))
    )
      throw Error("Recognition evidence mismatch");
    if (
      !recognized &&
      !detail.decisions.some(
        (d) =>
          d.kind === "bill_approval" &&
          d.outcome === "approved" &&
          d.actorKind === "human" &&
          d.snapshotHash === row.snapshotHash &&
          d.candidateRevision === row.currentRevision,
      )
    )
      throw Error("Current approved snapshot required");
    let settlement: Settlement | null = null;
    if (args.paymentVersionId) {
      const version = await ctx.db.get(args.paymentVersionId);
      assertRowScope(version, args.scope);
      if (
        !version ||
        version.status !== "settled" ||
        version.reservations !== "consumed" ||
        version.snapshot.bills.length !== 1 ||
        version.snapshot.bills[0]!.billId !== bill._id ||
        version.snapshot.credits.length !== 0 ||
        version.snapshot.bills[0]!.amountCents !== bill.approvedCents ||
        version.snapshot.amountCents !== bill.approvedCents ||
        bill.paidCents !== bill.approvedCents ||
        (await sha256Hex(canonical(version.snapshot))) !==
          version.snapshotHash ||
        !version.approvals.some((a) => a.snapshotHash === version.snapshotHash)
      )
        throw Error("Settled exact bill payment required");
      const command = await ctx.db
        .query("demoCommands")
        .withIndex("by_command", (q) =>
          q
            .eq("scope.runId", args.scope.runId)
            .eq("command.commandId", version._id),
        )
        .unique();
      assertRowScope(command, args.scope);
      if (
        !command ||
        command.versionId !== version._id ||
        command.execution !== "settled" ||
        command.posting !== "posted" ||
        command.reconciliation !== "matched" ||
        command.release ||
        command.lateTransferId ||
        !command.providerTransferId
      )
        throw Error("Matched settlement command required");
      await assertFrozenBankCommand(command.command);
      assertCommandMatchesSnapshot(
        command.command,
        version.snapshot,
        version._id,
      );
      const observed = await ctx.db
        .query("demoObservations")
        .withIndex("by_transfer", (q) =>
          q
            .eq("scope.runId", args.scope.runId)
            .eq("transferId", command.providerTransferId!),
        )
        .unique();
      assertRowScope(observed, args.scope);
      if (
        !observed ||
        observed.observation.status !== "settled" ||
        observed.observation.returnTransactionId ||
        !observed.observation.originalTransactionId
      )
        throw Error("Verified settled observation required");
      assertObservationMatchesCommand(
        command.command,
        observed.observation,
        command,
      );
      const tx = await ctx.db
        .query("demoTransactions")
        .withIndex("by_transaction", (q) =>
          q
            .eq("scope.runId", args.scope.runId)
            .eq("transaction.id", observed.observation.originalTransactionId!),
        )
        .unique();
      assertRowScope(tx, args.scope);
      if (
        !tx ||
        tx.state !== "posted" ||
        !tx.entryId ||
        tx.commandRowId !== command._id ||
        tx.transaction.purpose !== "debit" ||
        tx.transaction.amountCents >= 0
      )
        throw Error("Posted matched debit required");
      assertPostingEvidence(
        command.command,
        observed.observation,
        tx.transaction,
      );
      const related = await ctx.db
        .query("demoTransactions")
        .withIndex("by_run", (q) => q.eq("scope.runId", args.scope.runId))
        .collect();
      if (
        related.some(
          (t) =>
            (t.transaction.commandId === version._id ||
              t.transaction.transferId === command.providerTransferId) &&
            (t.transaction.purpose === "return" ||
              t.state === "exception" ||
              t.state === "unmatched"),
        )
      )
        throw Error("Unresolved or returned bank evidence");
      const posted = await ctx.db.get(tx.entryId);
      const key = `${args.scope.organizationId}:${args.scope.runId}:${args.scope.provider}:${args.scope.environment}:${args.scope.accountId}:${tx.transaction.id}:debit`;
      const amount = command.command.amountCents;
      if (
        !posted ||
        posted.runId !== args.scope.runId ||
        posted.status !== "posted" ||
        posted.source.kind !== "payment_settlement" ||
        posted.source.ref !== key ||
        posted.idempotencyKey !== key ||
        posted.date !== tx.transaction.postedAt?.slice(0, 10) ||
        canonical(
          posted.lines.map(({ account, debit, credit }) => ({
            account,
            debit,
            credit,
          })),
        ) !==
          canonical([
            { account: "2000", debit: amount, credit: 0 },
            { account: "1000", debit: 0, credit: amount },
          ])
      )
        throw Error("Settlement journal mismatch");
      settlement = {
        paymentVersionId: version._id,
        commandId: command._id,
        requestHash: command.command.requestHash,
        providerTransferId: command.providerTransferId,
        bankTransactionId: tx.transaction.id,
        journalId: posted._id,
        amountCents: amount,
        date: posted.date,
      };
    }
    return {
      version: "ap-qbo-export-v1",
      exportedAt: Date.now(),
      authorizedSubject: subject,
      detail,
      billRecordHash: bill.recordHash,
      settlement,
      ...(recognized
        ? {
            recognizedInvoice: {
              ...recognized,
              kind: "invoice" as const,
              creditId: null,
            },
          }
        : {}),
    };
  },
});
