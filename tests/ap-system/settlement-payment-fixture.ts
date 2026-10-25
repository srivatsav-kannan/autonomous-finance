import { vi } from "vitest";
import { api } from "../demo-fixture";
import { creditFixture, promoteIncrease } from "./quickbooks-business-fixture";
import {
  PAYMENT_EXECUTOR_VERSION,
  type TransferObservation,
  type BankTransaction,
} from "../../src/payments/contracts";
import {
  saveObservation,
  saveTransaction,
  postVerifiedTransaction,
} from "../../convex/lib/payments/applyObservation";
import type { Id } from "../../convex/_generated/dataModel";
export async function boundPayment(legacy = false, increase = false) {
  const originalFixture = await creditFixture(0, {
    department: "ops",
    scope: legacy ? "cost_allocations" : "cost_and_settlement",
  });
  const credit = await originalFixture.credit();
  const f = increase
    ? { ...originalFixture, ...(await promoteIncrease(originalFixture)) }
    : originalFixture;
  if (increase) vi.stubEnv("AP_BANK_SCOPE", JSON.stringify(f.scope));
  const args = {
    scope: f.scope,
    seatId: "payments",
    token: "token-payments",
    requestKey: "dimension-payment",
    billIds: [f.original.billId as Id<"demoBills">],
    billAmounts: [
      { billId: f.original.billId as Id<"demoBills">, amountCents: 3000 },
    ],
    credits: [{ creditId: credit.creditId, amountCents: 1000 }],
  };
  const request = await f.t.mutation(api.demoPayments.requestPayment, args);
  const approved = await f.payer.mutation(api.demoPayments.approveAndQueue,
    { scope: f.scope, ...request },
  );
  const claim = (key = "dimension-lease-first") =>
    f.t.mutation(api.demoPayments.claim, {
      scope: f.scope,
      token: "test-dispatch",
      paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
      workerId: "dimension-worker",
      leaseToken: key,
    });
  const postCommand = async (
    commandId: Id<"demoCommands">,
    suffix = "",
    returning = false,
  ) => {
    const cmd = (await f.t.run((ctx) => ctx.db.get(commandId)))!.command;
    const observation: TransferObservation = {
      id: `dimension-transfer${suffix}`,
      scope: f.scope,
      commandId: cmd.commandId,
      requestHash: cmd.requestHash,
      idempotencyKey: cmd.idempotencyKey,
      amountCents: cmd.amountCents,
      currency: "USD",
      destination: cmd.destination,
      status: returning ? "returned" : "settled",
      createdAt: "2026-10-25T12:00:00Z",
      updatedAt: "2026-10-25T12:00:00Z",
      originalTransactionId: `dimension-debit${suffix}`,
      ...(returning
        ? { returnTransactionId: `dimension-return${suffix}` }
        : {}),
    };
    const transaction: BankTransaction = {
      id: returning ? `dimension-return${suffix}` : `dimension-debit${suffix}`,
      scope: f.scope,
      transferId: observation.id,
      commandId: cmd.commandId,
      amountCents: returning ? cmd.amountCents : -cmd.amountCents,
      currency: "USD",
      status: "posted",
      purpose: returning ? "return" : "debit",
      createdAt: observation.createdAt,
      postedAt: observation.createdAt,
      ...(returning
        ? { originalTransactionId: `dimension-debit${suffix}` }
        : {}),
    };
    await f.t.run(async (ctx) => {
      await saveObservation(ctx, f.scope, observation);
      await saveTransaction(ctx, f.scope, transaction);
    });
    return f.t.run((ctx) =>
      postVerifiedTransaction(ctx, {
        scope: f.scope,
        token: "test-evidence",
        transactionId: transaction.id,
      }),
    );
  };
  return {
    ...f,
    credit,
    args,
    request,
    approved,
    claim,
    post: (returning = false) => postCommand(approved.commandId, "", returning),
    postCommand,
  };
}
