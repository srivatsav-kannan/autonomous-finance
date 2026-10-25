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
export const mappings: Mappings = { version:"v5-reviewed",realmId:"123",country:"US",classes:{"sf-hayes-valley":{id:"9",name:"SF Hayes Valley"}},vendors:{"golden-state-produce":{id:"5",displayName:"Golden State Produce Co."}},accounts:{"2000":{id:"33",name:"AP",type:"Accounts Payable"},"1000":{id:"35",name:"Bank",type:"Bank"},"5000":{id:"7",name:"Produce",type:"Expense"},"5100":{id:"8",name:"Discount",type:"Expense"}},apAccount:"2000",bankAccount:"1000" };
const json = (x: unknown) => new Response(JSON.stringify(x), { headers:{"Content-Type":"application/json"} });
// Test-owned HTTP protocol only. Original accounting expectations are literal assertions below.
export async function protocol(load: ExportLoader) {
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
