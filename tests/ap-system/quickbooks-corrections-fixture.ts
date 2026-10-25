import { makeFunctionReference } from "convex/server";
import { creditFixture, seedSettled } from "./quickbooks-business-fixture";
export const correctionRefs = {
  propose: makeFunctionReference<"mutation">("apAccountingCorrections:propose"),
  vote: makeFunctionReference<"mutation">("apAccountingCorrections:vote"),
  current: makeFunctionReference<"query">("apAccountingCorrections:current"),
  proposals: makeFunctionReference<"query">(
    "apAccountingCorrections:proposals",
  ),
};
/** Test-owned bank database evidence, not a bank simulation or real posting claim. */
export async function returnedFixture(
  beforeReturn?: (
    f: Awaited<ReturnType<typeof creditFixture>>,
    s: Awaited<ReturnType<typeof seedSettled>>,
  ) => Promise<void>,
  initial?: Awaited<ReturnType<typeof creditFixture>>,
) {
  const f = initial ?? (await creditFixture());
  const s = await seedSettled(f, 2000, 2000);
  await beforeReturn?.(f, s);
  const ids = await f.t.run(async (ctx) => {
    const debit = (await ctx.db.query("demoTransactions").first())!;
    const j = (await ctx.db.get(debit.entryId!))!;
    const { _id, _creationTime, ...base } = j;
    const transactionId = "tx-return-business";
    const key = `${s.scope.organizationId}:${s.scope.runId}:${s.scope.provider}:${s.scope.environment}:${s.scope.accountId}:${transactionId}:return`;
    const entryId = await ctx.db.insert("journalEntries", {
      ...base,
      source: { kind: "payment_settlement", ref: key },
      idempotencyKey: key,
      sequence: 100,
      hash: "c".repeat(64),
      lines: [
        { account: "1000", debit: 2000, credit: 0 },
        { account: "2000", debit: 0, credit: 2000 },
      ],
    });
    const txId = await ctx.db.insert("demoTransactions", {
      scope: s.scope,
      commandRowId: s.commandId,
      entryId,
      state: "posted",
      transaction: {
        ...debit.transaction,
        id: transactionId,
        purpose: "return",
        amountCents: 2000,
        originalTransactionId: debit.transaction.id,
      },
      importedAt: 2,
      matchedAt: 2,
    });
    const observation = (await ctx.db.query("demoObservations").first())!;
    await ctx.db.patch(observation._id, {
      observation: {
        ...observation.observation,
        status: "returned",
        returnTransactionId: transactionId,
      },
    });
    await ctx.db.patch(s.commandId, {
      execution: "returned",
      posting: "returned",
    });
    await ctx.db.patch(s.versionId, { status: "returned" });
    await ctx.db.patch(f.original.billId, { paidCents: 0, status: "approved" });
    return { entryId, txId, transactionId, debitId: debit._id };
  });
  const request = {
    kind: "bank_return" as const,
    caseId: f.detail.caseId,
    paymentVersionId: s.versionId,
    returnTransactionId: ids.transactionId,
    idempotencyKey: "return-correction",
    reason:
      "Replicate verified returned cash without changing original payment",
  };
  const propose = (input: any = request) =>
    f.t.mutation(correctionRefs.propose, {
      scope: s.scope,
      seatId: "controller",
      token: "token-controller",
      input,
    });
  const vote = (
    p: { proposalId: string; proposalHash: string },
    name = "owner",
    extra: Record<string, unknown> = {},
  ) =>
    f.humans[name]!.mutation(correctionRefs.vote, {
      scope: s.scope,
      input: {
        ...p,
        idempotencyKey: `vote-${p.proposalId}-${name}`,
        outcome: "approved",
        reason: "Verified exact bank and journal binding",
        ...extra,
      },
    });
  const current = (id: string) =>
    f.humans.finance!.query(correctionRefs.current, {
      scope: s.scope,
      correctionId: id,
    });
  return {
    ...f,
    ...s,
    ...ids,
    request,
    proposeCorrection: propose,
    voteCorrection: vote,
    currentCorrection: current,
  };
}
