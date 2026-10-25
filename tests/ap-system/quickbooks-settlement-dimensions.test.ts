import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PrivateStore,
  hash,
} from "../../src/ap-system/quickbooks/private-store";
import { SyncJournal } from "../../src/ap-system/quickbooks/sync";
import type { OAuth, Transport } from "../../src/ap-system/quickbooks/oauth";
import { api } from "../../convex/_generated/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { boundPayment } from "./settlement-payment-fixture";
import { successful } from "./quickbooks-business-fixture";
import {
  billPlan,
  creditPlan,
  paymentPlan,
  dimensionHold,
  applicationPlan,
} from "../../src/ap-system/quickbooks/plans";
import {
  returnPlan,
  allocatedPaymentPlan,
} from "../../src/ap-system/quickbooks/correction-plans";
import { matches, QboClient } from "../../src/ap-system/quickbooks/client";
import type {
  AccountingExport,
  Mappings,
} from "../../src/ap-system/quickbooks/types";
import { br } from "./business-fixture";
const current = makeFunctionReference<"query">("apAccountingExport:current");
const propose = makeFunctionReference<"mutation">(
  "apAccountingCorrections:propose",
);
const approve = makeFunctionReference<"mutation">(
  "apAccountingCorrections:vote",
);
const m: Mappings = {
  version: "explicit-synthetic-location",
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
  accounts: {
    "2000": { id: "33", name: "AP", type: "Accounts Payable" },
    "1000": { id: "35", name: "Bank", type: "Bank" },
    "5000": { id: "7", name: "Produce", type: "Expense" },
  },
  classes: { "sf-hayes-valley": { id: "9", name: "SF" } },
  dimensions: {
    version: "ap-qbo-dimensions-v1",
    policyId: "synthetic-reviewed",
    reviewedBy: "synthetic-operator",
    reviewedAt: 1,
    departmentAsLocation: {
      mode: "department_as_location",
      locations: { ops: { id: "11", name: "Operations" } },
    },
  },
};
afterEach(() => vi.unstubAllEnvs());
describe("QBO frozen settlement locations", () => {
  it("replicates exact partial cash/credit location and holds missing or altered authority", async () => {
    const f = await boundPayment(false, true);
    expect(await f.claim()).not.toBeNull();
    await f.post();
    const e = (await f.humans.finance!.query(current, {
      scope: f.scope,
      caseId: f.detail.caseId,
      paymentVersionId: f.request.versionId,
    })) as AccountingExport;
    const bill = successful(billPlan(e, m), "90"),
      credit = successful(
        creditPlan(e.settlement!.credits![0]!.recognition, m, bill),
        "91",
      );
    const plan = paymentPlan(e, m, bill, [credit]);
    expect(plan.payload).toMatchObject({
      DepartmentRef: { value: "11" },
      TotalAmt: 20,
      Line: [{ Amount: 30 }, { Amount: 10 }],
    });
    expect(dimensionHold(e, m)).toBeNull();
    for (const mutate of [
      (x: AccountingExport) => {
        delete x.settlement!.accountingBinding;
      },
      (x: AccountingExport) => {
        x.settlement!.accountingBinding!.department = "sales";
      },
      (x: AccountingExport) => {
        x.settlement!.accountingBinding!.bills[0]!.appliedCents++;
      },
    ]) {
      const changed = structuredClone(e);
      mutate(changed);
      expect(() => paymentPlan(changed, m, bill, [credit])).toThrow(
        /settlement_.*(required|invalid)/,
      );
    }
    expect(
      matches(plan.payload, {
        ...plan.payload,
        DepartmentRef: { value: "12" },
      }),
    ).toBe(false);
    const original = await f.t.run((ctx) => ctx.db.get(f.request.versionId));
    expect(original!.snapshot.accountingBinding!.department).toBe("ops");
  });
  it("retains department through approved return JE and zero-cash credit application to restored payable", async () => {
    const f = await boundPayment(false, true);
    await f.claim();
    await f.post();
    const load = (extra: Record<string, string> = {}) =>
      f.humans.finance!.query(current, {
        scope: f.scope,
        caseId: f.detail.caseId,
        ...extra,
      }) as Promise<AccountingExport>;
    const original = await load({ paymentVersionId: f.request.versionId });
    const bill = successful(billPlan(original, m), "90"),
      credit = successful(
        creditPlan(original.settlement!.credits![0]!.recognition, m, bill),
        "91",
      );
    const payment = successful(paymentPlan(original, m, bill, [credit]), "92");
    await f.post(true);
    const authorize = async (input: Record<string, unknown>) => {
      const p = await f.t.mutation(propose, {
        ...f.controller,
        scope: f.scope,
        input,
      });
      for (const [i, step] of p.route.entries())
        await f.humans[
          step.groupId === "govern" ? "governor" : step.groupId
        ]!.mutation(approve, {
          scope: f.scope,
          input: {
            proposalId: p.proposalId,
            proposalHash: p.proposalHash,
            idempotencyKey: `${p.proposalId}-vote-${i}`,
            outcome: "approved",
            reason: "Review exact dimension-preserving correction",
          },
        });
      return p;
    };
    const r = await authorize({
      kind: "bank_return",
      caseId: f.detail.caseId,
      paymentVersionId: f.request.versionId,
      returnTransactionId: "dimension-return",
      idempotencyKey: "return-dim",
      reason: "Replicate exact posted bank return",
    });
    const re = await load({ correctionId: r.proposalId });
    const returned = successful(returnPlan(re, m, payment), "93");
    expect(
      (returned.payload.Line as any[]).map(
        (l) => l.JournalEntryLineDetail.DepartmentRef,
      ),
    ).toEqual([{ value: "11" }, { value: "11" }]);
    expect(
      (returned.payload.Line as any[])[1]!.JournalEntryLineDetail.Entity,
    ).toEqual({ Type: "Vendor", EntityRef: { value: "5" } });
    const altered = structuredClone(returned.payload);
    (altered.Line as any[])[1]!.JournalEntryLineDetail.DepartmentRef.value =
      "12";
    expect(matches(returned.payload, altered)).toBe(false);
    const rows = await f.t.run(async (ctx) => ({
      c: (await ctx.db.get(f.detail.caseId as any)) as any,
      b: (await ctx.db.get(f.original.billId as any)) as any,
    }));
    await f.humans.finance!.mutation(br.applyCredits!, {
      scope: f.scope,
      caseId: f.detail.caseId,
      expectedRevision: rows.c.currentRevision,
      snapshotHash: rows.c.snapshotHash,
      billVersion: rows.b.version,
      idempotencyKey: "restored-dim-credit",
      reason: "Apply two thousand credit cents to restored payable",
      credits: [{ creditId: f.credit.creditId, amountCents: 2000 }],
    });
    const application = await f.t.run((ctx) =>
      ctx.db.query("apCreditApplications").first(),
    );
    const a = await authorize({
      kind: "credit_allocation",
      caseId: f.detail.caseId,
      creditApplicationId: application!._id,
      originalBillCents: 0,
      restoredPayables: [{ correctionId: r.proposalId, amountCents: 2000 }],
      idempotencyKey: "restored-credit-dim",
      reason: "Explicit zero-cash restored principal allocation",
    });
    const e = await load({ correctionId: a.proposalId });
    const plan = allocatedPaymentPlan(e, m, bill, [credit], [returned]);
    expect(plan.payload).toMatchObject({
      DepartmentRef: { value: "11" },
      TotalAmt: 0,
      Line: [
        { Amount: 20, LinkedTxn: [{ TxnId: "93", TxnType: "JournalEntry" }] },
        { Amount: 20, LinkedTxn: [{ TxnId: "91", TxnType: "VendorCredit" }] },
      ],
    });
    expect(e.creditApplication!.accountingBinding!.department).toBe("ops");
    expect(
      (await f.t.run((ctx) => ctx.db.query("journalEntries").collect())).filter(
        (j) => j.source.kind === "payment_settlement",
      ),
    ).toHaveLength(2);
    const changed = structuredClone(e);
    changed.correction!.kind !== "bank_return" &&
      (changed.correction!.restoredPayables[0]!.correction.original.accountingBinding!.department =
        "sales");
    expect(() =>
      allocatedPaymentPlan(changed, m, bill, [credit], [returned]),
    ).toThrow();
  });
  it("rejects a dimension changed in posted local settlement before exporting", async () => {
    const f = await boundPayment(false, true);
    await f.claim();
    const p = await f.post();
    await f.t.run(async (ctx) => {
      const j = (await ctx.db.get(p.entryId))!;
      await ctx.db.patch(j._id, {
        lines: j.lines.map((l, i) =>
          i ? l : { ...l, dims: { department: "sales" } },
        ),
      });
    });
    await expect(
      f.humans.finance!.query(current, {
        scope: f.scope,
        caseId: f.detail.caseId,
        paymentVersionId: f.request.versionId,
      }),
    ).rejects.toThrow("Settlement journal mismatch");
  });
  it("pays a restored journal through a second independently approved cash command with the same department", async () => {
    const f = await boundPayment(false, true);
    await f.claim();
    await f.post();
    const load = (extra: Record<string, string> = {}) =>
      f.humans.finance!.query(current, {
        scope: f.scope,
        caseId: f.detail.caseId,
        ...extra,
      }) as Promise<AccountingExport>;
    const e1 = await load({ paymentVersionId: f.request.versionId }),
      bill = successful(billPlan(e1, m), "90"),
      credit = successful(
        creditPlan(e1.settlement!.credits![0]!.recognition, m, bill),
        "91",
      ),
      payment = successful(paymentPlan(e1, m, bill, [credit]), "92");
    await f.post(true);
    const authorize = async (input: Record<string, unknown>) => {
      const p = await f.t.mutation(propose, {
        ...f.controller,
        scope: f.scope,
        input,
      });
      for (const [i, step] of p.route.entries())
        await f.humans[
          step.groupId === "govern" ? "governor" : step.groupId
        ]!.mutation(approve, {
          scope: f.scope,
          input: {
            proposalId: p.proposalId,
            proposalHash: p.proposalHash,
            idempotencyKey: `${p.proposalId}-${i}`,
            outcome: "approved",
            reason: "Exact replacement location",
          },
        });
      return p;
    };
    const r = await authorize({
      kind: "bank_return",
      caseId: f.detail.caseId,
      paymentVersionId: f.request.versionId,
      returnTransactionId: "dimension-return",
      idempotencyKey: "cash-return-dim",
      reason: "Exact posted return",
    });
    const returned = successful(
      returnPlan(await load({ correctionId: r.proposalId }), m, payment),
      "93",
    );
    const p2 = await f.t.mutation(api.demoPayments.requestPayment, {
      ...f.args,
      requestKey: "replacement-dim",
      credits: [],
      billAmounts: [{ billId: f.original.billId, amountCents: 2000 }],
    });
    const c2 = await f.payer.mutation(api.demoPayments.approveAndQueue,
      { scope: f.scope, ...p2 },
    );
    expect(await f.claim("replacement-dim-lease")).not.toBeNull();
    await f.postCommand(c2.commandId, "-replacement");
    const a = await authorize({
      kind: "payment_allocation",
      caseId: f.detail.caseId,
      paymentVersionId: p2.versionId,
      originalBillCents: 0,
      restoredPayables: [{ correctionId: r.proposalId, amountCents: 2000 }],
      idempotencyKey: "replacement-allocation-dim",
      reason: "Replace returned cash against exact restored principal",
    });
    const plan = allocatedPaymentPlan(
      await load({ correctionId: a.proposalId }),
      m,
      bill,
      [],
      [returned],
    );
    expect(plan.payload).toMatchObject({
      DepartmentRef: { value: "11" },
      TotalAmt: 20,
      Line: [
        { Amount: 20, LinkedTxn: [{ TxnId: "93", TxnType: "JournalEntry" }] },
      ],
    });
  });
  it("recovers an ambiguous department-bearing payment with one request ID and preserves the original approval", async () => {
    const f = await boundPayment(false, true);
    await f.claim();
    await f.post();
    const e = (await f.humans.finance!.query(current, {
      scope: f.scope,
      caseId: f.detail.caseId,
      paymentVersionId: f.request.versionId,
    })) as AccountingExport;
    const bill = successful(billPlan(e, m), "90");
    const credit = successful(
      creditPlan(e.settlement!.credits![0]!.recognition, m, bill),
      "91",
    );
    const plan = paymentPlan(e, m, bill, [credit]);
    const root = await mkdtemp(join(tmpdir(), "qbo-location-recovery-"));
    let external: Record<string, any> | undefined;
    const requestIds: string[] = [];
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      });
    const transport: Transport = async (input, init = {}) => {
      const u = new URL(String(input)),
        path = u.pathname;
      if (path.endsWith("/companyinfo/123"))
        return json({ CompanyInfo: { Id: "123", Country: "US" } });
      if (path.endsWith("/vendor/5"))
        return json({
          Vendor: {
            Id: "5",
            Active: true,
            DisplayName: "Golden State Produce Co.",
          },
        });
      for (const a of Object.values(m.accounts))
        if (path.endsWith(`/account/${a.id}`))
          return json({
            Account: {
              Id: a.id,
              Active: true,
              Name: a.name,
              AccountType: a.type,
            },
          });
      if (path.endsWith("/class/9"))
        return json({ Class: { Id: "9", Active: true, Name: "SF" } });
      if (path.endsWith("/department/11"))
        return json({
          Department: { Id: "11", Active: true, Name: "Operations" },
        });
      if (path.endsWith("/preferences"))
        return json({
          Preferences: { AccountingInfoPrefs: { TrackDepartments: true } },
        });
      if (path.endsWith("/query"))
        return json({
          QueryResponse: external ? { BillPayment: [external] } : {},
        });
      if (path.endsWith("/billpayment") && init.method === "POST") {
        requestIds.push(u.searchParams.get("requestid")!);
        external = {
          ...JSON.parse(String(init.body)),
          Id: "92",
          SyncToken: "0",
        };
        throw Error("synthetic response lost after provider commits");
      }
      if (path.endsWith("/billpayment/92"))
        return json({ BillPayment: external });
      throw Error(`unexpected mock route ${path}`);
    };
    const client = new QboClient({
      config: { realmId: "123" },
      transport,
      access: async () => "synthetic-token",
    } as unknown as OAuth);
    const journal = new SyncJournal(new PrivateStore(root), client);
    const authorization = {
      subject: e.authorizedSubject,
      planHash: hash(plan),
      decidedAt: Date.now(),
    };
    try {
      await expect(
        journal.execute(plan, m, undefined, authorization),
      ).rejects.toThrow("qbo_transport_unknown");
      const unknown = await journal.get(plan);
      expect(unknown!.state).toBe("unknown");
      expect(unknown!.submissionAuthorization).toEqual(authorization);
      const recovered = await journal.execute(plan, m, undefined, {
        ...authorization,
        subject: "later-reader",
      });
      expect(recovered.state).toBe("succeeded");
      expect(recovered.requestId).toBe(unknown!.requestId);
      expect(recovered.submissionAuthorization).toEqual(authorization);
      expect(requestIds).toEqual([unknown!.requestId]);
      external!.DepartmentRef = { value: "12" };
      await expect(client.verify(recovered)).rejects.toThrow(
        "external_stale_or_changed",
      );
      external!.DepartmentRef = { value: "11" };
      await client.verify(recovered);
      expect((await journal.get(plan))!.externalId).toBe("92");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
