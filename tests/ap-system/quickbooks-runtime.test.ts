import {mkdtemp,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import type {ConvexHttpClient} from "convex/browser";
import {fixture,refs} from "./accounting-fixture";
import {createQBOBridge} from "../../src/ap-system/quickbooks/runtime";
import {PrivateStore} from "../../src/ap-system/quickbooks/private-store";
import {CALLBACK} from "../../src/ap-system/quickbooks/oauth";
const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function setup(){const f=await fixture(),d=await f.reviewed();await f.human.mutation(refs.approve,{scope:f.scope,input:{...f.request(d,"approve"),acceptedCents:7700}});return {...f,caseId:d.caseId};}
it("shows honest missing configuration using the current verified case client and no provider request",async()=>{
 const f=await setup();const fetcher=vi.fn(()=>{throw Error("No provider request expected");});vi.stubGlobal("fetch",fetcher);
 const bridge=createQBOBridge(f.human as unknown as ConvexHttpClient,f.scope,{});
 expect(await bridge.status(f.caseId)).toMatchObject({configuration:"not_configured",grant:"authorization_required",mappings:"missing",receipts:[],externalVerification:"not_checked"});expect(fetcher).not.toHaveBeenCalled();
 const other=createQBOBridge(f.t as unknown as ConvexHttpClient,f.scope,{});await expect(other.status(f.caseId)).rejects.toThrow(/human/);
});
it("builds a backend-derived dry run without JWT input, binds the preview hash and never submits local evidence",async()=>{
 const f=await setup(),dir=await mkdtemp(join(tmpdir(),"qbo-runtime-"));dirs.push(dir);const store=new PrivateStore(dir);
 const mappings={version:"v1",realmId:"123",country:"US",vendors:{"golden-state-produce":{id:"5",displayName:"Golden State"}},accounts:{"2000":{id:"33",name:"AP",type:"Accounts Payable"},"1000":{id:"35",name:"Cash",type:"Bank"},"5000":{id:"7",name:"Produce",type:"Expense"}},apAccount:"2000",bankAccount:"1000"};await store.write("mappings.json",mappings);
 const env={QBO_CLIENT_ID:"private-client",QBO_CLIENT_SECRET:"private-secret",QBO_REALM_ID:"123",QBO_REDIRECT_URI:CALLBACK,QBO_ENVIRONMENT:"sandbox",QBO_PRIVATE_DIR:dir};const bridge=createQBOBridge(f.human as unknown as ConvexHttpClient,f.scope,env);
 const fetcher=vi.fn(()=>{throw Error("No provider request expected");});vi.stubGlobal("fetch",fetcher);
 const preview=await bridge.preview({caseId:f.caseId});expect(preview.plan.entity).toBe("Bill");expect(preview.plan.payload.TotalAmt).toBe(77);expect(preview.externalWrites).toBe(0);
 await expect(bridge.submit({caseId:f.caseId},"0".repeat(64))).rejects.toThrow("preview_changed_before_write");
 await expect(bridge.submit({caseId:f.caseId},preview.planHash)).rejects.toThrow("fresh_authenticated_export_required");
 await store.write("mappings.json",{...mappings,version:"v2"});await expect(bridge.submit({caseId:f.caseId},preview.planHash)).rejects.toThrow("preview_changed_before_write");
 const state=await bridge.status(f.caseId);expect(state.configuration).toBe("configured");expect(state.grant).toBe("authorization_required");expect(JSON.stringify(state)).not.toContain("private-secret");expect(JSON.stringify(state)).not.toContain("private-client");expect(fetcher).not.toHaveBeenCalled();expect((await readdir(dir)).filter(s=>s.startsWith("operation-"))).toEqual([]);
});
