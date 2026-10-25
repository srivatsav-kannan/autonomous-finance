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
  let obscureApplication = false;
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
        } as const
      )[
        (init.method === "POST" ? path : parts.at(-2)) as
          "bill" | "billpayment" | "vendorcredit"
      ];
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        const id = String(90 + posts.length);
        posts.push({
          entity,
          body,
          requestId: url.searchParams.get("requestid")!,
        });
        if (entity === "BillPayment" && obscureApplication) return json({}); // could be merged/accepted remotely: never infer success or repost
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
    rows,
    posts,
    journal,
    dispatcher,
    preview,
    submit,
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
      }));
    expect(economic(bill)).toEqual([
      { amount: 77, account: "7" },
      { amount: -1, account: "8" },
    ]);
    expect(economic(credit)).toEqual([
      { amount: 38.5, account: "7" },
      { amount: -0.5, account: "8" },
    ]);
    expect(await p.journal.client.verify(bill)).toMatchObject(bill.payload);
    expect(await p.journal.client.verify(credit)).toMatchObject(credit.payload);
    const changed = p.rows.get(`VendorCredit:${credit.externalId}`)!;
    changed.Line[1].Amount = 0.5;
    await expect(p.journal.client.verify(credit)).rejects.toThrow(
      "external_stale_or_changed",
    );
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
