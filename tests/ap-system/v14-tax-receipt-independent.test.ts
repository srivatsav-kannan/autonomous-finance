import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFunctionReference } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";
import { taxFixture, taxMappings } from "./quickbooks-tax-fixture";
import { billPlan } from "../../src/ap-system/quickbooks/plans";
import { closePlan, QuickBooksCloseDispatcher } from "../../src/ap-system/quickbooks/close-sync";
import { recoverCloseReceipt } from "../../src/ap-system/quickbooks/close-recovery";
import { createQBOCloseBridge } from "../../src/ap-system/quickbooks/close-runtime";
import { PrivateStore, hash } from "../../src/ap-system/quickbooks/private-store";
import { SyncJournal } from "../../src/ap-system/quickbooks/sync";
import { OAuth, CALLBACK, type Transport } from "../../src/ap-system/quickbooks/oauth";
import { QboClient } from "../../src/ap-system/quickbooks/client";
import type { Operation, Plan } from "../../src/ap-system/quickbooks/types";

// Reuse synthetic approved-domain setup only; this harness and every assertion are V14-owned.
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const stored = (plan: Plan, state: Operation["state"] = "succeeded"): Operation => ({ ...plan, payloadHash: hash(plan), requestId: `ap-${hash({ realm: plan.realmId, identity: plan.identity }).slice(0,44)}`, state, attempts: 1, createdAt: 1, updatedAt: 1, externalId: state === "succeeded" ? "100" : null, syncToken: state === "succeeded" ? "0" : null, lastError: null, responseHash: null, submissionAuthorization: { subject: plan.links.closeSubmittingSubject ?? "synthetic-original-writer", planHash: hash(plan), decidedAt: 1 } });
async function fixture() {
  const f = await taxFixture(), dir = await mkdtemp(join(tmpdir(), "ap-v14-")); dirs.push(dir);
  const store = new PrivateStore(dir), original = stored(billPlan(f.invoice, taxMappings));
  const e = await f.load(f.request), plan = closePlan(e, f.request, taxMappings, original);
  const sent = stored(plan, "unknown");
  let response: unknown = { QueryResponse: { JournalEntry: [{ ...plan.payload, Id: "222", SyncToken: "3" }] } };
  const calls: { method: string; path: string }[] = [];
  const transport: Transport = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push({ method: init.method ?? "GET", path: u.pathname });
    expect(u.origin).toBe("https://sandbox-quickbooks.api.intuit.com");
    expect(u.pathname).toMatch(/^\/v3\/company\/123\//);
    return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
  };
  const oauth = new OAuth({ clientId: "v14", clientSecret: "synthetic", realmId: "123", environment: "sandbox", redirectUri: CALLBACK }, store, transport);
  oauth.access = vi.fn(async () => "synthetic-token");
  const journal = new SyncJournal(store, new QboClient(oauth));
  await store.write(journal.key(original), original);
  await store.write(journal.key(sent), sent);
  const access = await f.access(f.request);
  return { f, dir, store, original, e, plan, sent, journal, calls, transport, oauth, access,
    respond: (value: unknown) => { response = value; },
    retire: async () => f.t.run(async ctx => { for (const row of await ctx.db.query("apBusinessPolicies").collect()) await ctx.db.patch(row._id, { status: "superseded" }); }),
    save: async (op: Operation) => store.write(journal.key(sent), op),
  };
}

describe("V14 independent tax receipt and authority probes", () => {
  it("derives the exact reviewed noncash USD transfer and freezes original approval plus submitting identity", async () => {
    const p = await fixture();
    expect(p.plan.payload.CurrencyRef).toEqual({ value: "USD" });
    expect(p.plan.payload.Line).toEqual([
      { Amount: 3.85, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "4" }, Entity: { Type: "Vendor", EntityRef: { value: "5" } }, ClassRef: { value: "9" }, DepartmentRef: { value: "11" } } },
      { Amount: 3.85, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "8" }, Entity: { Type: "Vendor", EntityRef: { value: "5" } }, ClassRef: { value: "9" }, DepartmentRef: { value: "11" } } },
    ]);
    expect(p.plan.links).toMatchObject({ closeActionId: p.f.request.actionId, closeApprovalHash: p.e.accounting.approval.hash, closeJournalHash: p.e.accounting.journal.hash, closeSubmittingSubject: p.e.authorizedSubject });
    expect(p.plan.links.closeAuthorityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(p.calls).toEqual([]);
  });
  it("rejects same-account netting and reversed pair order before contacting QBO", async () => {
    const p = await fixture();
    const same = structuredClone(p.e); same.accounting.journal.lines[1]!.account = same.accounting.journal.lines[0]!.account;
    expect(() => closePlan(same,p.f.request,taxMappings,p.original)).toThrow("tax_movement_binding_conflict");
    const reverse = structuredClone(p.e); reverse.accounting.journal.lines.reverse();
    expect(() => closePlan(reverse,p.f.request,taxMappings,p.original)).toThrow("tax_movement_binding_conflict");
    expect(p.calls).toEqual([]);
  });
  it("rejects aliases collapsing tax and expense into one QBO account", async () => {
    const p = await fixture(), m = structuredClone(taxMappings); m.accounts["1180"]!.id = m.accounts["5000"]!.id;
    expect(() => closePlan(p.e,p.f.request,m,p.original)).toThrow("mapping_conflict"); expect(p.calls).toEqual([]);
  });
  it("checks the original Bill payload hash and currency, even when unrelated current mapping is valid", async () => {
    const p = await fixture();
    const changed = structuredClone(p.original); changed.payload.TotalAmt = 0;
    expect(() => closePlan(p.e,p.f.request,taxMappings,changed)).toThrow("tax_original_binding_conflict");
    const foreign = structuredClone(p.original); foreign.payload.CurrencyRef = { value: "EUR" };
    const { version, realmId, minorVersion, entity, identity, links, mappingHash, payload } = foreign;
    foreign.payloadHash = hash({ version, realmId, minorVersion, entity, identity, links, mappingHash, payload });
    expect(() => closePlan(p.e,p.f.request,taxMappings,foreign)).toThrow("tax_original_binding_conflict");
  });
  it("recovers concurrently only through GET and preserves every frozen field and original local Bill", async () => {
    const p = await fixture(); await p.retire(); const before = JSON.stringify(await p.f.state());
    const results = await Promise.all([recoverCloseReceipt(p.journal,p.f.request,p.f.access), recoverCloseReceipt(p.journal,p.f.request,p.f.access).catch(e => e)]);
    // After the first find succeeds, the second must verify the saved external ID; supply of a query envelope is deliberately insufficient for that GET.
    expect(results[0]).toMatchObject({ state: "succeeded", externalId: "222", syncToken: "3", requestId: p.sent.requestId, payloadHash: p.sent.payloadHash, submissionAuthorization: p.sent.submissionAuthorization, attempts: 1 });
    expect(results[1]).toBeInstanceOf(Error);
    expect(p.calls).toEqual([{method:"GET",path:"/v3/company/123/query"},{method:"GET",path:"/v3/company/123/journalentry/222"}]);
    expect(await p.journal.get(p.original)).toEqual(p.original);
    expect(JSON.stringify(await p.f.state())).toBe(before);
  });
  it.each([
    ["missing envelope", {}, "qbo_query_envelope_invalid"],
    ["malformed rows", { QueryResponse: { JournalEntry: {} } }, "qbo_query_envelope_invalid"],
    ["incomplete count", { QueryResponse: { JournalEntry: [], totalCount: 1 } }, "qbo_query_incomplete"],
  ])("keeps sent receipt unchanged on %s", async (_name,response,error) => {
    const p = await fixture(); p.respond(response);
    await expect(recoverCloseReceipt(p.journal,p.f.request,p.f.access)).rejects.toThrow(String(error));
    expect(await p.journal.get(p.sent)).toEqual(p.sent); expect(p.calls.every(c=>c.method==="GET")).toBe(true);
  });
  it("rejects duplicate exact records rather than choosing one", async () => {
    const p = await fixture(); const row = { ...p.plan.payload, Id: "222", SyncToken: "3" };
    p.respond({ QueryResponse: { JournalEntry: [row, { ...row, Id: "223" }] } });
    await expect(recoverCloseReceipt(p.journal,p.f.request,p.f.access)).rejects.toThrow("external_mapping_conflict"); expect(await p.journal.get(p.sent)).toEqual(p.sent);
  });
  it("rejects provider-added or removed financial dimensions without writing a successful receipt", async () => {
    const p = await fixture(), payload = structuredClone(p.plan.payload) as any;
    payload.Line[0].JournalEntryLineDetail.ProjectRef = { value: "999" };
    p.respond({ QueryResponse: { JournalEntry: [{ ...payload, Id: "222", SyncToken: "3" }] } });
    await expect(recoverCloseReceipt(p.journal,p.f.request,p.f.access)).rejects.toThrow("external_mapping_conflict");
    delete payload.Line[0].JournalEntryLineDetail.ProjectRef; delete payload.Line[0].JournalEntryLineDetail.DepartmentRef;
    p.respond({ QueryResponse: { JournalEntry: [{ ...payload, Id: "222", SyncToken: "3" }] } });
    await expect(recoverCloseReceipt(p.journal,p.f.request,p.f.access)).rejects.toThrow("external_mapping_conflict"); expect(await p.journal.get(p.sent)).toEqual(p.sent);
  });
  it("unknown-not-found remains unknown on repeated recovery without minting a replacement request", async () => {
    const p = await fixture(); p.respond({ QueryResponse: {} });
    for(let i=0;i<2;i++) expect(await recoverCloseReceipt(p.journal,p.f.request,p.f.access)).toMatchObject({state:"unknown",lastError:"unknown_not_found_no_repost",requestId:p.sent.requestId,attempts:1,submissionAuthorization:p.sent.submissionAuthorization});
    expect(p.calls).toHaveLength(2); expect(p.calls.every(c=>c.method==="GET")).toBe(true);
  });
  it.each(["prepared","rejected","conflict"] as const)("never recovers an ineligible %s operation", async state => {
    const p = await fixture(); await p.save({...p.sent,state});
    await expect(recoverCloseReceipt(p.journal,p.f.request,p.f.access)).rejects.toThrow("sent_tax_receipt_required"); expect(p.calls).toEqual([]);
  });
  it("rejects stale, future, cross-environment and swapped-action access before token use", async () => {
    const p = await fixture();
    for (const access of [
      {...p.access,accessedAt:Date.now()-31000}, {...p.access,accessedAt:Date.now()+6000},
      {...p.access,scope:{...p.access.scope,environment:"production" as any}}, {...p.access,approvalId:"other"},
    ]) await expect(recoverCloseReceipt(p.journal,p.f.request,async()=>access)).rejects.toThrow("fresh_tax_receipt_access_required");
    expect(p.oauth.access).not.toHaveBeenCalled(); expect(p.calls).toEqual([]);
  });
  it("rechecks a still-identical reader's journal authority after acquiring the lock", async () => {
    const p = await fixture(); let count = 0;
    await expect(recoverCloseReceipt(p.journal,p.f.request,async()=>({...p.access,accessedAt:Date.now(),journalHash:++count===1?p.access.journalHash:"f".repeat(64)}))).rejects.toThrow("receipt_authority_changed");
    expect(p.calls).toEqual([]);
  });
  it("rejects an altered approved action and altered posted journal in the real authenticated backend read", async () => {
    const p = await fixture(); await p.f.t.run(async ctx=>{const a=await ctx.db.get(p.f.request.actionId as any); await ctx.db.patch(a!._id,{amountCents:386} as any);});
    await expect(p.f.access(p.f.request)).rejects.toThrow("tax_receipt_approval_changed");
    const q = await fixture(); await q.f.t.run(async ctx=>{const a=await ctx.db.get(q.f.request.actionId as any) as any;const j=await ctx.db.get(a.entryId) as any;await ctx.db.patch(j._id,{lines:j.lines.map((l:any,i:number)=>i?l:{...l,debit:l.debit+1})});});
    await expect(q.f.access(q.f.request)).rejects.toThrow(/journal.*hash|hash.*journal/);
  });
  it("retiring original authorizer does not substitute the new active read-only operator into the receipt", async () => {
    const p = await fixture(); await p.retire();
    await p.f.t.run(async ctx=>{const s=(await ctx.db.query("seats").collect()).find(s=>s.seatId==="human-finance")!;await ctx.db.patch(s._id,{status:"retired"});});
    await expect(p.f.access(p.f.request)).rejects.toThrow();
    const reader=()=>p.f.humans.owner!.query(makeFunctionReference<"query">("apAccountingReceiptAccess:tax"),{scope:p.f.scope,input:p.f.request});
    expect((await reader()).authorizedSubject).not.toBe(p.sent.submissionAuthorization!.subject);
    const recovered=await recoverCloseReceipt(p.journal,p.f.request,reader);
    expect(recovered.submissionAuthorization).toEqual(p.sent.submissionAuthorization);
  });
  it("exposes historical status without token acquisition and denies new preview/submit with valid mappings present", async () => {
    const p=await fixture(); await p.retire(); await p.store.write("mappings.json",taxMappings);
    vi.stubGlobal("fetch",p.transport); const token=vi.spyOn(OAuth.prototype,"access").mockResolvedValue("synthetic-token");
    const bridge=createQBOCloseBridge(p.f.humans.owner as unknown as ConvexHttpClient,p.f.scope,{QBO_CLIENT_ID:"v14",QBO_CLIENT_SECRET:"synthetic",QBO_REALM_ID:"123",QBO_ENVIRONMENT:"sandbox",QBO_REDIRECT_URI:CALLBACK,QBO_PRIVATE_DIR:p.dir});
    expect(await bridge.status(p.f.request)).toMatchObject({authority:"historical_receipt_only",externalWritesAllowed:false,externalReadsAllowed:true,receipts:[{state:"unknown"}]});
    await expect(bridge.preview(p.f.request)).rejects.toThrow();
    await expect(bridge.submit(p.f.request,hash(p.plan))).rejects.toThrow();
    expect(token).not.toHaveBeenCalled(); expect(p.calls).toEqual([]);
    expect(await bridge.verify(p.f.request)).toMatchObject({operation:{state:"succeeded",requestId:p.sent.requestId}});
    expect(p.calls).toEqual([{method:"GET",path:"/v3/company/123/query"}]);
  });
  it("halts new submission if the current submitter changes between preview and final authority check", async () => {
    const p=await fixture(); await rm(join(p.dir,p.journal.key(p.sent))); let loads=0;
    vi.spyOn(p.journal.client,"verifyMappings").mockResolvedValue({realmId:"123",country:"US",mappingHash:hash(taxMappings)});
    vi.spyOn(p.journal.client,"find").mockResolvedValue(undefined);
    vi.spyOn(p.journal.client,"verify").mockResolvedValue({});
    const create=vi.spyOn(p.journal.client,"create");
    const d=new QuickBooksCloseDispatcher(async r=>({...await p.f.load(r),authorizedSubject:++loads===1?p.e.authorizedSubject:"other-current-human"}),taxMappings,p.journal);
    await expect(d.run(p.f.request,"submit",{expectedPlanHash:hash(p.plan)})).rejects.toThrow("submission_identity_changed");
    expect(create).not.toHaveBeenCalled(); expect(p.calls).toEqual([]);
  });
});
