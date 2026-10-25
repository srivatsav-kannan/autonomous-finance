import{afterEach,describe,expect,it,vi}from"vitest";
import type{AddressInfo}from"node:net";
import{createAPLocalSimulationAuthentication}from"../src/ap-system/local-simulation-auth";
import{createAPExternalAuthentication}from"../src/ap-system/auth";
import{createAPSystemServer,type APWorkspaceService}from"../src/ap-system/server";
import{apUIFixture}from"./ap-system-ui.fixture";
const scope={...apUIFixture().scope,runId:"ap97-local-b3-auth-fixture"};
const actors=[{id:"owner-a",name:"Simulated owner A",subject:"https://ap-demo.invalid|owner-a"},{id:"owner-b",name:"Simulated owner B",subject:"https://ap-demo.invalid|owner-b"}];
const service=()=>({list:async()=>[],detail:async()=>apUIFixture(),cancelPayment:vi.fn(async()=>({ok:true})),runtime:()=>({identityMode:"simulated_human"})}) as unknown as APWorkspaceService;
const servers:ReturnType<typeof createAPSystemServer>[]=[];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
const options=()=>({scope,convexUrl:"http://127.0.0.1:3254",actors,serviceForActor:vi.fn((_actor:string)=>service()),authorizeActor:vi.fn(async(_actor:string)=>{})});
describe("isolated local multi-human authentication adapter",()=>{
 it("hard-rejects external scope and sandbox deployment URLs and duplicate simulated principals",()=>{
  for(const delta of [{convexUrl:"http://127.0.0.1:3252"},{convexUrl:"http://localhost:3254"},{scope:{...scope,provider:"increase" as const,environment:"sandbox" as const}},{actors:[actors[0]!,{...actors[1]!,subject:actors[0]!.subject}]}])expect(()=>createAPLocalSimulationAuthentication({...options(),...delta})).toThrow();
 });
 it("accepts explicit simulated actors on the first-wave local backend",()=>{expect(createAPLocalSimulationAuthentication({...options(),convexUrl:"http://127.0.0.1:3250"}).publicConfig).toMatchObject({mode:"local_simulation"});});
 it("selects only explicit actors, checks every current binding and exposes names without subjects",async()=>{
  const o=options(),auth=createAPLocalSimulationAuthentication(o);
  expect(auth.publicConfig).toEqual({mode:"local_simulation",actors:actors.map(({id,name})=>({id,name}))});expect(JSON.stringify(auth.publicConfig)).not.toContain("https://");
  for(const token of ["local:missing","owner-a","signed-token","local:owner-a:extra"])await expect(auth.authenticate(token)).rejects.toMatchObject({status:401});
  expect((await auth.authenticate("local:owner-a")).subject).toBe(actors[0]!.subject);expect((await auth.authenticate("local:owner-b")).subject).toBe(actors[1]!.subject);expect(o.serviceForActor.mock.calls.map(c=>c[0])).toEqual(["owner-a","owner-b"]);
  o.authorizeActor.mockRejectedValueOnce(new Error("revoked seat"));expect((await auth.authenticate("local:owner-a")).approved).toBe(false);expect(o.authorizeActor).toHaveBeenCalledTimes(3);
  expect((await createAPLocalSimulationAuthentication({...o,authorizeActor:undefined}).authenticate("local:owner-a")).approved).toBe(false);
 });
 it("rejects public simulated selection in Auth0 mode before constructing a human client",async()=>{
  const clientFactory=vi.fn(),auth=createAPExternalAuthentication({config:{issuer:"https://fixture.auth0.com/",domain:"fixture.auth0.com",clientId:"fixture"},convexUrl:"http://127.0.0.1:3252",clientFactory,authorize:async()=>{},service:()=>service()});
  await expect(auth.authenticate("local:owner-a")).rejects.toMatchObject({status:401});expect(clientFactory).not.toHaveBeenCalled();
 });
 it("binds cookies to simulated subjects and denies cross-actor writes and revoked seats",async()=>{
  const byActor=new Map(actors.map(a=>[a.id,service()])),o=options(),auth=createAPLocalSimulationAuthentication({...o,serviceForActor:id=>byActor.get(id)!});
  const origin="http://127.0.0.1:5193",server=createAPSystemServer({runtime:()=>({identityMode:"simulated_human"})},{port:0,runId:scope.runId,storageRoot:"/private/tmp",allowedOrigins:[origin],auth});servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ap-system`;
  const opened=await fetch(base+"/cases",{headers:{Authorization:"Bearer local:owner-a"}}),cookie=opened.headers.get("Set-Cookie")!.split(";")[0]!,body=JSON.stringify({expectedRevision:1,snapshotHash:"a".repeat(64)});
  const headers={origin,cookie,Authorization:"Bearer local:owner-b","X-AP-System-Session":"1","Content-Type":"application/json"};
  expect((await fetch(base+"/cases/c/payments/v/cancel",{method:"POST",headers,body})).status).toBe(403);expect(byActor.get("owner-b")!.cancelPayment).not.toHaveBeenCalled();
  const next=await fetch(base+"/cases",{headers});const nextCookie=next.headers.get("Set-Cookie")!.split(";")[0]!;expect(nextCookie).not.toBe(cookie);
  expect((await fetch(base+"/cases/c/payments/v/cancel",{method:"POST",headers:{...headers,cookie:nextCookie},body})).status).toBe(200);expect(byActor.get("owner-b")!.cancelPayment).toHaveBeenCalledOnce();expect(byActor.get("owner-a")!.cancelPayment).not.toHaveBeenCalled();
  o.authorizeActor.mockRejectedValueOnce(new Error("role revoked"));expect((await fetch(base+"/cases/c",{headers:{...headers,cookie:nextCookie}})).status).toBe(403);
 });
});
