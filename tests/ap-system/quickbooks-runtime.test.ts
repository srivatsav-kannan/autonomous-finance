import {mkdtemp,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import type {FunctionReference} from "convex/server";
import type {ConvexHttpClient} from "convex/browser";
import {fixture,refs} from "./accounting-fixture";
import {createQBOBridge} from "../../src/ap-system/quickbooks/runtime";
import {PrivateStore,hash} from "../../src/ap-system/quickbooks/private-store";
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
 const mappings={version:"v1",realmId:"123",country:"US",vendors:{"golden-state-produce":{id:"5",displayName:"Golden State"}},accounts:{"2000":{id:"33",name:"AP",type:"Accounts Payable"},"1000":{id:"35",name:"Cash",type:"Bank"},"5000":{id:"7",name:"Produce",type:"Expense"}},classes:{"sf-hayes-valley":{id:"9",name:"SF Hayes Valley"}},apAccount:"2000",bankAccount:"1000"};await store.write("mappings.json",mappings);
 const env={QBO_CLIENT_ID:"private-client",QBO_CLIENT_SECRET:"private-secret",QBO_REALM_ID:"123",QBO_REDIRECT_URI:CALLBACK,QBO_ENVIRONMENT:"sandbox",QBO_PRIVATE_DIR:dir};const bridge=createQBOBridge(f.human as unknown as ConvexHttpClient,f.scope,env);
 const fetcher=vi.fn(()=>{throw Error("No provider request expected");});vi.stubGlobal("fetch",fetcher);
 const preview=await bridge.preview({caseId:f.caseId});if(preview.hold)throw new Error("Unexpected hold");expect(preview.plan.entity).toBe("Bill");expect(preview.plan.payload.TotalAmt).toBe(77);expect(preview.externalWrites).toBe(0);
 await expect(bridge.submit({caseId:f.caseId},"0".repeat(64))).rejects.toThrow("preview_changed_before_write");
 await expect(bridge.submit({caseId:f.caseId},preview.planHash)).rejects.toThrow("fresh_authenticated_export_required");
 await store.write("mappings.json",{...mappings,version:"v2"});await expect(bridge.submit({caseId:f.caseId},preview.planHash)).rejects.toThrow("preview_changed_before_write");
 const state=await bridge.status(f.caseId);expect(state.configuration).toBe("configured");expect(state.grant).toBe("authorization_required");expect(JSON.stringify(state)).not.toContain("private-secret");expect(JSON.stringify(state)).not.toContain("private-client");expect(fetcher).not.toHaveBeenCalled();expect((await readdir(dir)).filter(s=>s.startsWith("operation-"))).toEqual([]);
});

it("exposes current backend holds before credentials and keeps historical receipts separate",async()=>{
 const f=await setup();const held={code:"returned_payment_requires_correction",owner:"controller" as const,reason:"A returned bank payment needs an approved correction.",relatedIds:["return-1"]};
 const {getFunctionName}=await import("convex/server");
 const human={query:async(ref:FunctionReference<"query">,args:Record<string,unknown>)=>{const result=await f.human.query(ref,args);return getFunctionName(ref)==="apAccountingExport:current"?{...result as object,holds:[held]}:result;}} as unknown as ConvexHttpClient;
 const fetcher=vi.fn(()=>{throw Error("No provider request expected");});vi.stubGlobal("fetch",fetcher);
 const status=await createQBOBridge(human,f.scope,{}).status(f.caseId);
 expect(status).toMatchObject({configuration:"not_configured",authority:"verified",holds:[held],receipts:[],complete:true});expect(fetcher).not.toHaveBeenCalled();
});
it("retains receipt history but marks failed current accounting authority incomplete",async()=>{
 const f=await setup();const {getFunctionName}=await import("convex/server");
 const human={query:async(ref:FunctionReference<"query">,args:Record<string,unknown>)=>{if(getFunctionName(ref)==="apAccountingExport:current")throw Error("Backend private diagnostic");return f.human.query(ref,args);}} as unknown as ConvexHttpClient;
 const status=await createQBOBridge(human,f.scope,{}).status(f.caseId);
 expect(status).toMatchObject({authority:"unavailable",complete:false,reason:"current_accounting_authority_unavailable"});expect(JSON.stringify(status)).not.toContain("private diagnostic");
});
it("returns owned holds for preview submit and verification without provider reads or writes",async()=>{
 const f=await setup(),dir=await mkdtemp(join(tmpdir(),"qbo-runtime-holds-"));dirs.push(dir);const store=new PrivateStore(dir);
 const {getFunctionName}=await import("convex/server");
 const held={code:"returned_payment_requires_correction",owner:"controller" as const,reason:"A returned bank payment needs an approved correction.",relatedIds:["return-1"]};let currentHolds=[held];
 const human={query:async(ref:FunctionReference<"query">,args:Record<string,unknown>)=>{const result=await f.human.query(ref,args);return getFunctionName(ref)==="apAccountingExport:current"?{...result as object,holds:currentHolds}:result;}} as unknown as ConvexHttpClient;
 const env={QBO_CLIENT_ID:"private-client",QBO_CLIENT_SECRET:"private-secret",QBO_REALM_ID:"123",QBO_REDIRECT_URI:CALLBACK,QBO_ENVIRONMENT:"sandbox",QBO_PRIVATE_DIR:dir};
 await store.write("mappings.json",{version:"v1",realmId:"123",country:"US",vendors:{"golden-state-produce":{id:"5",displayName:"Golden State"}},accounts:{"2000":{id:"33",name:"AP",type:"Accounts Payable"},"1000":{id:"35",name:"Cash",type:"Bank"},"5000":{id:"7",name:"Produce",type:"Expense"}},classes:{"sf-hayes-valley":{id:"9",name:"SF Hayes Valley"}},apAccount:"2000",bankAccount:"1000"});
 const bridge=createQBOBridge(human,f.scope,env),fetcher=vi.fn(()=>{throw Error("No provider request expected");});vi.stubGlobal("fetch",fetcher);
 expect(await bridge.preview({caseId:f.caseId})).toMatchObject({externalWrites:0,hold:{...held,state:"held"}});
 expect(await bridge.submit({caseId:f.caseId},"a".repeat(64))).toMatchObject({hold:{...held,state:"held"}});
 expect(await bridge.verify({caseId:f.caseId})).toMatchObject({hold:{...held,state:"held"}});
 expect((await bridge.status(f.caseId)).holds).toHaveLength(1);
 currentHolds=[];expect((await bridge.status(f.caseId)).holds).toEqual([held]); // Persisted unresolved history is not silently cleared.
 const keys=await readdir(dir);expect(keys.filter(k=>k.startsWith("hold-"))).toHaveLength(1);expect(keys.filter(k=>k.startsWith("operation-"))).toHaveLength(0);expect(fetcher).not.toHaveBeenCalled();
});

it("treats corrected Class mappings as current authority while retaining immutable receipt and held history without provider reads",async()=>{
 const f=await setup(),dir=await mkdtemp(join(tmpdir(),"qbo-runtime-classes-"));dirs.push(dir);const store=new PrivateStore(dir);
 const mappings={version:"dimensions-v1",realmId:"123",country:"US",vendors:{"golden-state-produce":{id:"5",displayName:"Golden State"}},accounts:{"2000":{id:"33",name:"AP",type:"Accounts Payable"},"1000":{id:"35",name:"Cash",type:"Bank"},"5000":{id:"7",name:"Produce",type:"Expense"}},classes:{"sf-hayes-valley":{id:"9",name:"SF Hayes Valley"}},apAccount:"2000",bankAccount:"1000"};
 await store.write("mappings.json",mappings);
 const env={QBO_CLIENT_ID:"synthetic",QBO_CLIENT_SECRET:"synthetic-only",QBO_REALM_ID:"123",QBO_REDIRECT_URI:CALLBACK,QBO_ENVIRONMENT:"sandbox",QBO_PRIVATE_DIR:dir};
 const bridge=createQBOBridge(f.human as unknown as ConvexHttpClient,f.scope,env),fetcher=vi.fn(()=>{throw Error("No provider request expected");});vi.stubGlobal("fetch",fetcher);
 const preview=await bridge.preview({caseId:f.caseId});if(preview.hold)throw Error("Unexpected hold");
 const operation={...preview.plan,requestId:"synthetic-existing",payloadHash:hash(preview.plan),state:"succeeded",createdAt:1,updatedAt:1,attempts:1,externalId:"900",syncToken:"0",responseHash:"a".repeat(64),lastError:null};
 const operationKey=`operation-${hash({realmId:"123",identity:operation.identity})}.json`;await store.write(operationKey,operation);
 await store.write("mappings.json",{...mappings,classes:{}});
 expect(await bridge.submit({caseId:f.caseId},preview.planHash)).toMatchObject({hold:{code:"class_mapping_missing",owner:"controller"}});
 const blocked=await bridge.status(f.caseId);expect(blocked.holds).toMatchObject([{code:"class_mapping_missing"}]);expect(blocked.holdHistory).toMatchObject([{code:"class_mapping_missing",current:true}]);
 const holdKey=(await readdir(dir)).find(k=>k.startsWith("hold-"))!,oldHold=await store.read(holdKey);
 await store.write("mappings.json",mappings);
 expect(await bridge.preview({caseId:f.caseId})).toMatchObject({planHash:preview.planHash,externalWrites:0});
 const fixed=await bridge.status(f.caseId);expect(fixed.holds).toEqual([]);expect(fixed.holdHistory).toMatchObject([{code:"class_mapping_missing",current:false,state:"held"}]);expect(fixed.receipts).toMatchObject([{externalId:"900",state:"succeeded"}]);
 expect(await store.read(holdKey)).toEqual(oldHold);expect(await store.read(operationKey)).toEqual(operation);expect(fetcher).not.toHaveBeenCalled();
});
