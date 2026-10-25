import { br } from "./business-fixture";
import { creditFixture, seedSettled } from "./quickbooks-business-fixture";
import { returnedFixture } from "./quickbooks-corrections-fixture";
/** Real application mutation with synthetic originals and bank database evidence; no provider calls. */
export async function restoredCreditFixture(
  beforeReturn?: (
    f: Awaited<ReturnType<typeof creditFixture>>,
    s: Awaited<ReturnType<typeof seedSettled>>,
    c: Awaited<ReturnType<Awaited<ReturnType<typeof creditFixture>>["credit"]>>,
  ) => Promise<void>,
  amountCents = 3850,
) {
  const base = await creditFixture(),
    credit = await base.credit();
  const f = await returnedFixture(
    (f, s) => beforeReturn?.(f, s, credit) ?? Promise.resolve(),
    base,
  );
  const returned = await f.proposeCorrection();
  await f.voteCorrection(returned);
  await f.voteCorrection(returned, "finance");
  const before = await f.t.run(async (ctx) => ({
    journals: await ctx.db.query("journalEntries").collect(),
    commands: await ctx.db.query("demoCommands").collect(),
    versions: await ctx.db.query("demoVersions").collect(),
    transactions: await ctx.db.query("demoTransactions").collect(),
  }));
  const detail = (await f.load()).detail;
  const input = {
    scope: f.scope,
    caseId: f.detail.caseId,
    expectedRevision: detail.revision,
    snapshotHash: detail.snapshotHash,
    billVersion: detail.links.billVersion,
    idempotencyKey: "restored-credit-only",
    reason: "Apply recognized credit without a bank instruction",
    credits: [{ creditId: credit.creditId, amountCents }],
  };
  const applicationResult = await f.humans.finance!.mutation(
    br.applyCredits!,
    input,
  );
  const application = (await f.t.run((ctx) =>
    ctx.db.query("apCreditApplications").first(),
  ))!;
  const after = await f.t.run(async (ctx) => ({
    journals: await ctx.db.query("journalEntries").collect(),
    commands: await ctx.db.query("demoCommands").collect(),
    versions: await ctx.db.query("demoVersions").collect(),
    transactions: await ctx.db.query("demoTransactions").collect(),
  }));
  const allocationRequest = {
    kind: "credit_allocation" as const,
    caseId: f.detail.caseId,
    creditApplicationId: application._id,
    originalBillCents: amountCents - 2000,
    restoredPayables: [
      { correctionId: returned.proposalId, amountCents: 2000 },
    ],
    idempotencyKey: "restored-credit-allocation",
    reason:
      "Allocate recognized credit to exact original and restored principal",
  };
  return {
    ...f,
    credit,
    returned,
    application,
    applicationResult,
    applicationInput: input,
    beforeApplication: before,
    afterApplication: after,
    allocationRequest,
  };
}
