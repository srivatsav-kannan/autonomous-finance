import{afterEach,describe,expect,it,vi}from"vitest";
import type{AddressInfo}from"node:net";
import{createAPSystemServer,type APWorkspaceService}from"../src/ap-system/server";
import{QboError}from"../src/ap-system/quickbooks/private-store";
const servers:ReturnType<typeof createAPSystemServer>[]=[];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
async function fixture(){
 const paymentRuns={list:vi.fn(async()=>[]),detail:vi.fn(async()=>({runId:"run"})),prepare:vi.fn(async()=>({runId:"run",snapshotHash:"a".repeat(64)})),authorize:vi.fn(async()=>({commandIds:["command"]})),cancel:vi.fn(async()=>({ok:true}))};
 const accounting={status:vi.fn(async()=>({configuration:"not_configured"})),preview:vi.fn(async()=>({plan:{},planHash:"b".repeat(64),externalWrites:0})),submit:vi.fn(async()=>({operation:{state:"succeeded",externalId:"123"}})),verify:vi.fn(async()=>({verifiedAt:1}))};
 const domain={view:vi.fn(async()=>({policies:[],contacts:[]})),proposals:vi.fn(async()=>[]),execute:vi.fn(async()=>({ok:true}))};
 const service={domain,list:async()=>[],runtime:()=>({identityMode:"simulated_human"}),paymentRuns,accounting}as unknown as APWorkspaceService;
 const server=createAPSystemServer(service,{port:0,runId:"operations-fixture",storageRoot:"/private/tmp",allowedOrigins:["http://127.0.0.1:5192"]});servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 const base=`http://127.0.0.1:${(server.address()as AddressInfo).port}/api/ap-system`,opened=await fetch(base+"/cases"),cookie=opened.headers.get("set-cookie")!.split(";")[0]!;
 const headers={cookie,origin:"http://127.0.0.1:5192","X-AP-System-Session":"1","Content-Type":"application/json"};
 const post=(route:string,body:unknown)=>fetch(base+route,{method:"POST",headers,body:JSON.stringify(body)});
 return{base,headers,domain,paymentRuns,accounting,post};
}
describe("payment run and accounting HTTP boundaries",()=>{
 it("requires established sessions and keeps reads separate from mutations",async()=>{
  const f=await fixture();for(const path of ["/payment-runs","/payment-runs/run","/cases/c/accounting"])expect((await fetch(f.base+path)).status).toBe(403);
  expect((await fetch(f.base+"/payment-runs",{headers:f.headers})).status).toBe(200);expect(f.paymentRuns.prepare).not.toHaveBeenCalled();
 });
 it("binds distinct one-to-25 case selections and exact proposal hashes",async()=>{
  const f=await fixture(),selection=[{caseId:"case",expectedRevision:2,snapshotHash:"a".repeat(64),amountCents:100,credits:[{creditId:"credit",amountCents:20}]}],input={requestKey:"request",selection,executionDate:"2028-02-29"};
  expect((await f.post("/payment-runs",input)).status).toBe(200);expect(f.paymentRuns.prepare).toHaveBeenCalledWith(input);
  for(const invalid of [{...input,selection:[]},{...input,selection:[...selection,...selection]},{...input,executionDate:"2027-02-29"},{...input,selection:selection.map(i=>({...i,amountCents:0}))}])expect((await f.post("/payment-runs",invalid)).status).toBe(400);
  expect((await f.post("/payment-runs/run/authorize",{snapshotHash:"a".repeat(64)})).status).toBe(200);expect(f.paymentRuns.authorize).toHaveBeenCalledWith({runId:"run",snapshotHash:"a".repeat(64)});
  expect((await f.post("/payment-runs/run/cancel",{snapshotHash:"b".repeat(64)})).status).toBe(200);expect(f.paymentRuns.cancel).toHaveBeenCalledWith({runId:"run",snapshotHash:"b".repeat(64)});
 });
 it("does not accept browser exports or accounting payloads and requires approved preview hash",async()=>{
  const f=await fixture();expect((await f.post("/cases/c/accounting/preview",{paymentVersionId:"p"})).status).toBe(200);expect(f.accounting.preview).toHaveBeenCalledWith({caseId:"c",paymentVersionId:"p"});
  expect((await f.post("/cases/c/accounting/submit",{})).status).toBe(400);expect((await f.post("/cases/c/accounting/submit",{expectedPlanHash:"a".repeat(64),payload:{TotalAmt:1}})).status).toBe(400);expect(f.accounting.submit).not.toHaveBeenCalled();
  expect((await f.post("/cases/c/accounting/submit",{expectedPlanHash:"a".repeat(64)})).status).toBe(200);expect(f.accounting.submit).toHaveBeenCalledWith({caseId:"c"},"a".repeat(64));
  expect((await f.post("/cases/c/accounting/verify",{paymentVersionId:"p"})).status).toBe(200);expect(f.accounting.verify).toHaveBeenCalledWith({caseId:"c",paymentVersionId:"p"});
 });
 it("validates domain decisions while keeping identity and scope server-owned",async()=>{
  const f=await fixture(),input={proposalId:"proposal",proposalHash:"a".repeat(64),idempotencyKey:"vote",outcome:"approved",reason:"Compared exact approved allocation"};
  expect((await fetch(f.base+"/business")).status).toBe(403);
  expect((await fetch(f.base+"/business",{headers:f.headers})).status).toBe(200);
  expect((await f.post("/business/vote",input)).status).toBe(200);expect(f.domain.execute).toHaveBeenCalledWith("vote",input);
  for(const patch of [{actor:"admin"},{scope:{runId:"other"}},{token:"forged"},{proposalHash:"stale"},{reason:""}])expect((await f.post("/business/vote",{...input,...patch})).status).toBe(400);
  expect((await f.post("/business/applyCredits",{caseId:"c",expectedRevision:1,snapshotHash:"a".repeat(64),billVersion:2,idempotencyKey:"apply",reason:"Exact credit",credits:[{creditId:"credit",amountCents:10},{creditId:"credit",amountCents:20}]})).status).toBe(400);
 });
 it("reports safe accounting readiness codes without provider transport contents",async()=>{
  const f=await fixture();f.accounting.preview.mockRejectedValueOnce(new QboError("accounting_mappings_required"));
  const result=await f.post("/cases/c/accounting/preview",{});expect(await result.json()).toMatchObject({error:{code:"accounting_mappings_required"}});
  f.accounting.preview.mockRejectedValueOnce(new Error("private provider token and body"));const opaque=await f.post("/cases/c/accounting/preview",{});expect(await opaque.text()).not.toContain("private provider");
 });
});
