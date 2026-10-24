import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoFixture } from "../demo-fixture";
import { openFakeBank, type FakeFault } from "../../src/integrations/banking/fake";
import type { BankCommand, BankingProvider, BankScope } from "../../src/integrations/contracts";

/** Test-only owner of simulator controls; workers receive only the provider. */
export async function recoveryFixture(faults: FakeFault[] = []) {
  const fixture = await demoFixture("payment-independent-recovery");
  const directory = mkdtempSync(join(tmpdir(), "payment-independent-"));
  const path = join(directory, "bank.sqlite");
  const options = { path, scope: fixture.scope, seed: 59, startTime: "2026-10-23T12:00:00.000Z" };
  let bank = openFakeBank({ ...options, faults });
  const calls: { operation: string; command?: BankCommand; scope?: BankScope; id?: string }[] = [];
  // Copy at the boundary so later mutation cannot rewrite the test's history.
  const provider: BankingProvider = {
    createTransfer: command => {
      calls.push({ operation: "createTransfer", command: structuredClone(command) });
      return bank.provider.createTransfer(command);
    },
    getTransfer: (scope, id) => {
      calls.push({ operation: "getTransfer", scope: structuredClone(scope), id });
      return bank.provider.getTransfer(scope, id);
    },
    getTransaction: (scope, id) => {
      calls.push({ operation: "getTransaction", scope: structuredClone(scope), id });
      return bank.provider.getTransaction(scope, id);
    },
    getBalance: scope => bank.provider.getBalance(scope),
    listTransactions: (scope, page) => bank.provider.listTransactions(scope, page),
  };
  const state = () => fixture.t.run(async ctx => ({
    commands: await ctx.db.query("demoCommands").collect(),
    versions: await ctx.db.query("demoVersions").collect(),
    bills: await ctx.db.query("demoBills").collect(),
    credits: await ctx.db.query("demoCredits").collect(),
    transactions: await ctx.db.query("demoTransactions").collect(),
    observations: await ctx.db.query("demoObservations").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
    balances: await ctx.db.query("balances").collect(),
    heads: await ctx.db.query("ledgerHeads").collect(),
  }));
  return {
    ...fixture, provider, calls, state,
    get bank() { return bank; },
    restartBank() { bank.close(); bank = openFakeBank(options); },
    dispose() { bank.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
