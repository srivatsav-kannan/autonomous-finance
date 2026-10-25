import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, it, expect, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { fixture, refs } from "./accounting-fixture";
import {
  commandRequestHash,
  buildIncreaseRequestBody,
} from "../../src/integrations/contracts";
import { canonical, sha256Hex } from "../../convex/lib/kernel";
import {
  billPlan,
  paymentPlan,
  creditPlan,
} from "../../src/ap-system/quickbooks/plans";
import { hash } from "../../src/ap-system/quickbooks/private-store";
import { QuickBooksDispatcher } from "../../src/ap-system/quickbooks/sync";
import type {
  AccountingExport,
  Mappings,
  Operation,
} from "../../src/ap-system/quickbooks/types";
import type { Id } from "../../convex/_generated/dataModel";
const current = makeFunctionReference<"query">("apAccountingExport:current");
const mappings: Mappings = {
  version: "reviewed-1",
  realmId: "123",
  country: "US",
  vendors: {
    "golden-state-produce": {
      id: "5",
      displayName: "Golden State Produce Co.",
    },
  },
  accounts: {
    "2000": { id: "33", name: "AP", type: "Accounts Payable" },
    "1000": { id: "35", name: "Bank", type: "Bank" },
    "5000": { id: "7", name: "Produce", type: "Expense" },
  },
  apAccount: "2000",
  bankAccount: "1000",
};
afterEach(() => vi.unstubAllEnvs());
async function approved() {
  const f = await fixture();
  const d = await f.reviewed();
  await f.human.mutation(refs.approve, {
    scope: f.scope,
    input: { ...f.request(d, "bill"), acceptedCents: 7700 },
  });
  return {
    ...f,
    caseId: d.caseId as Id<"apCaseRecords">,
    load: () =>
      f.human.query(current, {
        scope: f.scope,
        caseId: d.caseId,
      }) as Promise<AccountingExport>,
  };
}
function successful(e: AccountingExport): Operation {
  const p = billPlan(e, mappings);
  return {
    ...p,
    requestId: "request-1",
    payloadHash: hash(p),
    state: "succeeded",
    createdAt: 1,
    updatedAt: 1,
    attempts: 1,
    externalId: "90",
    syncToken: "0",
    lastError: null,
    responseHash: "a".repeat(64),
  };
}
async function settled() {
  const f = await approved();
  const scope = {
    ...f.scope,
    provider: "increase" as const,
    environment: "sandbox" as const,
  };
  const seeded = await f.t.run(async (ctx) => {
    for (const table of [
      "demoConfigs",
      "apCaseRecords",
      "apCaseRevisions",
      "apCaseSources",
      "apCaseDeliveries",
      "apCaseDecisions",
      "apCaseOperations",
      "demoBills",
    ] as const) {
      for (const row of await ctx.db.query(table).collect())
        await ctx.db.patch(row._id, { scope });
    }
    await ctx.db.patch(f.caseId, { identityMode: "authenticated_human" });
    const ap = (await ctx.db.get(f.caseId))!;
    const bill = (await ctx.db.get(ap.billId!))!;
    const snapshot = {
      scope,
      bills: [{ billId: bill._id, version: bill.version, amountCents: 7700 }],
      credits: [],
      amountCents: 7700,
      currency: "USD" as const,
      destination: { externalAccountId: "beneficiary", version: "v1" },
      policyVersion: "ap-policy-v1",
    };
    const snapshotHash = await sha256Hex(canonical(snapshot));
    const versionId = await ctx.db.insert("demoVersions", {
      scope,
      snapshot,
      snapshotHash,
      requestedBy: "payments",
      requestKey: "qbo-settled",
      status: "settled",
      approvals: [
        {
          seatId: "human_cfo",
          subject: f.identity.tokenIdentifier,
          kind: "human",
          snapshotHash,
          at: 1,
        },
      ],
      reservations: "consumed",
      createdAt: 1,
    });
    const command = {
      commandId: versionId,
      scope,
      amountCents: 7700,
      currency: "USD" as const,
      destination: snapshot.destination,
      approvalVersion: versionId,
      idempotencyKey: `demo:${versionId}`,
      providerRequest: buildIncreaseRequestBody({
        commandId: versionId,
        scope,
        amountCents: 7700,
        destination: snapshot.destination,
      }),
      requestHash: "",
    };
    command.requestHash = await commandRequestHash(command);
    const commandId = await ctx.db.insert("demoCommands", {
      scope,
      command,
      versionId,
      execution: "settled",
      posting: "posted",
      reconciliation: "matched",
      generation: 1,
      attemptCount: 1,
      nextAttemptAt: 0,
      firstAttemptAt: 1,
      providerTransferId: "transfer-qbo",
      createdAt: 1,
    });
    const observationId = await ctx.db.insert("demoObservations", {
      scope,
      transferId: "transfer-qbo",
      observation: {
        id: "transfer-qbo",
        scope,
        commandId: versionId,
        requestHash: command.requestHash,
        idempotencyKey: command.idempotencyKey,
        amountCents: 7700,
        currency: "USD",
        destination: command.destination,
        status: "settled",
        createdAt: "2026-10-19T12:00:00Z",
        updatedAt: "2026-10-19T12:00:00Z",
        originalTransactionId: "tx-qbo",
      },
      importedAt: 1,
    });
    const key = `${scope.organizationId}:${scope.runId}:${scope.provider}:${scope.environment}:${scope.accountId}:tx-qbo:debit`;
    const old = (await ctx.db.get(bill.entryId!))!;
    const { _id, _creationTime, ...base } = old;
    const entryId = await ctx.db.insert("journalEntries", {
      ...base,
      source: { kind: "payment_settlement", ref: key },
      sequence: old.sequence + 1,
      idempotencyKey: key,
      lines: [
        { account: "2000", debit: 7700, credit: 0 },
        { account: "1000", debit: 0, credit: 7700 },
      ],
      hash: "b".repeat(64),
    });
    const txId = await ctx.db.insert("demoTransactions", {
      scope,
      commandRowId: commandId,
      entryId,
      state: "posted",
      transaction: {
        id: "tx-qbo",
        scope,
        transferId: "transfer-qbo",
        commandId: versionId,
        amountCents: -7700,
        currency: "USD",
        status: "posted",
        purpose: "debit",
        createdAt: "2026-10-19T12:00:00Z",
        postedAt: "2026-10-19T12:00:00Z",
      },
      importedAt: 1,
      matchedAt: 1,
    });
    await ctx.db.patch(bill._id, { paidCents: 7700, status: "paid" });
    return { versionId, commandId, observationId, entryId, txId };
  });
  return {
    ...f,
    ...seeded,
    scope,
    load: () =>
      f.human.query(current, {
        scope,
        caseId: f.caseId,
        paymentVersionId: seeded.versionId,
      }) as Promise<AccountingExport>,
  };
}
describe("QBO authoritative recognition/settlement export", () => {
  it("requires independent human identity, exact scope and recognized approval", async () => {
    const f = await approved();
    await expect(
      f.t.query(current, { scope: f.scope, caseId: f.caseId }),
    ).rejects.toThrow("authenticated human");
    await expect(
      f.human.query(current, {
        scope: { ...f.scope, accountId: "another" },
        caseId: f.caseId,
      }),
    ).rejects.toThrow("mismatch");
    const e = await f.load();
    expect(e.billRecordHash).toHaveLength(64);
    expect(e.authorizedSubject).toBe(f.identity.tokenIdentifier);
    expect(e.settlement).toBeNull();
    const p = billPlan(e, mappings);
    expect(p.payload.TotalAmt).toBe(77);
    expect(p.payload.VendorRef).toEqual({ value: "5" });
    expect(p.payload.Line).toEqual([
      {
        Amount: 77,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: "7" },
          BillableStatus: "NotBillable",
        },
      },
    ]);
    await f.t.run((ctx) => ctx.db.patch(f.caseId, { businessStatus: "held" }));
    await expect(f.load()).rejects.toThrow("Approved reviewed");
  });
  it("refuses a reversed or altered recognition journal and missing vendor/account mappings", async () => {
    const f = await approved();
    const e = await f.load();
    expect(() => billPlan(e, { ...mappings, vendors: {} })).toThrow(
      "vendor_mapping_missing",
    );
    const bad = structuredClone(mappings);
    delete bad.accounts["5000"];
    expect(() => billPlan(e, bad)).toThrow("account_mapping_missing");
    await f.t.run((ctx) =>
      ctx.db.patch(
        e.detail.links.recognitionJournalId as Id<"journalEntries">,
        { status: "reversed" },
      ),
    );
    await expect(f.load()).rejects.toThrow("Recognition evidence mismatch");
  });
  it("exports the exact posted Increase debit and creates accounting-only BillPayment linked to its Bill", async () => {
    const f = await settled();
    const e = await f.load();
    expect(e.settlement).toMatchObject({
      paymentVersionId: f.versionId,
      commandId: f.commandId,
      bankTransactionId: "tx-qbo",
      journalId: f.entryId,
      amountCents: 7700,
    });
    const p = paymentPlan(e, mappings, successful(e));
    expect(p.payload).toMatchObject({
      TotalAmt: 77,
      PayType: "Check",
      CheckPayment: { BankAccountRef: { value: "35" }, PrintStatus: "NotSet" },
      Line: [{ Amount: 77, LinkedTxn: [{ TxnId: "90", TxnType: "Bill" }] }],
    });
    expect(p.links.settlementJournalId).toBe(f.entryId);
  });
  it.each([
    "unmatched",
    "returned",
    "hash",
    "journal",
    "amount",
    "scope",
  ] as const)(
    "blocks %s evidence instead of trusting settled status",
    async (mode) => {
      const f = await settled();
      await f.t.run(async (ctx) => {
        if (mode === "unmatched")
          await ctx.db.patch(f.txId, { state: "unmatched" });
        if (mode === "returned") {
          const o = (await ctx.db.get(f.observationId))!;
          await ctx.db.patch(o._id, {
            observation: {
              ...o.observation,
              status: "returned",
              returnTransactionId: "return-1",
            },
          });
        }
        if (mode === "hash") {
          const c = (await ctx.db.get(f.commandId))!;
          await ctx.db.patch(c._id, {
            command: { ...c.command, requestHash: "f".repeat(64) },
          });
        }
        if (mode === "journal")
          await ctx.db.patch(f.entryId, {
            source: { kind: "payment_settlement", ref: "unrelated" },
          });
        if (mode === "amount") {
          const t = (await ctx.db.get(f.txId))!;
          await ctx.db.patch(t._id, {
            transaction: { ...t.transaction, amountCents: -7600 },
          });
        }
        if (mode === "scope") {
          const t = (await ctx.db.get(f.txId))!;
          await ctx.db.patch(t._id, {
            scope: { ...t.scope, accountId: "other" },
          });
        }
      });
      await expect(f.load()).rejects.toThrow();
    },
  );
  it("dispatcher loads authority itself; stale/fake exports never submit and new unapproved candidate cannot replace recognition", async () => {
    const f = await approved();
    const e = await f.load();
    const execute = vi.fn();
    const journal = {
      client: { oauth: { config: { realmId: "123" } } },
      execute,
      get: async () => null,
    } as any;
    const loader = vi.fn(async () => e);
    const dispatcher = new QuickBooksDispatcher(loader, mappings, journal);
    expect((await dispatcher.run({ caseId: f.caseId }, "dry-run")).mode).toBe(
      "dry-run",
    );
    await expect(
      dispatcher.run({ caseId: f.caseId }, "submit"),
    ).rejects.toThrow("fresh_authenticated_export_required");
    expect(execute).not.toHaveBeenCalled();
    expect(loader).toHaveBeenCalled();
    const changed = structuredClone(e);
    changed.detail.candidate!.lines[0]!.allocations[0]!.account = "5100";
    expect(() => billPlan(changed, mappings)).toThrow(
      "recognition_journal_mismatch",
    );
  });
  it("revalidates authoritative approval after mapping waits before the first external write", async () => {
    const f = await settled();
    const e = await f.load();
    const changed = structuredClone(e);
    changed.detail.states.business = "held";
    const load = vi
      .fn()
      .mockResolvedValueOnce(e)
      .mockResolvedValueOnce(changed);
    const journal = {
      client: { oauth: { config: { realmId: "123" } } },
      execute: async (_p: unknown, _m: unknown, guard: () => Promise<void>) => {
        await guard();
        throw Error("should never write");
      },
    } as any;
    await expect(
      new QuickBooksDispatcher(load, mappings, journal).run(
        { caseId: f.caseId },
        "submit",
      ),
    ).rejects.toThrow("approved_recognition_required");
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("runs credential-free CLI dry-run and rejects file-based submit", async () => {
    const f = await approved();
    const root = await mkdtemp(join(tmpdir(), "qbo-cli-test-"));
    try {
      const input = join(root, "export.json"),
        mapping = join(root, "mappings.json");
      await writeFile(input, JSON.stringify(await f.load()));
      await writeFile(mapping, JSON.stringify(mappings));
      const run = promisify(execFile);
      const options = {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        timeout: 10000,
      };
      const result = await run(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/ap-system/quickbooks-cli.ts",
          "dry-run",
          "--input",
          input,
          "--mappings",
          mapping,
        ],
        options,
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: "dry-run",
        externalWrites: 0,
        plan: { entity: "Bill", payload: { TotalAmt: 77 } },
      });
      await expect(
        run(
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/ap-system/quickbooks-cli.ts",
            "submit",
            "--input",
            input,
            "--mappings",
            mapping,
          ],
          options,
        ),
      ).rejects.toMatchObject({
        stderr: "external_write_requires_authenticated_backend\n",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("credit hook reverses approved allocations once without creating a payment or changing the Bill", async () => {
    const f = await approved();
    const e = await f.load(),
      bill = successful(e);
    const credit = {
      creditId: "credit-1",
      caseId: "credit-case",
      billId: e.detail.links.billId!,
      journalId: "credit-entry",
      supplierId: "golden-state-produce",
      reference: "CM-1",
      date: "2026-10-20",
      amountCents: 1000,
      allocations: [{ account: "5000", amountCents: 1000 }],
    };
    const p = creditPlan(credit, mappings, bill);
    expect(p.entity).toBe("VendorCredit");
    expect(p.payload.TotalAmt).toBe(10);
    expect(p.links.creditId).toBe("credit-1");
    expect("PayType" in p.payload).toBe(false);
    expect("requestId" in p).toBe(false);
    expect(() =>
      creditPlan({ ...credit, amountCents: 1200 }, mappings, bill),
    ).toThrow("approved_credit_required");
  });
});
