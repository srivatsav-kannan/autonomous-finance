import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { APHttpError, createAPSystemServer, type APWorkspaceService } from "../src/ap-system/server";
import { apUIFixture } from "./ap-system-ui.fixture";
const origin="http://127.0.0.1:5192",servers:ReturnType<typeof createAPSystemServer>[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
async function fixture(){
 const doc=apUIFixture().sources[0]!;const bytes=Buffer.from("original fixture");doc.originalBase64=bytes.toString("base64");doc.sha256=createHash("sha256").update(bytes).digest("hex");doc.byteLength=bytes.length;
 const service={list:vi.fn(async()=>[]),detail:vi.fn(async()=>apUIFixture()),source:vi.fn(async()=>doc),renderPage:vi.fn(async()=>({bytes:Buffer.from("fixture raster"),mimeType:"image/png" as const,frame:{}})),review:vi.fn(async()=>({ok:true})),approve:vi.fn(),requestPayment:vi.fn(async()=>({versionId:"v",snapshotHash:"b".repeat(64)})),authorizePayment:vi.fn(),cancelPayment:vi.fn(async()=>({ok:true})),paymentDetail:vi.fn(async()=>({fixture:true})),ingest:vi.fn(),parseUploads:vi.fn(),runtime:()=>({identityMode:"authenticated_human"})} as unknown as APWorkspaceService;
 const authentication=vi.fn(async(token:string)=>{if(token==="expired"||token==="invalid")throw new APHttpError("authentication_required",401,"Sign in again.");return{subject:"issuer|"+token,issuer:"https://fixture.auth0.com/",approved:token!=="unapproved",service};});
 const server=createAPSystemServer({runtime:service.runtime},{port:0,runId:"auth-http-fixture",storageRoot:"/private/tmp",allowedOrigins:[origin],auth:{publicConfig:{mode:"auth0",domain:"fixture.auth0.com",clientId:"fixture-client"},authenticate:authentication}});
 servers.push(server);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ap-system`;
 const opened=await fetch(base+"/cases",{headers:{Authorization:"Bearer owner"}});const cookie=opened.headers.get("set-cookie")!.split(";")[0]!;
 const headers={Authorization:"Bearer owner",cookie,origin,"X-AP-System-Session":"1","Content-Type":"application/json"};
 return{base,cookie,headers,service,doc,authentication};
}
describe("external AP HTTP authorization",()=>{
 it("publishes only the login config before authentication",async()=>{
  const f=await fixture();const runtime=await fetch(f.base+"/runtime");expect(runtime.status).toBe(200);expect(await runtime.json()).toEqual({identityMode:"authenticated_human",auth:{mode:"auth0",domain:"fixture.auth0.com",clientId:"fixture-client"}});
 });
 it("requires valid Bearer auth on every case, source and mutation route even with a cookie",async()=>{
  const f=await fixture();const source=`/sources/${f.doc.sourceId}/revisions/1`;
  for(const [method,route] of [["GET","/payment-runs"],["GET","/payment-runs/run"],["POST","/payment-runs"],["POST","/payment-runs/run/authorize"],["POST","/payment-runs/run/cancel"],["GET","/cases/c/accounting"],["POST","/cases/c/accounting/preview"],["POST","/cases/c/accounting/submit"],["POST","/cases/c/accounting/verify"],["GET","/whoami"],["GET","/cases"],["GET","/cases/c"],["GET",source+`?sha256=${f.doc.sha256}`],["GET",source+`/pages/1?sha256=${f.doc.sha256}`],["GET","/payments/v"],["POST","/intake"],["POST","/cases/c/review"],["POST","/cases/c/approve"],["POST","/cases/c/payments"],["POST","/cases/c/payments/v/authorize"],["POST","/cases/c/payments/v/cancel"],["POST","/logout"]]) {
   for(const authorization of [undefined,"Bearer expired","Bearer invalid"]){const headers:Record<string,string>={cookie:f.cookie,origin,"X-AP-System-Session":"1"};if(authorization)headers.Authorization=authorization;expect((await fetch(f.base+route,{method,headers})).status).toBe(401);}
  }
  expect(f.service.source).not.toHaveBeenCalled();expect(f.service.requestPayment).not.toHaveBeenCalled();expect(f.service.ingest).not.toHaveBeenCalled();
 });
 it("allows verified whoami but no case access before owner binding",async()=>{
  const f=await fixture();const headers={...f.headers,Authorization:"Bearer unapproved"};
  expect(await (await fetch(f.base+"/whoami",{headers})).json()).toMatchObject({tokenIdentifier:"issuer|unapproved",approved:false});
  for(const route of ["/cases","/cases/c","/payments/v"])expect((await fetch(f.base+route,{headers})).status).toBe(403);
  expect((await fetch(f.base+"/cases/c/payments",{method:"POST",headers,body:"{}"})).status).toBe(403);
 });
 it("binds sessions to the verified subject and requires a list before direct detail",async()=>{
  const f=await fixture();expect((await fetch(f.base+"/cases/c",{headers:{Authorization:"Bearer owner"}})).status).toBe(403);
  expect((await fetch(f.base+"/cases/c",{headers:{...f.headers,Authorization:"Bearer another-user"}})).status).toBe(403);
  expect((await fetch(f.base+"/cases/c",{headers:f.headers})).status).toBe(200);
  const original=await fetch(f.base+`/sources/${f.doc.sourceId}/revisions/1?sha256=${f.doc.sha256}`,{headers:f.headers});expect(await original.text()).toBe("original fixture");
  expect(original.headers.get("Cache-Control")).toBe("no-store");
 });
 it("retains origin/CSRF checks and revokes the current cookie on logout",async()=>{
  const f=await fixture();
  for(const headers of [{...f.headers,origin:"https://untrusted.invalid"},{...f.headers,"X-AP-System-Session":""},{Authorization:"Bearer owner",cookie:f.cookie}])expect((await fetch(f.base+"/logout",{method:"POST",headers})).status).toBe(403);
  const logout=await fetch(f.base+"/logout",{method:"POST",headers:f.headers});expect(logout.status).toBe(200);expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect((await fetch(f.base+"/cases/c",{headers:f.headers})).status).toBe(403);
 });
 it("rejects an expired subject-bound session and does not cache expired token acceptance",async()=>{
  const f=await fixture();const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+9*60*60*1000);
  expect((await fetch(f.base+"/cases/c",{headers:f.headers})).status).toBe(403);
  expect((await fetch(f.base+"/cases",{headers:{Authorization:"Bearer expired"}})).status).toBe(401);
 });
 it("validates and passes scheduled partial/credit proposals and separate cancellation",async()=>{
  const f=await fixture(),binding={expectedRevision:1,snapshotHash:"a".repeat(64)};
  const input={...binding,idempotencyKey:"same-request",executionDate:"2028-02-29",amountCents:1000,credits:[{creditId:"credit-1",amountCents:300}]};
  expect((await fetch(f.base+"/cases/c/payments",{method:"POST",headers:f.headers,body:JSON.stringify(input)})).status).toBe(200);expect(f.service.requestPayment).toHaveBeenCalledWith({...input,caseId:"c"});
  for(const delta of [{executionDate:"2027-02-29"},{executionDate:"2026-04-31"},{executionDate:"2026-1-1"},{amountCents:0},{amountCents:Number.MAX_SAFE_INTEGER+1},{credits:[{creditId:"a",amountCents:1},{creditId:"a",amountCents:2}]}])expect((await fetch(f.base+"/cases/c/payments",{method:"POST",headers:f.headers,body:JSON.stringify({...input,...delta})})).status).toBe(400);
  expect((await fetch(f.base+"/cases/c/payments/v/cancel",{method:"POST",headers:f.headers,body:JSON.stringify(binding)})).status).toBe(200);expect(f.service.cancelPayment).toHaveBeenCalledWith({...binding,caseId:"c",versionId:"v"});expect(f.service.authorizePayment).not.toHaveBeenCalled();
 });
});
