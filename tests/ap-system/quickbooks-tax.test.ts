import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";
import { taxFixture, taxMappings } from "./quickbooks-tax-fixture";
import { successful } from "./quickbooks-business-fixture";
import { billPlan } from "../../src/ap-system/quickbooks/plans";
import {
  closePlan,
  QuickBooksCloseDispatcher,
  type CloseExportLoader,
} from "../../src/ap-system/quickbooks/close-sync";
import { recoverCloseReceipt } from "../../src/ap-system/quickbooks/close-recovery";
import { createQBOCloseBridge } from "../../src/ap-system/quickbooks/close-runtime";
import { QboClient } from "../../src/ap-system/quickbooks/client";
import {
  PrivateStore,
  hash,
} from "../../src/ap-system/quickbooks/private-store";
import {
  OAuth,
  CALLBACK,
  type Transport,
} from "../../src/ap-system/quickbooks/oauth";
import { SyncJournal } from "../../src/ap-system/quickbooks/sync";
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function protocol(
  f: Awaited<ReturnType<typeof taxFixture>>,
  load: CloseExportLoader = f.load,
) {
  const dir = await mkdtemp(join(tmpdir(), "qbo-tax-"));
  dirs.push(dir);
  const store = new PrivateStore(dir);
  const originalPlan = billPlan(f.invoice, taxMappings);
  const original = {
    ...successful(originalPlan, "90"),
    payloadHash: hash(originalPlan),
  };
  const rows = new Map<string, any>([
      ["90", { ...original.payload, Id: "90", SyncToken: "0" }],
    ]),
    posts: any[] = [],
    calls: any[] = [];
  let lose = false,
    empty = false;
  const json = (x: unknown) =>
    new Response(JSON.stringify(x), {
      headers: { "Content-Type": "application/json" },
    });
  const transport: Transport = async (input, init = {}) => {
    const u = new URL(String(input)),
      id = u.pathname.split("/").at(-1)!;
    calls.push({ path: u.pathname, method: init.method });
    expect(u.origin).toBe("https://sandbox-quickbooks.api.intuit.com");
    if (u.pathname.includes("/companyinfo/"))
      return json({ CompanyInfo: { Id: "123", Country: "US" } });
    if (u.pathname.includes("/account/")) {
      const a = Object.values(taxMappings.accounts).find((a) => a.id === id)!;
      return json({
        Account: { Id: id, Active: true, Name: a.name, AccountType: a.type },
      });
    }
    if (u.pathname.includes("/vendor/"))
      return json({
        Vendor: {
          Id: id,
          Active: true,
          DisplayName: "Golden State Produce Co.",
        },
      });
    if (u.pathname.includes("/class/"))
      return json({ Class: { Id: id, Active: true, Name: "SF" } });
    if (u.pathname.includes("/department/"))
      return json({ Department: { Id: id, Active: true, Name: "Operations" } });
    if (id === "preferences")
      return json({
        Preferences: { AccountingInfoPrefs: { TrackDepartments: true } },
      });
    if (id === "query") {
      const marker = u.searchParams
        .get("query")!
        .match(/DocNumber = '([^']+)'/)![1];
      return json({
        QueryResponse: empty
          ? {}
          : {
              JournalEntry: [...rows.values()].filter(
                (r) => r.DocNumber === marker,
              ),
            },
      });
    }
    if (init.method === "POST") {
      expect(id).toBe("journalentry");
      const body = JSON.parse(String(init.body));
      posts.push({ body, requestId: u.searchParams.get("requestid") });
      const r = { ...body, Id: String(91 + posts.length), SyncToken: "0" };
      rows.set(r.Id, r);
      if (lose) throw Error("synthetic lost response");
      return json({ JournalEntry: r });
    }
    return json(
      u.pathname.includes("/bill/")
        ? { Bill: rows.get(id) }
        : { JournalEntry: rows.get(id) },
    );
  };
  const oauth = new OAuth(
    {
      clientId: "mock",
      clientSecret: "mock",
      realmId: "123",
      environment: "sandbox",
      redirectUri: CALLBACK,
    },
    store,
    transport,
  );
  oauth.access = async () => "synthetic-token";
  const journal = new SyncJournal(store, new QboClient(oauth));
  await store.write(journal.key(original), original);
  const dispatcher = new QuickBooksCloseDispatcher(load, taxMappings, journal);
  async function submit() {
    const p = await dispatcher.run(f.request);
    if (!p.plan) throw Error(p.hold?.code);
    const r = await dispatcher.run(f.request, "submit", {
      expectedPlanHash: hash(p.plan),
    });
    if (!r.operation) throw Error(r.hold?.code);
    return r.operation;
  }
  return {
    store,
    dir,
    rows,
    posts,
    calls,
    journal,
    dispatcher,
    submit,
    original,
    transport,
    lose: () => {
      lose = true;
    },
    empty: (value = true) => {
      empty = value;
    },
  };
}
describe("approved tax reclassification QBO adapter", () => {
  it("replicates only exact noncash tax journal lines, preserving original Bill, dimensions and immutable authority", async () => {
    const f = await taxFixture(),
      p = await protocol(f),
      e = await f.load(f.request);
    const preview = await p.dispatcher.run(f.request);
    expect(p.calls).toHaveLength(0);
    expect(preview.plan!.links.closeApprovalHash).toBe(
      e.accounting.approval.hash,
    );
    expect(preview.plan!.payload.Line).toEqual(
      ["4", "8"].map((id, i) => ({
        Amount: 3.85,
        DetailType: "JournalEntryLineDetail",
        JournalEntryLineDetail: {
          PostingType: i ? "Credit" : "Debit",
          AccountRef: { value: id },
          Entity: { Type: "Vendor", EntityRef: { value: "5" } },
          ClassRef: { value: "9" },
          DepartmentRef: { value: "11" },
        },
      })),
    );
    const op = await p.submit();
    await p.journal.client.verify(op);
    expect(await p.submit()).toMatchObject({
      externalId: op.externalId,
      requestId: op.requestId,
    });
    expect(p.posts).toHaveLength(1);
    expect(p.rows.get("90")).toEqual({
      ...p.original.payload,
      Id: "90",
      SyncToken: "0",
    });
    const state = await f.state();
    expect(state.journals[0]).toEqual(f.before.journals[0]);
    expect(state.bills.map((b) => b.entryId)).toEqual(
      f.before.bills.map((b) => b.entryId),
    );
    expect(state.commands).toHaveLength(0);
    p.rows.get(
      op.externalId!,
    ).Line[0].JournalEntryLineDetail.DepartmentRef.value = "99";
    await expect(p.journal.client.verify(op)).rejects.toThrow(
      "external_stale_or_changed",
    );
  });
  it("holds absent or mismatched tax-account mapping without provider access", async () => {
    const f = await taxFixture(),
      p = await protocol(f),
      e = await f.load(f.request);
    const missing = structuredClone(taxMappings);
    delete missing.accounts["1180"];
    expect(() =>
      closePlan(e, f.request, missing, {
        ...p.original,
        mappingHash: hash(missing),
      }),
    ).toThrow("close_account_mapping_required");
    const wrong = structuredClone(taxMappings);
    wrong.accounts["1180"]!.type = "Bank";
    expect(() =>
      closePlan(e, f.request, wrong, {
        ...p.original,
        mappingHash: hash(wrong),
      }),
    ).toThrow("tax_account_mapping_conflict");
    expect(p.calls).toHaveLength(0);
  });
  it("rejects unrelated source/original, altered authority, cash/AP/accrual substitution and cross-dimension moves", async () => {
    const f = await taxFixture(),
      p = await protocol(f),
      e = await f.load(f.request);
    for (const mutate of [
      (x: typeof e) => {
        x.accounting.journal.source.ref = "unrelated";
      },
      (x: typeof e) => {
        x.accounting.billId = "unrelated";
      },
      (x: typeof e) => {
        x.accounting.approval.id = "foreign";
      },
      (x: typeof e) => {
        x.accounting.journal.lines[0]!.account = "1000";
      },
      (x: typeof e) => {
        x.accounting.journal.lines[0]!.account = "2010";
      },
      (x: typeof e) => {
        x.accounting.journal.lines[0]!.department = null;
      },
    ]) {
      const changed = structuredClone(e);
      mutate(changed);
      expect(() =>
        closePlan(changed, f.request, taxMappings, p.original),
      ).toThrow();
    }
    const changed = structuredClone(e);
    changed.accounting.approval.hash = "0".repeat(64);
    expect(
      hash(closePlan(changed, f.request, taxMappings, p.original)),
    ).not.toBe(hash(closePlan(e, f.request, taxMappings, p.original)));
  });
  it("retains the explicit unsupported project-entity/billability hold", async () => {
    const f = await taxFixture(),
      p = await protocol(f),
      e = await f.load(f.request);
    e.accounting.journal.lines.forEach((l) => {
      l.project = "reviewed-project";
    });
    expect(() => closePlan(e, f.request, taxMappings, p.original)).toThrow(
      "journal_project_entity_or_billability_unsupported",
    );
  });
  it("rechecks current approval immediately before a new POST", async () => {
    const f = await taxFixture();
    let reads = 0;
    const p = await protocol(f, async (r) => {
      reads++;
      if (reads === 3)
        await f.t.run(async (ctx) => {
          const seat = (await ctx.db.query("seats").collect()).find(
            (s) => s.seatId === "human-owner",
          )!;
          await ctx.db.patch(seat._id, { status: "retired" });
        });
      return f.load(r);
    });
    await expect(p.submit()).rejects.toThrow("sync_failed");
    expect(p.posts).toHaveLength(0);
  });
  it("recovers a sent unknown request after policy retirement with no new POST, mapping read or replacement authorizer", async () => {
    const f = await taxFixture(),
      p = await protocol(f);
    p.lose();
    await expect(p.submit()).rejects.toThrow("qbo_transport_unknown");
    const preview = await p.dispatcher.run(f.request);
    const old = (await p.journal.get(preview.plan!))!;
    await f.t.run(async (ctx) => {
      for (const r of await ctx.db.query("apBusinessPolicies").collect())
        await ctx.db.patch(r._id, { status: "superseded" });
    });
    await expect(f.load(f.request)).rejects.toThrow();
    const before = p.calls.length;
    const recoveryReader = async () =>
      f.humans.owner!.query(
        makeFunctionReference<"query">("apAccountingReceiptAccess:tax"),
        { scope: f.scope, input: f.request },
      );
    const recovered = await recoverCloseReceipt(p.journal, f.request, recoveryReader);
    expect(recovered.state).toBe("succeeded");
    expect(recovered.requestId).toBe(old.requestId);
    expect(recovered.submissionAuthorization).toEqual(
      old.submissionAuthorization,
    );
    expect(p.posts).toHaveLength(1);
    expect(p.calls.slice(before).every((c) => c.method === "GET")).toBe(true);
    await recoverCloseReceipt(p.journal, f.request, f.access);
    expect(p.posts).toHaveLength(1);
  });
  it("keeps unknown not-found evidence pending and rejects prepared records, forgery and changing recovery identity", async () => {
    const f = await taxFixture(),
      p = await protocol(f);
    const preview = await p.dispatcher.run(f.request);
    await expect(
      recoverCloseReceipt(p.journal, f.request, f.access),
    ).rejects.toThrow("sent_tax_receipt_required");
    p.lose();
    await expect(p.submit()).rejects.toThrow();
    p.empty();
    const op = await recoverCloseReceipt(p.journal, f.request, f.access);
    expect(op.state).toBe("unknown");
    expect(op.lastError).toBe("unknown_not_found_no_repost");
    expect(p.posts).toHaveLength(1);
    let reads = 0;
    const accessQuery = makeFunctionReference<"query">(
      "apAccountingReceiptAccess:tax",
    );
    await expect(
      recoverCloseReceipt(p.journal, f.request, async (r) => {
        if (++reads === 1) return f.access(r);
        return f.humans.owner!.query(accessQuery, { scope: f.scope, input: r });
      }),
    ).rejects.toThrow("receipt_identity_changed");
    await p.store.write(p.journal.key(op), { ...op, state: "prepared" });
    await expect(
      recoverCloseReceipt(p.journal, f.request, f.access),
    ).rejects.toThrow("sent_tax_receipt_required");
    await p.store.write(p.journal.key(op), {
      ...op,
      submissionAuthorization: {
        ...op.submissionAuthorization!,
        subject: "not-the-original-writer",
      },
    });
    await expect(
      recoverCloseReceipt(p.journal, f.request, f.access),
    ).rejects.toThrow("immutable_tax_receipt_conflict");
    const changed = { ...op, mappingHash: "0".repeat(64) };
    await p.store.write(p.journal.key(op), changed);
    await expect(
      recoverCloseReceipt(p.journal, f.request, f.access),
    ).rejects.toThrow("immutable_tax_receipt_conflict");
    expect(p.posts).toHaveLength(1);
  });
  it("denies missing, retired and cross-scope human receipt access", async () => {
    const f = await taxFixture(),
      query = makeFunctionReference<"query">("apAccountingReceiptAccess:tax");
    await expect(
      f.t.query(query, { scope: f.scope, input: f.request }),
    ).rejects.toThrow(/human/);
    await expect(
      f.humans.finance!.query(query, {
        scope: { ...f.scope, runId: "other" },
        input: f.request,
      }),
    ).rejects.toThrow(/scope|mismatch/);
    await f.t.run(async (ctx) => {
      const s = (await ctx.db.query("seats").collect()).find(
        (s) => s.seatId === "human-finance",
      )!;
      await ctx.db.patch(s._id, { status: "retired" });
    });
    await expect(f.access(f.request)).rejects.toThrow(/active human/);
  });
  it("wires explicit verify to saved tax recovery after current policy retirement and missing current mappings", async () => {
    const f = await taxFixture(),
      p = await protocol(f);
    p.lose();
    await expect(p.submit()).rejects.toThrow();
    await f.t.run(async (ctx) => {
      for (const r of await ctx.db.query("apBusinessPolicies").collect())
        await ctx.db.patch(r._id, { status: "superseded" });
    });
    vi.stubGlobal("fetch", p.transport);
    vi.spyOn(OAuth.prototype, "access").mockResolvedValue("mock-token");
    const bridge = createQBOCloseBridge(
      f.humans.finance as unknown as ConvexHttpClient,
      f.scope,
      {
        QBO_CLIENT_ID: "mock",
        QBO_CLIENT_SECRET: "mock",
        QBO_REALM_ID: "123",
        QBO_ENVIRONMENT: "sandbox",
        QBO_REDIRECT_URI: CALLBACK,
        QBO_PRIVATE_DIR: p.dir,
      },
    );
    const beforeStatus = p.calls.length;
    const status = await bridge.status(f.request);
    expect(status).toMatchObject({
      authority: "historical_receipt_only",
      externalWritesAllowed: false,
      externalReadsAllowed: true,
      complete: true,
      receipts: [{ state: "unknown" }],
      holds: [{ code: "current_tax_authority_unavailable" }],
    });
    expect(p.calls).toHaveLength(beforeStatus);
    await expect(bridge.preview(f.request)).rejects.toThrow();
    await expect(bridge.submit(f.request, "0".repeat(64))).rejects.toThrow();
    expect(p.posts).toHaveLength(1);
    p.empty();
    const pending = await bridge.verify(f.request);
    expect(pending.hold?.code).toBe("unknown_not_found_no_repost");
    expect(pending).not.toHaveProperty("verifiedAt");
    p.empty(false);
    const result = await bridge.verify(f.request);
    expect(result.operation?.state).toBe("succeeded");
    expect(p.posts).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
