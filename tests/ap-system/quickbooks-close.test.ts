import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { businessFixture, binding } from "./business-fixture";
import { OAuth, CALLBACK } from "../../src/ap-system/quickbooks/oauth";
import { QboClient } from "../../src/ap-system/quickbooks/client";
import {
  PrivateStore,
  hash,
} from "../../src/ap-system/quickbooks/private-store";
import { SyncJournal } from "../../src/ap-system/quickbooks/sync";
import {
  closePlan,
  QuickBooksCloseDispatcher,
  type CloseExportLoader,
} from "../../src/ap-system/quickbooks/close-sync";
import type {
  CloseAction,
  CloseExportRequest,
} from "../../src/ap-system/close-contracts";
import type { Mappings } from "../../src/ap-system/quickbooks/types";
const refs = {
  propose: makeFunctionReference<"mutation">("apClose:propose"),
  vote: makeFunctionReference<"mutation">("apClose:vote"),
  export: makeFunctionReference<"query">("apClose:accountingExport"),
};
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const mappings: Mappings = {
  version: "reviewed-close-mock",
  realmId: "123",
  country: "US",
  apAccount: "2000",
  bankAccount: "1000",
  vendors: {
    "golden-state-produce": {
      id: "5",
      displayName: "Golden State Produce Co.",
    },
  },
  classes: { "sf-hayes-valley": { id: "9", name: "SF Hayes Valley" } },
  accounts: {
    "1000": { id: "1", name: "Bank", type: "Bank" },
    "2000": { id: "2", name: "AP", type: "Accounts Payable" },
    "2010": {
      id: "3",
      name: "Accrued liabilities",
      type: "Other Current Liability",
    },
    "5000": { id: "4", name: "Produce", type: "Expense" },
    "1200": { id: "6", name: "Inventory", type: "Other Current Asset" },
  },
};
async function fixture() {
  const f = await businessFixture();
  async function approve(action: CloseAction) {
    const p = await f.t.mutation(refs.propose, {
      ...f.controller,
      input: { idempotencyKey: `close-${action.kind}`, action },
    });
    for (const step of p.route) {
      const who =
        step.groupId === "owner"
          ? "owner"
          : step.groupId === "govern"
            ? "governor"
            : "finance";
      await f.humans[who]!.mutation(refs.vote, {
        scope: f.scope,
        input: {
          actionId: p.actionId,
          actionHash: p.actionHash,
          idempotencyKey: `${p.actionId}-${who}`,
          outcome: "approved",
          reason: "Exact synthetic close authority",
        },
      });
    }
    return p;
  }
  const accrual = await approve({
    kind: "accrual",
    accrual: {
      supplierId: f.supplier.supplierId,
      source: binding(f.input.documents[2]!),
      lineId: "receipt-line-1",
      sku: "KALE-24",
      unit: "case",
      description: "Received before invoice approval",
      quantity: "2",
      capacityQuantity: "2",
      unitPriceCents: 3850,
      allocations: structuredClone(f.input.candidate!.lines[0]!.allocations),
      date: "2026-10-19",
      expectedInvoiceCaseId: null,
      quote: f.input.documents[2]!.extractedText,
      reason: "Retain liability",
    },
  });
  const accrualRow = await f.t.run((ctx) => ctx.db.query("apAccruals").first());
  const reversal = await approve({
    kind: "reverse_accrual",
    accrualId: accrualRow!._id,
    quantity: "1",
    date: "2026-10-19",
    evidence: [binding(f.input.documents[2]!)],
    reason: "Explicit half reversal",
  });
  const application = await f.t.run((ctx) =>
    ctx.db.query("apAccrualApplications").first(),
  );
  const scope = {
    ...f.scope,
    provider: "increase" as const,
    environment: "sandbox" as const,
  };
  await f.t.run(async (ctx) => {
    // Test-only scope installation. No bank/provider interaction or runtime fallback.
    for (const table of [
      "demoConfigs",
      "apCaseRecords",
      "apCaseRevisions",
      "apCaseSources",
      "apCaseDeliveries",
      "apCaseDecisions",
      "apCaseOperations",
      "apBusinessPolicies",
      "apSupplierContacts",
      "apSuppliers",
      "apSupplierRevisions",
      "apApprovalProposals",
      "apCloseActions",
      "apAccruals",
      "apAccrualApplications",
    ] as const)
      for (const row of await ctx.db.query(table).collect())
        await ctx.db.patch(row._id, { scope });
  });
  const load: CloseExportLoader = async (input) => ({
    ...(await f.humans.finance!.query(refs.export, { scope, input })),
    scope,
  });
  return { ...f, scope, load, accrual, reversal, application: application! };
}
async function protocol(load: CloseExportLoader, m = mappings) {
  const root = await mkdtemp(join(tmpdir(), "qbo-close-"));
  dirs.push(root);
  const store = new PrivateStore(root);
  const rows = new Map<string, any>();
  const posts: any[] = [];
  let lose = false;
  let calls = 0;
  const json = (v: unknown) =>
    new Response(JSON.stringify(v), {
      headers: { "Content-Type": "application/json" },
    });
  const oauth = new OAuth(
    {
      clientId: "mock",
      clientSecret: "mock",
      realmId: "123",
      environment: "sandbox",
      redirectUri: CALLBACK,
    },
    store,
    async (input, init = {}) => {
      calls++;
      const u = new URL(String(input));
      expect(u.origin).toBe("https://sandbox-quickbooks.api.intuit.com");
      expect(u.searchParams.get("minorversion")).toBe("75");
      const parts = u.pathname.split("/"),
        id = parts.at(-1)!;
      if (u.pathname.includes("/companyinfo/"))
        return json({ CompanyInfo: { Id: "123", Country: "US" } });
      if (u.pathname.includes("/vendor/"))
        return json({
          Vendor: {
            Id: id,
            Active: true,
            DisplayName: "Golden State Produce Co.",
          },
        });
      if (u.pathname.includes("/class/"))
        return json({
          Class: { Id: id, Name: "SF Hayes Valley", Active: true },
        });
      if (u.pathname.includes("/account/")) {
        const a = Object.values(m.accounts).find((a) => a.id === id)!;
        return json({
          Account: { Id: id, Name: a.name, AccountType: a.type, Active: true },
        });
      }
      if (id === "query") {
        const doc = u.searchParams
          .get("query")!
          .match(/DocNumber = '([^']+)'/)![1];
        return json({
          QueryResponse: {
            JournalEntry: [...rows.values()].filter((r) => r.DocNumber === doc),
          },
        });
      }
      if (init.method === "POST") {
        expect(id).toBe("journalentry");
        const body = JSON.parse(String(init.body));
        posts.push({ body, requestid: u.searchParams.get("requestid") });
        const row = { ...body, Id: String(90 + posts.length), SyncToken: "0" };
        rows.set(row.Id, row);
        if (lose) throw Error("lost mock response");
        return json({ JournalEntry: row });
      }
      return json({ JournalEntry: rows.get(id) });
    },
  );
  oauth.access = async () => "mock-token-no-real-grant";
  const journal = new SyncJournal(store, new QboClient(oauth)),
    dispatcher = new QuickBooksCloseDispatcher(load, m, journal);
  async function preview(request: CloseExportRequest) {
    const r = await dispatcher.run(request);
    if (!r.plan) throw Error(r.hold?.code);
    return r.plan;
  }
  async function submit(request: CloseExportRequest) {
    const p = await preview(request);
    const r = await dispatcher.run(request, "submit", {
      expectedPlanHash: hash(p),
    });
    if (!r.operation) throw Error(r.hold?.code);
    return r.operation;
  }
  return {
    dispatcher,
    journal,
    rows,
    posts,
    preview,
    submit,
    calls: () => calls,
    lose: () => {
      lose = true;
    },
  };
}
describe("approved B4 journals to QBO mock protocol", () => {
  it("exports case-less accrual then exact partial reversal by either selector with stable identity", async () => {
    const f = await fixture(),
      p = await protocol(f.load);
    const req = { actionId: f.accrual.actionId };
    const plan = await p.preview(req);
    expect(plan.links.caseId).toBeNull();
    expect(plan.links.billId).toBeNull();
    expect(p.calls()).toBe(0);
    expect(plan.payload.Line).toMatchObject([
      {
        Amount: 77,
        JournalEntryLineDetail: {
          PostingType: "Debit",
          ClassRef: { value: "9" },
          AccountRef: { value: "4" },
        },
      },
      {
        Amount: 77,
        JournalEntryLineDetail: {
          PostingType: "Credit",
          AccountRef: { value: "3" },
        },
      },
    ]);
    const accrual = await p.submit(req);
    const reversal = await p.submit({ actionId: f.reversal.actionId });
    expect(reversal.payload.Line).toMatchObject([
      {
        Amount: 38.5,
        JournalEntryLineDetail: {
          PostingType: "Debit",
          AccountRef: { value: "3" },
        },
      },
      {
        Amount: 38.5,
        JournalEntryLineDetail: {
          PostingType: "Credit",
          ClassRef: { value: "9" },
          AccountRef: { value: "4" },
        },
      },
    ]);
    const replay = await p.submit({ accrualApplicationId: f.application._id });
    expect(replay.externalId).toBe(reversal.externalId);
    expect(replay.requestId).toBe(reversal.requestId);
    expect(p.posts).toHaveLength(2);
    expect(await p.journal.get(accrual)).toEqual(accrual);
    expect(reversal.submissionAuthorization?.subject).toBe(
      (await f.load(req)).authorizedSubject,
    );
  });
  it("holds missing class or original external history and rejects stale current authority", async () => {
    const f = await fixture();
    const noClass = { ...mappings, classes: {} };
    const p = await protocol(f.load, noClass);
    expect(
      await p.dispatcher.run({ actionId: f.accrual.actionId }, "submit"),
    ).toMatchObject({
      hold: { owner: "controller", code: "close_class_mapping_required" },
    });
    expect(p.calls()).toBe(0);
    const q = await protocol(f.load);
    expect(
      await q.dispatcher.run({ actionId: f.reversal.actionId }),
    ).toMatchObject({
      hold: { code: "external_original_close_journal_required" },
    });
    await f.t.run(async (ctx) => {
      const seat = (await ctx.db.query("seats").collect()).find(
        (s) => s.seatId === "human-owner",
      )!;
      await ctx.db.patch(seat._id, { status: "retired" });
    });
    await expect(q.preview({ actionId: f.accrual.actionId })).rejects.toThrow(
      /seat|authority|human/i,
    );
    expect(q.posts).toHaveLength(0);
  });
  it("recovers a lost create response under the same identity without a second post", async () => {
    const f = await fixture(),
      p = await protocol(f.load),
      req = { actionId: f.accrual.actionId };
    p.lose();
    await expect(p.submit(req)).rejects.toThrow("qbo_transport_unknown");
    const plan = await p.preview(req),
      old = (await p.journal.get(plan))!;
    expect(old.state).toBe("unknown");
    const recovered = await p.submit(req);
    expect(recovered.state).toBe("succeeded");
    expect(recovered.requestId).toBe(old.requestId);
    expect(recovered.submissionAuthorization).toEqual(
      old.submissionAuthorization,
    );
    expect(p.posts).toHaveLength(1);
  });
  it("preserves exact approved cost reclassification dimensions and forbids cash/AP substitution", async () => {
    const f = await fixture(),
      e = await f.load({ actionId: f.accrual.actionId });
    // Pure planner boundary test; real authority/journal binding is exercised by B4 export tests.
    const changed = structuredClone(e);
    const c = changed.accounting;
    c.kind = "cost_reclassification";
    c.exportId = `${c.kind}:${c.journal.id}`;
    c.journal.source = { kind: "ap_cost_adjustment", ref: "original" };
    c.originalEntryId = "original";
    c.journal.lines = [
      {
        account: "1200",
        debit: 7700,
        credit: 0,
        store: "sf-hayes-valley",
        supplierId: c.supplierId,
      },
      {
        account: "5000",
        debit: 0,
        credit: 7700,
        store: "sf-hayes-valley",
        supplierId: c.supplierId,
      },
    ];
    const p = await protocol(f.load);
    const original = await p.submit({ actionId: f.accrual.actionId });
    original.links.closeJournalId = "original";
    const plan = closePlan(
      changed,
      { actionId: c.actionId! },
      mappings,
      original,
    );
    expect(
      (plan.payload.Line as any[]).map(
        (l) => l.JournalEntryLineDetail.AccountRef.value,
      ),
    ).toEqual(["6", "4"]);
    c.journal.lines[0]!.account = "2000";
    expect(() =>
      closePlan(changed, { actionId: c.actionId! }, mappings, original),
    ).toThrow("unsupported_close_journal");
  });
});
