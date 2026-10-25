import { matches } from "../../src/ap-system/quickbooks/client";
import { restoredCreditFixture } from "./quickbooks-restored-credit-fixture";
import { returnedFixture } from "./quickbooks-corrections-fixture";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuth, CALLBACK } from "../../src/ap-system/quickbooks/oauth";
import { QboClient } from "../../src/ap-system/quickbooks/client";
import {
  PrivateStore,
  hash,
} from "../../src/ap-system/quickbooks/private-store";
import {
  QuickBooksDispatcher,
  SyncJournal,
} from "../../src/ap-system/quickbooks/sync";
import type {
  ExportLoader,
  ExportRequest,
  Mappings,
  Operation,
  Plan,
} from "../../src/ap-system/quickbooks/types";
import {
  creditFixture,
  promoteIncrease,
  seedSettled,
} from "./quickbooks-business-fixture";
import { br } from "./business-fixture";
const mappings: Mappings = {
  version: "mock-reviewed-1",
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
    "5100": { id: "8", name: "Purchase discounts", type: "Expense" },
  },
  classes: { "sf-hayes-valley": { id: "9", name: "SF Hayes Valley" } },
  apAccount: "2000",
  bankAccount: "1000",
};
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
/** Independent HTTP-shaped sandbox protocol; no real provider account, grant, or transport. */
async function protocol(load: ExportLoader) {
  const root = await mkdtemp(join(tmpdir(), "qbo-business-"));
  dirs.push(root);
  const store = new PrivateStore(root);
  const rows = new Map<string, Record<string, any>>();
  const posts: Array<{
    entity: string;
    body: Record<string, any>;
    requestId: string;
  }> = [];
  let calls = 0;
  let obscureApplication = false;
  let obscureJournal = false;
  const oauth = new OAuth(
    {
      clientId: "mock",
      clientSecret: "mock-only",
      realmId: "123",
      environment: "sandbox",
      redirectUri: CALLBACK,
    },
    store,
    async (input, init = {}) => {
      calls++;
      const url = new URL(String(input));
      if (url.hostname === "oauth.platform.intuit.com")
        return json({
          access_token: "mock-access",
          refresh_token: "mock-refresh",
          token_type: "bearer",
          expires_in: 3600,
          x_refresh_token_expires_in: 86400,
        });
      expect(url.origin).toBe("https://sandbox-quickbooks.api.intuit.com");
      expect(url.searchParams.get("minorversion")).toBe("75");
      const parts = url.pathname.split("/");
      const path = parts.at(-1)!;
      if (url.pathname.includes("/companyinfo/"))
        return json({ CompanyInfo: { Id: "123", Country: "US" } });
      if (url.pathname.includes("/vendor/"))
        return json({
          Vendor: {
            Id: "5",
            Active: true,
            DisplayName: "Golden State Produce Co.",
          },
        });
      if (url.pathname.includes("/class/"))
        return json({
          Class: { Id: "9", Name: "SF Hayes Valley", Active: true },
        });
      if (url.pathname.includes("/account/")) {
        const a = Object.values(mappings.accounts).find((a) => a.id === path)!;
        return json({
          Account: {
            Id: a.id,
            Name: a.name,
            AccountType: a.type,
            Active: true,
          },
        });
      }
      if (path === "query") {
        const q = url.searchParams.get("query")!;
        const vendor = q.match(
          /^SELECT \* FROM BillPayment WHERE VendorRef = '(\d+)' MAXRESULTS 1000$/,
        );
        if (vendor)
          return json({
            QueryResponse: {
              BillPayment: [...rows.entries()]
                .filter(
                  ([key, row]) =>
                    key.startsWith("BillPayment:") &&
                    row.VendorRef?.value === vendor[1],
                )
                .map(([, row]) => row),
            },
          });
        const [, entity, doc] = q.match(
          /^SELECT \* FROM (\w+) WHERE DocNumber = '([^']+)' MAXRESULTS 1000$/,
        )!;
        const matches = [...rows.entries()]
          .filter(
            ([key, row]) =>
              key.startsWith(`${entity}:`) && row.DocNumber === doc,
          )
          .map(([, row]) => row);
        return json({ QueryResponse: { [entity!]: matches } });
      }
      const entity = (
        {
          bill: "Bill",
          vendorcredit: "VendorCredit",
          billpayment: "BillPayment",
          journalentry: "JournalEntry",
        } as const
      )[
        (init.method === "POST" ? path : parts.at(-2)) as
          "bill" | "billpayment" | "vendorcredit" | "journalentry"
      ];
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        const id = String(90 + posts.length);
        posts.push({
          entity,
          body,
          requestId: url.searchParams.get("requestid")!,
        });
        if (
          (entity === "BillPayment" && obscureApplication) ||
          (entity === "JournalEntry" && obscureJournal)
        )
          return json({}); // could be merged/accepted remotely: never infer success or repost
        const row = {
          ...body,
          Id: id,
          SyncToken: "0",
          ...(entity === "BillPayment" ? {} : { Balance: body.TotalAmt }),
        };
        rows.set(`${entity}:${id}`, row);
        return json({ [entity]: row });
      }
      return json({ [entity]: rows.get(`${entity}:${path}`) });
    },
  );
  const u = new URL(await oauth.begin("a".repeat(64)));
  const callback = new URL(CALLBACK);
  callback.search = new URLSearchParams({
    state: u.searchParams.get("state")!,
    realmId: "123",
    code: "mock-code",
  }).toString();
  await oauth.complete(callback, "a".repeat(64));
  const journal = new SyncJournal(store, new QboClient(oauth));
  const dispatcher = new QuickBooksDispatcher(load, mappings, journal);
  const preview = async (request: ExportRequest) => {
    const r = await dispatcher.run(request);
    if (!("plan" in r) || !r.plan) throw Error("unexpected hold");
    return r.plan;
  };
  const submit = async (request: ExportRequest) => {
    const plan = await preview(request);
    const r = await dispatcher.run(request, "submit", {
      expectedPlanHash: hash(plan),
    });
    if (!("operation" in r) || !r.operation) throw Error("unexpected hold");
    return r.operation;
  };
  return {
    root,
    calls: () => calls,
    rows,
    posts,
    journal,
    dispatcher,
    preview,
    submit,
    obscureJournal: () => {
      obscureJournal = true;
    },
    obscure: () => {
      obscureApplication = true;
    },
  };
}
async function applicationFixture() {
  const f = await creditFixture();
  const c = await f.credit();
  const d = await f.get(f.detail.caseId);
  await f.humans.finance!.mutation(br.applyCredits!, {
    scope: f.scope,
    caseId: d.caseId,
    expectedRevision: d.revision,
    snapshotHash: d.snapshotHash,
    billVersion: d.links.billVersion,
    idempotencyKey: "credit-only",
    reason: "Explicit application",
    credits: [{ creditId: c.creditId, amountCents: 3850 }],
  });
  const a = await f.t.run((ctx) =>
    ctx.db.query("apCreditApplications").first(),
  );
  const s = await promoteIncrease(f);
  const load: ExportLoader = ({ caseId, ...rest }) => s.load(caseId, rest);
  return { f, c, a: a!, s, load };
}
describe("QBO business dispatcher HTTP protocol (mocked)", () => {
  it("applies zero cash to exact restored and original principal and resolves only read-verified application holds", async () => {
    let p!: Awaited<ReturnType<typeof protocol>>;
    const f = await restoredCreditFixture(async (f, s, c) => {
      p = await protocol(({ caseId, ...rest }) => s.load(caseId, rest));
      await p.submit({ caseId: f.detail.caseId });
      await p.submit({ caseId: c.caseId });
      await p.submit({
        caseId: f.detail.caseId,
        paymentVersionId: s.versionId,
      });
    });
    const request = {
      caseId: f.detail.caseId,
      creditApplicationId: f.application._id,
    };
    expect(await p.dispatcher.run(request, "submit")).toMatchObject({
      hold: { code: "restored_payable_allocation_required" },
    });
    const je = await p.submit({
      caseId: f.detail.caseId,
      correctionId: f.returned.proposalId,
    });
    expect(
      await p.dispatcher.checkHolds(
        { caseId: f.detail.caseId },
        { verify: true },
      ),
    ).toEqual([]);
    const a = await f.proposeCorrection(f.allocationRequest);
    await f.voteCorrection(a);
    await f.voteCorrection(a, "finance");
    const op = await p.submit({
      caseId: f.detail.caseId,
      correctionId: a.proposalId,
    });
    expect(op.payload).toMatchObject({
      TotalAmt: 0,
      Line: [
        { Amount: 18.5, LinkedTxn: [{ TxnType: "Bill" }] },
        {
          Amount: 20,
          LinkedTxn: [{ TxnType: "JournalEntry", TxnId: je.externalId }],
        },
        { Amount: 38.5, LinkedTxn: [{ TxnType: "VendorCredit" }] },
      ],
    });
    const holdFile = (await readdir(p.root)).find((n) =>
      n.startsWith("hold-"),
    )!;
    expect(await p.journal.store.read(holdFile)).toMatchObject({
      state: "held",
    });
    const calls = p.calls();
    expect(await p.dispatcher.checkHolds(request)).toEqual([]);
    expect(p.calls()).toBe(calls);
    expect(await p.journal.store.read(holdFile)).toMatchObject({
      state: "held",
    });
    expect(await p.dispatcher.checkHolds(request, { verify: true })).toEqual(
      [],
    );
    expect(await p.journal.store.read(holdFile)).toMatchObject({
      state: "resolved",
      resolution: {
        corrections: [
          { correctionId: f.returned.proposalId, externalId: je.externalId },
          { correctionId: a.proposalId, externalId: op.externalId },
        ],
      },
    });
    expect((await p.submit(request)).requestId).toBe(op.requestId);
    expect(p.posts).toHaveLength(5);
    expect(
      await f.t.run((ctx) => ctx.db.query("demoCommands").collect()),
    ).toEqual(f.beforeApplication.commands);
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toEqual(f.beforeApplication.journals);
    p.rows.get(`BillPayment:${op.externalId}`)!.Line[1].Amount = 19;
    expect(
      await p.dispatcher.checkHolds(request, { verify: true }),
    ).toMatchObject([{ code: "restored_application_verification_required" }]);
    const failures = await Promise.all(
      (await readdir(p.root))
        .filter((n) => n.startsWith("hold-"))
        .map((n) => p.journal.store.read<any>(n)),
    );
    expect(
      failures.some(
        (h) =>
          h?.code === "restored_application_verification_required" &&
          h.state === "held",
      ),
    ).toBe(true);
  });
  it("keeps lost zero-cash restored-credit responses unknown with the original identity and unresolved hold", async () => {
    let p!: Awaited<ReturnType<typeof protocol>>;
    const f = await restoredCreditFixture(async (f, s, c) => {
      p = await protocol(({ caseId, ...rest }) => s.load(caseId, rest));
      await p.submit({ caseId: f.detail.caseId });
      await p.submit({ caseId: c.caseId });
      await p.submit({
        caseId: f.detail.caseId,
        paymentVersionId: s.versionId,
      });
    }, 2000);
    const request = {
      caseId: f.detail.caseId,
      creditApplicationId: f.application._id,
    };
    await p.dispatcher.run(request, "submit");
    await p.submit({
      caseId: f.detail.caseId,
      correctionId: f.returned.proposalId,
    });
    await p.dispatcher.checkHolds(
      { caseId: f.detail.caseId },
      { verify: true },
    );
    const a = await f.proposeCorrection(f.allocationRequest);
    await f.voteCorrection(a);
    await f.voteCorrection(a, "finance");
    const plan = await p.preview(request);
    expect(plan.payload).toMatchObject({
      TotalAmt: 0,
      Line: [
        { Amount: 20, LinkedTxn: [{ TxnType: "JournalEntry" }] },
        { Amount: 20, LinkedTxn: [{ TxnType: "VendorCredit" }] },
      ],
    });
    p.obscure();
    await expect(p.submit(request)).rejects.toThrow(
      "external_response_mismatch",
    );
    const first = (await p.journal.get(plan))!;
    expect(first.state).toBe("unknown");
    const replay = await p.submit({
      caseId: f.detail.caseId,
      correctionId: a.proposalId,
    });
    expect(replay).toMatchObject({
      state: "unknown",
      requestId: first.requestId,
      attempts: 1,
    });
    expect(replay.submissionAuthorization).toEqual(
      first.submissionAuthorization,
    );
    expect(p.posts).toHaveLength(5);
    await p.dispatcher.checkHolds(request, { verify: true });
    const file = (await readdir(p.root)).find((n) => n.startsWith("hold-"))!;
    expect(await p.journal.store.read(file)).toMatchObject({ state: "held" });
  });

  it("preserves cash+credit economics across original Bill and restored JournalEntry", async () => {
    let p!: Awaited<ReturnType<typeof protocol>>;
    const base = await creditFixture();
    const c = await base.credit();
    const f = await returnedFixture(async (f, s) => {
      p = await protocol(({ caseId, ...rest }) => s.load(caseId, rest));
      await p.submit({ caseId: f.detail.caseId });
      await p.submit({
        caseId: f.detail.caseId,
        paymentVersionId: s.versionId,
      });
    }, base);
    const credit = await p.submit({ caseId: c.caseId });
    const r = await f.proposeCorrection();
    await f.voteCorrection(r);
    await f.voteCorrection(r, "finance");
    const je = await p.submit({
      caseId: f.detail.caseId,
      correctionId: r.proposalId,
    });
    expect(
      await p.dispatcher.checkHolds(
        { caseId: f.detail.caseId },
        { verify: true },
      ),
    ).toEqual([]);
    const s = await seedSettled(
      f,
      1150,
      5000,
      [{ creditId: c.creditId, amountCents: 3850 }],
      "-cash-credit",
    );
    const a = await f.proposeCorrection({
      kind: "payment_allocation",
      caseId: f.detail.caseId,
      paymentVersionId: s.versionId,
      originalBillCents: 3000,
      restoredPayables: [{ correctionId: r.proposalId, amountCents: 2000 }],
      idempotencyKey: "cash-credit-allocation",
      reason:
        "Cash plus recognized credit against exact original and restored principal",
    });
    await f.voteCorrection(a);
    await f.voteCorrection(a, "finance");
    const op = await p.submit({
      caseId: f.detail.caseId,
      correctionId: a.proposalId,
    });
    expect(op.payload).toMatchObject({
      TotalAmt: 11.5,
      Line: [
        { Amount: 30, LinkedTxn: [{ TxnType: "Bill" }] },
        {
          Amount: 20,
          LinkedTxn: [{ TxnType: "JournalEntry", TxnId: je.externalId }],
        },
        {
          Amount: 38.5,
          LinkedTxn: [{ TxnType: "VendorCredit", TxnId: credit.externalId }],
        },
      ],
    });
    expect(op.links).toMatchObject({
      appliedCreditIds: [c.creditId],
      restoredCorrectionIds: [r.proposalId],
      correctionId: a.proposalId,
    });
    expect(await p.journal.client.journalAppliedCents(je, "5")).toBe(2000);
    // A truncated vendor history must not be treated as a complete available balance.
    for (let i = 0; i < 1000; i++)
      p.rows.set(`BillPayment:${1000 + i}`, {
        Id: String(1000 + i),
        VendorRef: { value: "5" },
        Line: [],
      });
    await expect(p.journal.client.journalAppliedCents(je, "5")).rejects.toThrow(
      "restored_balance_incomplete",
    );
  });

  it("replicates approved return, resolves held evidence only after readback, and pays exact restored allocation", async () => {
    let p!: Awaited<ReturnType<typeof protocol>>;
    let original!: Operation;
    const f = await returnedFixture(async (f, s) => {
      p = await protocol(({ caseId, ...rest }) => s.load(caseId, rest));
      await p.submit({ caseId: f.detail.caseId });
      original = await p.submit({
        caseId: f.detail.caseId,
        paymentVersionId: s.versionId,
      });
    });
    const req = { caseId: f.detail.caseId };
    expect(await p.dispatcher.run(req, "submit")).toMatchObject({
      hold: { state: "held", code: "return_accounting_remediation_required" },
    });
    const proposal = await f.proposeCorrection();
    await f.voteCorrection(proposal);
    await f.voteCorrection(proposal, "finance");
    expect(await p.dispatcher.checkHolds(req, { verify: true })).toMatchObject([
      { code: "return_correction_sync_required" },
    ]);
    const je = await p.submit({ ...req, correctionId: proposal.proposalId });
    expect(je.entity).toBe("JournalEntry");
    expect(je.payload.Line).toEqual([
      {
        Amount: 20,
        DetailType: "JournalEntryLineDetail",
        JournalEntryLineDetail: {
          PostingType: "Debit",
          AccountRef: { value: "35" },
        },
      },
      {
        Amount: 20,
        DetailType: "JournalEntryLineDetail",
        JournalEntryLineDetail: {
          PostingType: "Credit",
          AccountRef: { value: "33" },
          Entity: { Type: "Vendor", EntityRef: { value: "5" } },
        },
      },
    ]);
    const callsBefore = p.calls();
    expect(await p.dispatcher.checkHolds(req)).toMatchObject([
      { code: "return_correction_sync_required" },
    ]);
    expect(p.calls()).toBe(callsBefore);
    expect(await p.dispatcher.checkHolds(req, { verify: true })).toEqual([]);
    const externalReturn = p.rows.get(`JournalEntry:${je.externalId}`)!;
    externalReturn.Line[1].JournalEntryLineDetail.ClassRef = { value: "999" };
    await expect(p.journal.client.verify(je)).rejects.toThrow(
      "external_stale_or_changed",
    );
    expect(await p.dispatcher.checkHolds(req, { verify: true })).toMatchObject([
      { code: "return_correction_sync_required" },
    ]);
    delete externalReturn.Line[1].JournalEntryLineDetail.ClassRef;
    expect(await p.dispatcher.checkHolds(req, { verify: true })).toEqual([]);
    const callsAfter = p.calls();
    expect(await p.dispatcher.checkHolds(req)).toEqual([]);
    expect(p.calls()).toBe(callsAfter);
    const holdFile = (await readdir(p.root)).find((n) =>
      n.startsWith("hold-"),
    )!;
    expect(await p.journal.store.read(holdFile)).toMatchObject({
      state: "resolved",
      resolution: {
        corrections: [
          {
            correctionId: proposal.proposalId,
            externalId: je.externalId,
            syncToken: "0",
          },
        ],
      },
    });
    expect(await p.journal.get(original)).toEqual(original);
    const next = await seedSettled(f, 3000, 3000, [], "-replacement");
    const replacement = { ...req, paymentVersionId: next.versionId };
    expect(await p.dispatcher.run(replacement)).toMatchObject({
      hold: { code: "restored_payable_allocation_required" },
    });
    const a = await f.proposeCorrection({
      kind: "payment_allocation",
      ...req,
      paymentVersionId: next.versionId,
      originalBillCents: 1000,
      restoredPayables: [
        { correctionId: proposal.proposalId, amountCents: 2000 },
      ],
      idempotencyKey: "replacement-allocation",
      reason: "Exactly allocate existing settlement",
    });
    await f.voteCorrection(a);
    await f.voteCorrection(a, "finance");
    const payment = await p.submit({ ...req, correctionId: a.proposalId });
    expect(payment.payload).toMatchObject({
      TotalAmt: 30,
      Line: [
        { Amount: 10, LinkedTxn: [{ TxnType: "Bill" }] },
        {
          Amount: 20,
          LinkedTxn: [{ TxnType: "JournalEntry", TxnId: je.externalId }],
        },
      ],
    });
    expect(payment.links.correctionId).toBe(a.proposalId);
    expect((await p.submit(replacement)).externalId).toBe(payment.externalId);
    expect(p.posts.map((p) => p.entity)).toEqual([
      "Bill",
      "BillPayment",
      "JournalEntry",
      "BillPayment",
    ]);
    p.rows.get(`JournalEntry:${je.externalId}`)!.Line[1].Amount = 19;
    expect(await p.dispatcher.checkHolds(req, { verify: true })).toMatchObject([
      { code: "return_correction_sync_required" },
    ]);
  });
  it("never resolves ambiguous journal creation or retries with a new request ID", async () => {
    let p!: Awaited<ReturnType<typeof protocol>>;
    const f = await returnedFixture(async (f, s) => {
      p = await protocol(({ caseId, ...rest }) => s.load(caseId, rest));
      await p.submit({ caseId: f.detail.caseId });
      await p.submit({
        caseId: f.detail.caseId,
        paymentVersionId: s.versionId,
      });
    });
    const a = await f.proposeCorrection();
    await f.voteCorrection(a);
    await f.voteCorrection(a, "finance");
    const request = { caseId: f.detail.caseId, correctionId: a.proposalId };
    const plan = await p.preview(request);
    p.obscureJournal();
    await expect(p.submit(request)).rejects.toThrow(
      "external_response_mismatch",
    );
    const first = (await p.journal.get(plan))!;
    expect(first.state).toBe("unknown");
    expect(await p.submit(request)).toMatchObject({
      state: "unknown",
      requestId: first.requestId,
      attempts: 1,
    });
    expect(p.posts).toHaveLength(3);
    expect(
      await p.dispatcher.checkHolds(
        { caseId: f.detail.caseId },
        { verify: true },
      ),
    ).toMatchObject([{ code: "return_correction_sync_required" }]);
  });
  it("blocks externally consumed restored principal before a replacement POST", async () => {
    let p!: Awaited<ReturnType<typeof protocol>>;
    const f = await returnedFixture(async (f, s) => {
      p = await protocol(({ caseId, ...rest }) => s.load(caseId, rest));
      await p.submit({ caseId: f.detail.caseId });
      await p.submit({
        caseId: f.detail.caseId,
        paymentVersionId: s.versionId,
      });
    });
    const a = await f.proposeCorrection();
    await f.voteCorrection(a);
    await f.voteCorrection(a, "finance");
    const je = await p.submit({
      caseId: f.detail.caseId,
      correctionId: a.proposalId,
    });
    expect(
      await p.dispatcher.checkHolds(
        { caseId: f.detail.caseId },
        { verify: true },
      ),
    ).toEqual([]);
    const next = await seedSettled(f, 2000, 2000, [], "-replacement");
    const allocation = await f.proposeCorrection({
      kind: "payment_allocation",
      caseId: f.detail.caseId,
      paymentVersionId: next.versionId,
      originalBillCents: 0,
      restoredPayables: [{ correctionId: a.proposalId, amountCents: 2000 }],
      idempotencyKey: "allocation",
      reason: "Explicit restored payable",
    });
    await f.voteCorrection(allocation);
    await f.voteCorrection(allocation, "finance");
    p.rows.set("BillPayment:999", {
      Id: "999",
      SyncToken: "0",
      VendorRef: { value: "5" },
      Line: [
        {
          Amount: 1,
          LinkedTxn: [{ TxnId: je.externalId, TxnType: "JournalEntry" }],
        },
      ],
    });
    await expect(
      p.submit({
        caseId: f.detail.caseId,
        correctionId: allocation.proposalId,
      }),
    ).rejects.toThrow("external_restored_balance_conflict");
    expect(p.posts).toHaveLength(3);
  });

  it("preserves original signed discount GL on Bill and linked VendorCredit through readback", async () => {
    const f = await creditFixture(100);
    const c = await f.credit();
    const s = await promoteIncrease(f);
    const p = await protocol(({ caseId, ...rest }) => s.load(caseId, rest));
    const bill = await p.submit({ caseId: f.detail.caseId });
    const credit = await p.submit({ caseId: c.caseId });
    expect(bill.payload.TotalAmt).toBe(76);
    expect(credit.payload.TotalAmt).toBe(38);
    const economic = (op: Operation) =>
      (op.payload.Line as any[]).map((l) => ({
        amount: l.Amount,
        account: l.AccountBasedExpenseLineDetail.AccountRef.value,
        classId: l.AccountBasedExpenseLineDetail.ClassRef.value,
      }));
    expect(economic(bill)).toEqual([
      { amount: 77, account: "7", classId: "9" },
      { amount: -1, account: "8", classId: "9" },
    ]);
    expect(economic(credit)).toEqual([
      { amount: 38.5, account: "7", classId: "9" },
      { amount: -0.5, account: "8", classId: "9" },
    ]);
    expect(await p.journal.client.verify(bill)).toMatchObject(bill.payload);
    expect(await p.journal.client.verify(credit)).toMatchObject(credit.payload);
    const changed = p.rows.get(`VendorCredit:${credit.externalId}`)!;
    changed.Line[1].Amount = 0.5;
    await expect(p.journal.client.verify(credit)).rejects.toThrow(
      "external_stale_or_changed",
    );
    changed.Line[1].Amount = -0.5;
    changed.Line[1].AccountBasedExpenseLineDetail.ClassRef.value = "10";
    await expect(p.journal.client.verify(credit)).rejects.toThrow(
      "external_stale_or_changed",
    );
    delete changed.Line[1].AccountBasedExpenseLineDetail.ClassRef;
    await expect(p.journal.client.verify(credit)).rejects.toThrow(
      "external_stale_or_changed",
    );
    const unclassified = structuredClone(bill.payload);
    for (const line of unclassified.Line as any[])
      delete line.AccountBasedExpenseLineDetail.ClassRef;
    expect(matches(unclassified, bill.payload)).toBe(false); // A new provider Class is also a dimension change.
  });
  it("posts exact Bill, VendorCredit and credit-only application; retry preserves original approval author", async () => {
    const { f, c, a, load } = await applicationFixture();
    let reader = "";
    const p = await protocol(async (req) => {
      const e = await load(req);
      return reader ? { ...e, authorizedSubject: reader } : e;
    });
    const bill = await p.submit({ caseId: f.detail.caseId });
    const credit = await p.submit({ caseId: c.caseId });
    const request = { caseId: f.detail.caseId, creditApplicationId: a._id };
    const op = await p.submit(request);
    expect(p.posts.map((p) => p.entity)).toEqual([
      "Bill",
      "VendorCredit",
      "BillPayment",
    ]);
    expect(op.payload).toMatchObject({
      TotalAmt: 0,
      Line: [
        {
          Amount: 38.5,
          LinkedTxn: [{ TxnId: bill.externalId, TxnType: "Bill" }],
        },
        {
          Amount: 38.5,
          LinkedTxn: [{ TxnId: credit.externalId, TxnType: "VendorCredit" }],
        },
      ],
    });
    expect(op.submissionAuthorization).toEqual({
      subject: (await load(request)).authorizedSubject,
      planHash: hash(await p.preview(request)),
      decidedAt: expect.any(Number),
    });
    const approval = op.submissionAuthorization;
    reader = "other-authorized-reader";
    const replay = await p.submit(request);
    expect(replay.submissionAuthorization).toEqual(approval);
    expect(p.posts).toHaveLength(3);
    expect(replay.requestId).toBe(op.requestId);
  });
  it("posts cash+credit with actual cash total and blocks missing or insufficient external credit", async () => {
    const f = await creditFixture();
    const c = await f.credit();
    const s = await seedSettled(f, 3850, 7700, [
      { creditId: c.creditId, amountCents: 3850 },
    ]);
    const load: ExportLoader = ({ caseId, ...rest }) => s.load(caseId, rest);
    const p = await protocol(load);
    await p.submit({ caseId: f.detail.caseId });
    const request = { caseId: f.detail.caseId, paymentVersionId: s.versionId };
    await expect(p.preview(request)).rejects.toThrow(
      "external_credit_required",
    );
    const credit = await p.submit({ caseId: c.caseId });
    const creditRow = p.rows.get(`VendorCredit:${credit.externalId}`)!;
    creditRow.Balance = 1;
    await expect(p.submit(request)).rejects.toThrow(
      "external_balance_conflict",
    );
    expect(p.posts).toHaveLength(2);
    // A durable conflict requires reviewed correction, never an automatic resubmit.
    creditRow.Balance = 38.5;
    await expect(p.submit(request)).rejects.toThrow(
      "operation_requires_review",
    );
    const clean = await protocol(load);
    await clean.submit({ caseId: f.detail.caseId });
    await clean.submit({ caseId: c.caseId });
    const op = await clean.submit(request);
    expect(op.payload.TotalAmt).toBe(38.5);
    expect((op.payload.Line as any[]).map((l) => l.Amount)).toEqual([77, 38.5]);
    expect(op.links).toMatchObject({
      paymentVersionId: s.versionId,
      commandId: s.commandId,
      appliedCreditIds: [c.creditId],
    });
  });
  it("keeps an ambiguous zero-net response unknown with its fixed identity and original approval", async () => {
    const { f, c, a, load } = await applicationFixture();
    const p = await protocol(load);
    await p.submit({ caseId: f.detail.caseId });
    await p.submit({ caseId: c.caseId });
    const request = { caseId: f.detail.caseId, creditApplicationId: a._id };
    const plan = await p.preview(request);
    p.obscure();
    await expect(p.submit(request)).rejects.toThrow(
      "external_response_mismatch",
    );
    const unknown = (await p.journal.get(plan))!;
    expect(unknown.state).toBe("unknown");
    const after = await p.submit(request);
    expect(after.state).toBe("unknown");
    expect(after.requestId).toBe(unknown.requestId);
    expect(after.submissionAuthorization).toEqual(
      unknown.submissionAuthorization,
    );
    expect(p.posts).toHaveLength(3);
  });
  it("persists a returned-evidence hold even for bill-only submit without altering successful history", async () => {
    const f = await creditFixture();
    const s = await seedSettled(f, 2000, 2000);
    const p = await protocol(({ caseId, ...rest }) => s.load(caseId, rest));
    const bill = await p.submit({ caseId: f.detail.caseId });
    const payment = await p.submit({
      caseId: f.detail.caseId,
      paymentVersionId: s.versionId,
    });
    await f.t.run(async (ctx) => {
      const o = (await ctx.db.query("demoObservations").first())!;
      await ctx.db.patch(o._id, {
        observation: {
          ...o.observation,
          returnTransactionId: "returned-after-settlement",
        },
      });
    });
    const request = { caseId: f.detail.caseId };
    const held = await p.dispatcher.run(request, "submit");
    expect(held).toMatchObject({
      hold: {
        state: "held",
        owner: "controller",
        code: "return_accounting_remediation_required",
      },
    });
    expect(p.posts).toHaveLength(2);
    expect(await p.journal.get(bill)).toEqual(bill);
    expect(await p.journal.get(payment)).toEqual(payment);
    expect((await readdir(p.root)).some((n) => n.startsWith("hold-"))).toBe(
      true,
    );
  });
  it("refuses changed requester identity before first external POST and requires journal authorization", async () => {
    const f = await creditFixture();
    const s = await promoteIncrease(f);
    let calls = 0;
    const p = await protocol(async ({ caseId, ...rest }) => ({
      ...(await s.load(caseId, rest)),
      authorizedSubject: ++calls < 3 ? "first" : "second",
    }));
    await expect(p.submit({ caseId: f.detail.caseId })).rejects.toThrow(
      "submission_identity_changed",
    );
    expect(p.posts).toHaveLength(0);
    const plan = await p.preview({ caseId: f.detail.caseId });
    await expect(p.journal.execute(plan, mappings)).rejects.toThrow(
      "submission_authorization_required",
    );
    expect(p.posts).toHaveLength(0);
  });
});
