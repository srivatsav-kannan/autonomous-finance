import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, chmod, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFunctionReference } from "convex/server";
import { fixture, refs } from "./accounting-fixture";
import { creditFixture } from "./quickbooks-business-fixture";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  OAuth,
  CALLBACK,
  type Transport,
  type Config,
} from "../../src/ap-system/quickbooks/oauth";
import {
  PrivateStore,
  hash,
} from "../../src/ap-system/quickbooks/private-store";
import { QboClient } from "../../src/ap-system/quickbooks/client";
import {
  SyncJournal,
  QuickBooksDispatcher,
} from "../../src/ap-system/quickbooks/sync";
import { billPlan, paymentPlan, creditPlan } from "../../src/ap-system/quickbooks/plans";
import type {
  AccountingExport,
  Mappings,
  Plan,
  Operation,
} from "../../src/ap-system/quickbooks/types";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { ExecutePaymentEffect } from "../../src/payments/application/execute-payment-effect";
import { ReconcilePaymentEvidence } from "../../src/payments/application/reconcile-payment-evidence";
import { createConvexPaymentKernel } from "../../src/payments/adapters/convex-payment-kernel";
import { createConvexPaymentEvidence } from "../../src/payments/adapters/convex-payment-evidence";
import type { KernelTransport } from "../../src/payments/adapters/convex-transport";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const current = makeFunctionReference<"query">("apAccountingExport:current");
const config: Config = {
  clientId: "v3-synthetic-client",
  clientSecret: "v3-synthetic-secret",
  realmId: "123",
  redirectUri: CALLBACK,
  environment: "sandbox" as const,
};
const mapping: Mappings = {
  version: "v3-reviewed",
  realmId: "123",
  country: "US",
  vendors: {
    "golden-state-produce": {
      id: "5",
      displayName: "Golden State Produce Co.",
    },
  },
  accounts: {
    "2000": { id: "33", name: "Payable", type: "Accounts Payable" },
    "1000": { id: "35", name: "Cash", type: "Bank" },
    "5000": { id: "7", name: "Produce", type: "Expense" },
  },
  apAccount: "2000",
  bankAccount: "1000",
};
const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const token = () => ({
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  token_type: "bearer",
  expires_in: 3600,
  x_refresh_token_expires_in: 864000,
});
async function store() {
  const p = await mkdtemp(join(tmpdir(), "v3-qbo-"));
  roots.push(p);
  return new PrivateStore(p);
}
async function callback(oauth: OAuth, session = "a".repeat(64)) {
  const start = new URL(await oauth.begin(session)),
    cb = new URL(CALLBACK);
  cb.search = new URLSearchParams({
    state: start.searchParams.get("state")!,
    code: "synthetic-code",
    realmId: "123",
  }).toString();
  return cb;
}
async function approved() {
  const f = await fixture(),
    d = await f.reviewed();
  await f.human.mutation(refs.approve, {
    scope: f.scope,
    input: { ...f.request(d, "v3-bill"), acceptedCents: 7700 },
  });
  const load = () =>
    f.human.query(current, {
      scope: f.scope,
      caseId: d.caseId,
    }) as Promise<AccountingExport>;
  const e = await load();
  return {
    ...f,
    e,
    load,
    caseId: d.caseId,
    billId: e.detail.links.billId as Id<"demoBills">,
  };
}
// This transport is an independent in-memory protocol double. It never invokes fetch.
async function protocol(
  p: Plan,
  options: {
    lost?: boolean;
    badResponse?: boolean;
    delay?: boolean;
    onMapping?: () => Promise<void>;
    originalBill?: Record<string, unknown>;
  } = {},
) {
  const s = await store();
  let posts = 0,
    lookups = 0,
    tokenCalls = 0;
  let rows: Record<string, any>[] = [];
  const requestIds: string[] = [];
  const transport: Transport = async (input, init = {}) => {
    const u = new URL(String(input));
    if (u.hostname === "oauth.platform.intuit.com") {
      tokenCalls++;
      return json(token());
    }
    expect(u.hostname).toBe("sandbox-quickbooks.api.intuit.com");
    expect(init.redirect).toBe("error");
    expect(u.searchParams.get("minorversion")).toBe("75");
    if (init.method === "POST") {
      posts++;
      requestIds.push(u.searchParams.get("requestid")!);
      const payload = JSON.parse(String(init.body));
      expect(payload).toEqual(p.payload);
      if (options.delay) await new Promise((r) => setTimeout(r, 20));
      rows = [{ ...payload, Id: "901", SyncToken: "0" }];
      if (options.lost) throw new Error("private-synthetic-provider-body");
      return json({
        [p.entity]: options.badResponse
          ? { ...rows[0], TotalAmt: 78 }
          : rows[0],
      });
    }
    if (u.pathname.endsWith("/bill/901") && options.originalBill)
      return json({ Bill: options.originalBill });
    if (u.pathname.endsWith("/query")) {
      lookups++;
      return json({ QueryResponse: { [p.entity]: rows } });
    }
    if (u.pathname.endsWith("/companyinfo/123")) {
      await options.onMapping?.();
      return json({ CompanyInfo: { Country: "US" } });
    }
    if (u.pathname.endsWith("/vendor/5"))
      return json({
        Vendor: {
          Id: "5",
          DisplayName: "Golden State Produce Co.",
          Active: true,
        },
      });
    const account = Object.values(mapping.accounts).find((a) =>
      u.pathname.endsWith("/account/" + a.id),
    );
    if (account)
      return json({
        Account: {
          Id: account.id,
          Name: account.name,
          AccountType: account.type,
          Active: true,
        },
      });
    if (u.pathname.endsWith("/" + p.entity.toLowerCase() + "/901"))
      return json({ [p.entity]: rows[0] });
    throw new Error("Unexpected test route");
  };
  const oauth = new OAuth(config, s, transport);
  await oauth.complete(await callback(oauth), "a".repeat(64));
  const client = new QboClient(oauth, async () => {}),
    journal = new SyncJournal(s, client);
  return {
    s,
    oauth,
    client,
    journal,
    transport,
    get posts() {
      return posts;
    },
    get lookups() {
      return lookups;
    },
    get tokenCalls() {
      return tokenCalls;
    },
    requestIds,
    get rows() {
      return rows;
    },
    set rows(v) {
      rows = v;
    },
  };
}
// Current first-POST contract. Historical V3 tests/report remain at ac0be779.
const authorization = (p: Plan) => ({
  subject: "v3-synthetic-authorized-writer",
  planHash: hash(p),
  decidedAt: Date.now(),
});
const successful = (p: Plan, id: string): Operation => ({
  ...p, requestId: `ap-${hash({ realm: p.realmId, identity: p.identity }).slice(0,44)}`,
  payloadHash: hash(p), state: "succeeded", createdAt: 1, updatedAt: 1, attempts: 1,
  externalId: id, syncToken: "0", lastError: null, responseHash: "a".repeat(64),
});
const authenticated = (e: AccountingExport): AccountingExport => ({
  ...structuredClone(e),
  exportedAt: Date.now(),
  detail: {
    ...structuredClone(e.detail),
    scope: { ...e.detail.scope, provider: "increase", environment: "sandbox" },
    identityMode: "authenticated_human",
  },
});

describe("V3 independent credential-free QBO boundaries", () => {
  it("exports authoritative recognition, rejects wrong account, anonymous access and stale approval, and redacts originals", async () => {
    const f = await approved();
    expect(f.e.detail.amounts.acceptedCents).toBe(7700);
    expect(f.e.settlement).toBeNull();
    const p = billPlan(f.e, mapping);
    expect(p.payload.TotalAmt).toBe(77);
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
    expect(JSON.stringify(f.e)).not.toContain("/private/ap/");
    expect(JSON.stringify(f.e)).not.toContain("originalBase64");
    await expect(
      f.t.query(current, { scope: f.scope, caseId: f.caseId }),
    ).rejects.toThrow(/human/);
    await expect(
      f.human.query(current, {
        scope: { ...f.scope, accountId: "wrong" },
        caseId: f.caseId,
      }),
    ).rejects.toThrow(/mismatch/);
    await f.t.run((ctx) =>
      ctx.db.patch(f.caseId as Id<"apCaseRecords">, {
        snapshotHash: "e".repeat(64),
      }),
    );
    await expect(f.load()).rejects.toThrow(/approved snapshot/);
  });
  it.each([false, true])(
    "exports only exact partial cash and gross discharge with original linked credit, credit applied=%s",
    async (credits) => {
      // B3 now supports partial export; the applied 1200 must come from an
      // actually recognized linked credit, not the obsolete unlinked legacy hook.
      const governed = credits ? await creditFixture() : null;
      const f = governed ? { ...governed, caseId: governed.detail.caseId,
        billId: governed.original.billId as Id<"demoBills"> } : await approved();
      const selected = governed
        ? [{ creditId: (await governed.credit("V3-QBO-LINKED-CREDIT")).creditId, amountCents: 1200 }]
        : [];
      const r = await f.t.mutation(api.demoPayments.requestPayment, {
        scope: f.scope,
        seatId: "payments",
        token: "token-payments",
        requestKey: "v3-qbo-partial",
        billIds: [f.billId],
        billAmounts: [{ billId: f.billId, amountCents: 5000 }],
        credits: selected,
      });
      await f.human.mutation(api.demoPayments.approveAndQueue, {
        scope: f.scope,
        ...r,
      });
      const bank = openFakeBank({
        path: ":memory:",
        scope: f.scope,
        seed: "v3-qbo-partial",
        startTime: "2026-10-25T12:00:00Z",
      });
      try {
        const t = f.t as unknown as KernelTransport;
        const worker = new ExecutePaymentEffect(
          createConvexPaymentKernel(t, f.scope, "test-dispatch"),
          bank.provider,
          "qbo-isolated",
          {
            now: Date.now,
            newLeaseToken: () => "v3-qbo-independent-lease",
            startHeartbeat: () => () => {},
          },
        );
        await worker.tick();
        const transfer = bank.harness.inspect().transfers[0]!;
        expect(transfer.amountCents).toBe(credits ? 3800 : 5000);
        bank.harness.settle(transfer.id);
        const rec = new ReconcilePaymentEvidence(
          createConvexPaymentEvidence(t, f.scope, "test-evidence"),
          bank.provider,
          f.scope,
          Date.now,
        );
        await rec.tick();
        expect(await f.t.run((ctx) => ctx.db.get(f.billId))).toMatchObject({
          paidCents: 5000,
          status: "approved",
        });
        const exported = await f.human.query(current, {
          scope: f.scope, caseId: f.caseId, paymentVersionId: r.versionId,
        }) as AccountingExport;
        expect(exported.settlement).toMatchObject({ amountCents: credits ? 3800 : 5000,
          grossAppliedCents: 5000, paymentVersionId: r.versionId });
        expect(exported.detail.amounts.outstandingCents).toBe(2700);
        expect(exported.detail.amounts.acceptedCents).toBe(7700);
        expect(exported.settlement!.credits!.map(c => c.amountCents)).toEqual(credits ? [1200] : []);
        // Only planning gets an Increase-shaped scope; actual bank execution above remains FakeBank.
        const e = authenticated(exported), bill = successful(billPlan(e, mapping), "901");
        const creditOps = e.settlement!.credits!.map(c => successful(creditPlan(c.recognition, mapping, bill), "902"));
        const planned = paymentPlan(e, mapping, bill, creditOps);
        expect(bill.payload.TotalAmt).toBe(77);
        expect(planned.payload.TotalAmt).toBe(credits ? 38 : 50);
        expect(planned.payload.Line).toEqual([
          { Amount: 50, LinkedTxn: [{ TxnId: "901", TxnType: "Bill" }] },
          ...(credits ? [{ Amount: 12, LinkedTxn: [{ TxnId: "902", TxnType: "VendorCredit" }] }] : []),
        ]);
        expect(() => paymentPlan({ ...e, settlement: { ...e.settlement!, grossAppliedCents: 7700 } }, mapping, bill, creditOps))
          .toThrow("payment_application_sum_mismatch");
      } finally {
        bank.close();
      }
    },
  );
  it("blocks a BillPayment when its linked external Bill changed before first write", async () => {
    const f = await approved();
    const r = await f.t.mutation(api.demoPayments.requestPayment, {
      scope: f.scope,
      seatId: "payments",
      token: "token-payments",
      requestKey: "v3-full-payment",
      billIds: [f.billId],
      credits: [],
    });
    await f.human.mutation(api.demoPayments.approveAndQueue, {
      scope: f.scope,
      ...r,
    });
    const bank = openFakeBank({
      path: ":memory:",
      scope: f.scope,
      seed: "v3-full",
      startTime: "2026-10-25T12:00:00Z",
    });
    let e: AccountingExport;
    try {
      const t = f.t as unknown as KernelTransport;
      await new ExecutePaymentEffect(
        createConvexPaymentKernel(t, f.scope, "test-dispatch"),
        bank.provider,
        "v3-full",
        {
          now: Date.now,
          newLeaseToken: () => "v3-full-unique-lease-token",
          startHeartbeat: () => () => {},
        },
      ).tick();
      bank.harness.settle(bank.harness.inspect().transfers[0]!.id);
      await new ReconcilePaymentEvidence(
        createConvexPaymentEvidence(t, f.scope, "test-evidence"),
        bank.provider,
        f.scope,
        Date.now,
      ).tick();
      e = (await f.human.query(current, {
        scope: f.scope,
        caseId: f.caseId,
        paymentVersionId: r.versionId,
      })) as AccountingExport;
    } finally {
      bank.close();
    }
    expect(e.settlement?.amountCents).toBe(7700);
    // Protocol-only Increase-shaped export; real settlement evidence above is FakeBank, never claimed live Increase.
    e = authenticated(e);
    const b = billPlan(e, mapping);
    const prior: Operation = {
      ...b,
      requestId: `ap-${hash({ realm: b.realmId, identity: b.identity }).slice(0, 44)}`,
      payloadHash: hash(b),
      state: "succeeded",
      createdAt: 1,
      updatedAt: 1,
      attempts: 1,
      externalId: "901",
      syncToken: "0",
      lastError: null,
      responseHash: "a".repeat(64),
    };
    const p = paymentPlan(e, mapping, prior);
    expect(p.payload.TotalAmt).toBe(77);
    expect(p.payload.Line).toEqual([
      { Amount: 77, LinkedTxn: [{ TxnId: "901", TxnType: "Bill" }] },
    ]);
    const h = await protocol(p, {
      originalBill: { ...b.payload, Id: "901", SyncToken: "1" },
    });
    await h.s.write(h.journal.key(b), prior);
    await expect(
      new QuickBooksDispatcher(async () => e, mapping, h.journal).run(
        { caseId: f.caseId, paymentVersionId: r.versionId },
        "submit",
      ),
    ).rejects.toThrow("external_stale_or_changed");
    expect(h.posts).toBe(0);
    expect((await h.journal.get(p))?.attempts).toBe(0);
    expect((await h.journal.get(b))?.externalId).toBe("901");
  });
  it("serializes two separate journal instances and preserves one provider identity", async () => {
    const f = await approved(),
      p = billPlan(f.e, mapping),
      h = await protocol(p, { delay: true }),
      second = new SyncJournal(new PrivateStore(h.s.root), h.client);
    const [a, b] = await Promise.all([
      h.journal.execute(p, mapping, undefined, authorization(p)),
      second.execute(p, mapping, undefined, { ...authorization(p), subject: "concurrent-second-writer" }),
    ]);
    expect(a.externalId).toBe("901");
    expect(b.externalId).toBe("901");
    expect(a.requestId).toBe(b.requestId);
    expect(h.posts).toBe(1);
    expect(a.attempts).toBe(1);
    expect(b.submissionAuthorization).toEqual(a.submissionAuthorization);
  });
  it("recovers a lost create response after journal reopen with no new POST, preserving exact request", async () => {
    const f = await approved(),
      p = billPlan(f.e, mapping),
      h = await protocol(p, { lost: true });
    await expect(h.journal.execute(p, mapping, undefined, authorization(p))).rejects.toThrow(
      "qbo_transport_unknown",
    );
    const before = (await h.journal.get(p))!;
    expect(before.state).toBe("unknown");
    expect(before.lastError).not.toContain("private-synthetic");
    const reopened = new SyncJournal(
      new PrivateStore(h.s.root),
      new QboClient(new OAuth(config, new PrivateStore(h.s.root), h.transport)),
    );
    const after = await reopened.execute(p, mapping);
    expect(after.state).toBe("succeeded");
    expect(after.externalId).toBe("901");
    expect(after.payload).toEqual(before.payload);
    expect(after.requestId).toBe(before.requestId);
    expect(after.attempts).toBe(1);
    expect(after.submissionAuthorization).toEqual(before.submissionAuthorization);
    expect(h.posts).toBe(1);
  });
  it("unknown with no match never reposts, and duplicate marker matches require review", async () => {
    const f = await approved(),
      p = billPlan(f.e, mapping),
      h = await protocol(p, { lost: true });
    await expect(h.journal.execute(p, mapping, undefined, authorization(p))).rejects.toThrow();
    const original = h.rows[0]!;
    h.rows = [];
    for (let i = 0; i < 2; i++)
      expect((await h.journal.execute(p, mapping)).state).toBe("unknown");
    expect(h.posts).toBe(1);
    h.rows = [original, { ...original, Id: "902" }];
    await expect(h.journal.execute(p, mapping)).rejects.toThrow(
      "external_mapping_conflict",
    );
    expect((await h.journal.get(p))?.state).toBe("conflict");
    expect(h.posts).toBe(1);
  });
  it("rejects a changed external SyncToken and immutable mapping change without rewriting the receipt", async () => {
    const f = await approved(),
      p = billPlan(f.e, mapping),
      h = await protocol(p);
    const first = await h.journal.execute(p, mapping, undefined, authorization(p));
    h.rows = [{ ...h.rows[0], SyncToken: "1" }];
    await expect(h.journal.execute(p, mapping)).rejects.toThrow(
      "external_stale_or_changed",
    );
    const changed = { ...mapping, version: "reviewed-2" };
    await expect(
      h.journal.execute({ ...p, mappingHash: hash(changed) }, changed),
    ).rejects.toThrow("immutable_operation_conflict");
    const stored = await h.journal.get(p);
    expect(stored?.externalId).toBe(first.externalId);
    expect(stored?.requestId).toBe(first.requestId);
    expect(stored?.syncToken).toBe("0");
    expect(h.posts).toBe(1);
  });
  it("does not accept a mismatched create response or later changed economic payload", async () => {
    const f = await approved(),
      p = billPlan(f.e, mapping),
      h = await protocol(p, { badResponse: true });
    await expect(h.journal.execute(p, mapping, undefined, authorization(p))).rejects.toThrow(
      "external_response_mismatch",
    );
    expect((await h.journal.get(p))?.state).toBe("unknown");
    h.rows = [{ ...h.rows[0], TotalAmt: 78 }];
    await expect(h.journal.execute(p, mapping)).rejects.toThrow(
      "external_mapping_conflict",
    );
    expect(h.posts).toBe(1);
  });
  it("rechecks approval after mapping waits and does not write after authority was withdrawn", async () => {
    const f = await approved();
    let e = authenticated(f.e);
    const p = billPlan(e, mapping);
    const h = await protocol(p, {
      onMapping: async () => {
        e = {
          ...e,
          detail: {
            ...e.detail,
            states: { ...e.detail.states, business: "held" },
          },
        };
      },
    });
    const dispatcher = new QuickBooksDispatcher(
      async () => e,
      mapping,
      h.journal,
    );
    await expect(
      dispatcher.run({ caseId: e.detail.caseId }, "submit"),
    ).rejects.toThrow("approved_recognition_required");
    expect(h.posts).toBe(0);
    expect((await h.journal.get(p))?.attempts).toBe(0);
  });
  it("binds concurrent callbacks to one use and rejects cross-session state without spending it", async () => {
    const s = await store();
    let count = 0;
    const oauth = new OAuth(config, s, async () => {
      count++;
      return json(token());
    });
    const cb = await callback(oauth);
    await expect(oauth.complete(cb, "b".repeat(64))).rejects.toThrow(
      "invalid_oauth_state",
    );
    expect(count).toBe(0);
    const results = await Promise.allSettled([
      oauth.complete(cb, "a".repeat(64)),
      oauth.complete(cb, "a".repeat(64)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(count).toBe(1);
    expect((await stat(s.path("tokens.json"))).mode & 0o777).toBe(0o600);
  });
  it("never reuses a refresh token after an ambiguous rotation, including a fresh OAuth instance", async () => {
    const s = await store();
    let calls = 0,
      now = Date.now();
    const transport: Transport = async () => {
      calls++;
      if (calls === 1) return json(token());
      throw new Error("secret-refresh-response-body");
    };
    const oauth = new OAuth(config, s, transport, () => now);
    await oauth.complete(await callback(oauth), "a".repeat(64));
    now += 3600000;
    await expect(oauth.access()).rejects.toThrow("oauth_transport_unknown");
    expect((await s.read<any>("tokens.json")).blocked).toBe(true);
    await expect(
      new OAuth(config, s, transport, () => now).access(),
    ).rejects.toThrow("oauth_reauthorization_required");
    expect(calls).toBe(2);
  });
  it("rejects symlinked or broadly readable private files and immutable operation corruption", async () => {
    const f = await approved(),
      p = billPlan(f.e, mapping),
      h = await protocol(p);
    await h.journal.execute(p, mapping, undefined, authorization(p));
    await h.s.write("target.json", { fixture: true });
    await symlink(h.s.path("target.json"), h.s.path("linked.json"));
    await expect(h.s.read("linked.json")).rejects.toThrow(
      "private_read_failed",
    );
    await chmod(h.s.path("target.json"), 0o644);
    await expect(h.s.read("target.json")).rejects.toThrow(
      "unsafe_private_file",
    );
    const op = (await h.journal.get(p))!;
    await h.s.write(h.journal.key(p), {
      ...op,
      payload: { ...op.payload, TotalAmt: 78 },
    });
    await expect(h.journal.execute(p, mapping)).rejects.toThrow(
      "immutable_operation_conflict",
    );
    expect(h.posts).toBe(1);
  });
});
