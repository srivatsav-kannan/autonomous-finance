import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuth, CALLBACK } from "../../src/ap-system/quickbooks/oauth";
import { QboClient } from "../../src/ap-system/quickbooks/client";
import { PrivateStore, hash } from "../../src/ap-system/quickbooks/private-store";
import { QuickBooksDispatcher, SyncJournal } from "../../src/ap-system/quickbooks/sync";
import type { ExportLoader, ExportRequest, Mappings, Operation } from "../../src/ap-system/quickbooks/types";
import { creditFixture, promoteIncrease, seedSettled } from "./quickbooks-business-fixture";
import { returnedFixture } from "./quickbooks-corrections-fixture";
const paths: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(paths.splice(0).map(path => rm(path,{recursive:true,force:true}))); });
const mappings: Mappings = { version:"v5-reviewed",realmId:"123",country:"US",classes:{"sf-hayes-valley":{id:"9",name:"SF Hayes Valley"}},vendors:{"golden-state-produce":{id:"5",displayName:"Golden State Produce Co."}},accounts:{"2000":{id:"33",name:"AP",type:"Accounts Payable"},"1000":{id:"35",name:"Bank",type:"Bank"},"5000":{id:"7",name:"Produce",type:"Expense"},"5100":{id:"8",name:"Discount",type:"Expense"}},apAccount:"2000",bankAccount:"1000" };
const json = (x: unknown) => new Response(JSON.stringify(x), { headers:{"Content-Type":"application/json"} });
// Test-owned HTTP protocol only. Original accounting expectations are literal assertions below.
async function protocol(load: ExportLoader) {
  const path = await mkdtemp(join(tmpdir(),"v5-qbo-")); paths.push(path);
  const store = new PrivateStore(path), rows = new Map<string, any>(), posts: Array<{entity:string;body:any;requestId:string}> = [];
  let count=0, loseNextJournal=false, vendorResponse: unknown=undefined;
  const oauth = new OAuth({clientId:"v5-synthetic",clientSecret:"v5-synthetic",realmId:"123",environment:"sandbox",redirectUri:CALLBACK},store,async(input,init={})=>{
    count++; const u=new URL(String(input));
    if(u.hostname==="oauth.platform.intuit.com")return json({access_token:"synthetic-v5-access",refresh_token:"synthetic-v5-refresh",token_type:"bearer",expires_in:3600,x_refresh_token_expires_in:86400});
    expect(u.origin).toBe("https://sandbox-quickbooks.api.intuit.com"); expect(init.redirect).toBe("error");
    const bits=u.pathname.split("/"), last=bits.at(-1)!;
    if(u.pathname.includes("/companyinfo/"))return json({CompanyInfo:{Id:"123",Country:"US"}});
    if(u.pathname.includes("/class/"))return json({Class:{Id:"9",Name:"SF Hayes Valley",Active:true}});
    if(u.pathname.includes("/vendor/"))return json({Vendor:{Id:"5",Active:true,DisplayName:"Golden State Produce Co."}});
    if(u.pathname.includes("/account/")){const a=Object.values(mappings.accounts).find(a=>a.id===last)!;return json({Account:{Id:a.id,Name:a.name,AccountType:a.type,Active:true}});}
    if(last==="query") {
      const query=u.searchParams.get("query")!;
      if(query.includes("WHERE VendorRef"))return json(vendorResponse ?? {QueryResponse:{BillPayment:[...rows.entries()].filter(([k])=>k.startsWith("BillPayment:")).map(([,v])=>v)}});
      const match=query.match(/^SELECT \* FROM (\w+) WHERE DocNumber = '([^']+)' MAXRESULTS 1000$/)!;
      return json({QueryResponse:{[match[1]!]:[...rows.entries()].filter(([k,v])=>k.startsWith(match[1]+":")&&v.DocNumber===match[2]).map(([,v])=>v)}});
    }
    const type=({bill:"Bill",billpayment:"BillPayment",vendorcredit:"VendorCredit",journalentry:"JournalEntry"} as Record<string,string>)[init.method==="POST"?last:bits.at(-2)!]!;
    if(init.method==="POST"){
      const body=JSON.parse(String(init.body)), id=String(900+posts.length);posts.push({entity:type,body,requestId:u.searchParams.get("requestid")!});
      const value={...body,Id:id,SyncToken:"0",...(["Bill","VendorCredit"].includes(type)?{Balance:body.TotalAmt}:{})};rows.set(`${type}:${id}`,value);
      if(type==="JournalEntry"&&loseNextJournal){loseNextJournal=false;throw Error("synthetic accepted then lost response");}
      return json({[type]:value});
    }
    return json({[type]:rows.get(`${type}:${last}`)});
  });
  const auth=new URL(await oauth.begin("e".repeat(64))),cb=new URL(CALLBACK);cb.search=new URLSearchParams({state:auth.searchParams.get("state")!,realmId:"123",code:"synthetic"}).toString();await oauth.complete(cb,"e".repeat(64));
  const client=new QboClient(oauth,async()=>{}),journal=new SyncJournal(store,client),dispatcher=new QuickBooksDispatcher(load,mappings,journal);
  const preview=async(r:ExportRequest)=>{const x=await dispatcher.run(r);if(!("plan"in x)||!x.plan)throw Error("Unexpected hold "+JSON.stringify(x));return x.plan;};
  const submit=async(r:ExportRequest)=>{const plan=await preview(r),x=await dispatcher.run(r,"submit",{expectedPlanHash:hash(plan)});if(!("operation"in x)||!x.operation)throw Error("Unexpected hold");return x.operation;};
  return {path,store,rows,posts,oauth,client,journal,dispatcher,load,preview,submit,calls:()=>count,loseJournal:()=>{loseNextJournal=true;},setVendorResponse:(x:unknown)=>{vendorResponse=x;}};
}
async function returnedProtocol() {
  let h!:Awaited<ReturnType<typeof protocol>>, original!:Operation;
  const f=await returnedFixture(async(f,s)=>{
    h=await protocol(({caseId,...rest})=>s.load(caseId,rest));
    await h.submit({caseId:f.detail.caseId});
    original=await h.submit({caseId:f.detail.caseId,paymentVersionId:s.versionId});
  });
  const correction=await f.proposeCorrection();await f.voteCorrection(correction);await f.voteCorrection(correction,"finance");
  return {f,h,correction,original,request:{caseId:f.detail.caseId,correctionId:correction.proposalId}};
}
async function replacement() {
  const r=await returnedProtocol(),je=await r.h.submit(r.request);
  expect(await r.h.dispatcher.checkHolds({caseId:r.f.detail.caseId},{verify:true})).toEqual([]);
  const s=await seedSettled(r.f,2000,2000,[],"-v5-replacement");
  const a=await r.f.proposeCorrection({kind:"payment_allocation",caseId:r.f.detail.caseId,paymentVersionId:s.versionId,originalBillCents:0,restoredPayables:[{correctionId:r.correction.proposalId,amountCents:2000}],idempotencyKey:"v5-allocation",reason:"Exactly restore original returned cash once"});
  await r.f.voteCorrection(a);await r.f.voteCorrection(a,"finance");
  return {...r,je,allocation:a,replacementRequest:{caseId:r.f.detail.caseId,correctionId:a.proposalId}};
}
describe("V5 independent external accounting safeguards",()=>{
 it("preserves signed discount costs and a partial cash/credit application exactly without changing original Bill",async()=>{
   const f=await creditFixture(100),c=await f.credit("V5-DISCOUNT-CREDIT"),s=await seedSettled(f,2800,4000,[{creditId:c.creditId,amountCents:1200}],"-v5-discount");
   const h=await protocol(({caseId,...rest})=>s.load(caseId,rest));
   const bill=await h.submit({caseId:f.detail.caseId}),credit=await h.submit({caseId:c.caseId});
   expect(bill.payload.TotalAmt).toBe(76);expect((bill.payload.Line as any[]).map(x=>[x.AccountBasedExpenseLineDetail.AccountRef.value,x.Amount])).toEqual([["7",77],["8",-1]]);
   expect(credit.payload.TotalAmt).toBe(38);expect((credit.payload.Line as any[]).map(x=>[x.AccountBasedExpenseLineDetail.AccountRef.value,x.Amount])).toEqual([["7",38.5],["8",-.5]]);
   const request={caseId:f.detail.caseId,paymentVersionId:s.versionId},payment=await h.submit(request);
   expect(payment.payload).toMatchObject({TotalAmt:28,Line:[{Amount:40,LinkedTxn:[{TxnId:bill.externalId,TxnType:"Bill"}]},{Amount:12,LinkedTxn:[{TxnId:credit.externalId,TxnType:"VendorCredit"}]}]});
   expect((await h.submit(request)).requestId).toBe(payment.requestId);expect(h.posts).toHaveLength(3);expect(await h.journal.get(bill)).toEqual(bill);
   expect((await s.load()).detail.amounts).toMatchObject({acceptedCents:7600,creditedCents:1200,settledCents:2800,outstandingCents:3600});
 });
 it("rejects missing, wrong-plan, stale and future first-write authorizations while preserving zero attempts",async()=>{
   const f=await creditFixture(),s=await promoteIncrease(f),h=await protocol(({caseId,...rest})=>s.load(caseId,rest));const p=await h.preview({caseId:f.detail.caseId});
   const good={subject:"synthetic-writer",planHash:hash(p),decidedAt:Date.now()};
   for(const a of [undefined,{...good,planHash:"f".repeat(64)},{...good,decidedAt:Date.now()-30001},{...good,decidedAt:Date.now()+10000}])await expect(h.journal.execute(p,mappings,undefined,a)).rejects.toThrow("submission_authorization_required");
   expect(h.posts).toHaveLength(0);expect((await h.journal.get(p))?.attempts).toBe(0);
   const result=await h.journal.execute(p,mappings,undefined,{...good,decidedAt:Date.now()});expect(result.attempts).toBe(1);expect(h.posts).toHaveLength(1);
 });
 it("rejects a preview hash that does not match the authenticated plan before any provider call",async()=>{
   const f=await creditFixture(),s=await promoteIncrease(f),h=await protocol(({caseId,...rest})=>s.load(caseId,rest));const calls=h.calls();
   await expect(h.dispatcher.run({caseId:f.detail.caseId},"submit",{expectedPlanHash:"f".repeat(64)})).rejects.toThrow("preview_changed_before_write");
   expect(h.calls()).toBe(calls);expect(h.posts).toHaveLength(0);
 });
 it("recovers an accepted return journal after reopen without a new POST and resolves only covered historical holds",async()=>{
   const {f,h,request,original,correction}=await returnedProtocol();
   const base={caseId:f.detail.caseId};
   const unrelated=await h.journal.recordHold(base,{code:"unresolved_bank_activity",owner:"controller",reason:"Unrelated activity must remain owned",relatedIds:["unrelated-bank-row"]});
   await h.journal.recordHold({...base,paymentVersionId:f.versionId},{code:"return_accounting_remediation_required",owner:"controller",reason:"Exact original return",relatedIds:[f.transactionId]});
   const plan=await h.preview(request);h.loseJournal();await expect(h.submit(request)).rejects.toThrow("qbo_transport_unknown");
   const before=(await h.journal.get(plan))!;expect(before.state).toBe("unknown");
   const reopened=new SyncJournal(new PrivateStore(h.path),new QboClient(h.oauth));const after=await reopened.execute(plan,mappings);
   expect(after).toMatchObject({state:"succeeded",requestId:before.requestId,attempts:1,submissionAuthorization:before.submissionAuthorization});expect(h.posts).toHaveLength(3);
   expect((after.payload.Line as any[]).map(x=>[x.JournalEntryLineDetail.PostingType,x.JournalEntryLineDetail.AccountRef.value,x.Amount])).toEqual([["Debit","35",20],["Credit","33",20]]);
   expect(await h.journal.get(original)).toEqual(original);
   const quiet=h.calls();expect(await h.dispatcher.checkHolds(base)).toMatchObject([{code:"return_correction_sync_required"}]);expect(h.calls()).toBe(quiet);
   expect(await h.dispatcher.checkHolds(base,{verify:true})).toEqual([]);
   const files=await import("node:fs/promises").then(m=>m.readdir(h.path));const holds=await Promise.all(files.filter(x=>x.startsWith("hold-")).map(x=>h.store.read<any>(x)));
   expect(holds.find(x=>x.code===unrelated.code).state).toBe("held");expect(holds.find(x=>x.code==="return_accounting_remediation_required")).toMatchObject({state:"resolved",resolution:{corrections:[{correctionId:correction.proposalId}]}});
 });
 it("does not treat a malformed successful vendor-query envelope as proof that restored principal is unused",async()=>{
   const r=await replacement();r.h.setVendorResponse({time:"synthetic-response-without-query-result"});
   await expect(r.h.submit(r.replacementRequest)).rejects.toThrow(/restored_balance_incomplete|response|qbo_query_envelope_invalid/);
   expect(r.h.posts).toHaveLength(3);
 });
 it.each(["duplicate", "mixed_links", "fractional_cent"] as const)("refuses %s external application evidence before a replacement POST",async mode=>{
   const r=await replacement(),row={Id:"999",VendorRef:{value:"5"},Line:[{Amount:1,LinkedTxn:[{TxnType:"JournalEntry",TxnId:r.je.externalId}]}]};
   if(mode==="mixed_links")row.Line[0]!.LinkedTxn.push({TxnType:"Bill",TxnId:"900"});
   if(mode==="fractional_cent")row.Line[0]!.Amount=.001;
   r.h.setVendorResponse({QueryResponse:{BillPayment:mode==="duplicate"?[row,row]:[row]}});
   await expect(r.h.submit(r.replacementRequest)).rejects.toThrow(/restored_balance_incomplete|restored_balance_conflict/);expect(r.h.posts).toHaveLength(3);
 });
});
