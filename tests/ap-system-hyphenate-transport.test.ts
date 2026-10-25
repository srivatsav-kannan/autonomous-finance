import {afterEach,it,expect,vi} from "vitest";
import type {ConvexHttpClient} from "convex/browser";
import type {AddressInfo} from "node:net";
import {getFunctionName} from "convex/server";
import {createAPWorkspaceService} from "../src/ap-system/service";
import {APHttpError,createAPSystemServer,type APWorkspaceService} from "../src/ap-system/server";
import {apUIFixture} from "./ap-system-ui.fixture";
const scope=apUIFixture().scope,origin="http://127.0.0.1:5192",hash="a".repeat(64),credential={seatId:"ap",token:"private-only"};
const context={supplierId:"supplier",category:"cleaning",location:"store",effectiveOn:"2026-10-25",currency:"USD" as const,amountCents:7700};
const work={caseId:"case",action:"pause" as const,reason:"Evidence needs checking",expectedGeneration:2,expectedRevision:1,snapshotHash:hash,idempotencyKey:"pause-case"};
const review={candidateId:"rule",expectedHash:hash,outcome:"accept" as const,reason:"Independently checked"};
const servers:ReturnType<typeof createAPSystemServer>[]=[];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
it("keeps work controls and rule decisions on the human client; only synthetic packet seeding uses agent credentials",async()=>{
 const agent={mutation:vi.fn(async(_ref:unknown,_args:unknown)=>({ok:true}))},human={query:vi.fn(async(_ref:unknown,_args:unknown)=>({})),mutation:vi.fn(async(_ref:unknown,_args:unknown)=>({ok:true}))};
 const service=createAPWorkspaceService({agent:agent as unknown as ConvexHttpClient,human:human as unknown as ConvexHttpClient,scope,apCredential:credential,paymentsCredential:{seatId:"payments",token:"not-forwarded"},parseUploads:vi.fn(),runtime:()=>({})});
 await service.learning!.overview();expect(getFunctionName(human.query.mock.calls[0]![0] as never)).toBe("apPrecedents:overview");expect(human.query.mock.calls[0]![1]).toEqual({scope});
 await service.learning!.seedDemo("seed");expect(getFunctionName(agent.mutation.mock.calls[0]![0] as never)).toBe("apPrecedents:seedDemo");expect(agent.mutation.mock.calls[0]![1]).toEqual({scope,...credential,idempotencyKey:"seed"});
 await service.learning!.reviewRule(review);expect(getFunctionName(human.mutation.mock.calls.at(-1)![0] as never)).toBe("apPrecedents:reviewRule");expect(human.mutation.mock.calls.at(-1)![1]).toEqual({scope,...review});
 await service.learning!.evaluate({context,idempotencyKey:"eval"});expect(getFunctionName(human.mutation.mock.calls.at(-1)![0] as never)).toBe("apPrecedents:evaluate");expect(human.mutation.mock.calls.at(-1)![1]).toEqual({scope,context,idempotencyKey:"eval"});
 await service.workControl!(work);expect(getFunctionName(human.mutation.mock.calls.at(-1)![0] as never)).toBe("apCaseAgent:control");expect(human.mutation.mock.calls.at(-1)![1]).toEqual({scope,...work});expect(agent.mutation).toHaveBeenCalledTimes(1);
});
it("requires the matching authenticated session and rejects forged authority on every new write",async()=>{
 const seedDemo=vi.fn(async()=>({})),reviewRule=vi.fn(async()=>({})),evaluate=vi.fn(async()=>({})),workControl=vi.fn(async()=>({ok:false,code:"stale_work_control"})),overview=vi.fn(async()=>({}));
 const service={list:async()=>[],runtime:()=>({}),learning:{overview,seedDemo,reviewRule,evaluate},workControl} as unknown as APWorkspaceService;
 const server=createAPSystemServer({runtime:service.runtime},{port:0,runId:"hyphenate-http",storageRoot:"/private/tmp",allowedOrigins:[origin],auth:{publicConfig:{mode:"auth0",domain:"synthetic.invalid",clientId:"synthetic"},authenticate:async token=>{if(token==="expired")throw new APHttpError("authentication_required",401,"Expired");return{subject:token,issuer:"synthetic",approved:token!=="unapproved",service};}}});servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ap-system`;
 const opened=await fetch(base+"/cases",{headers:{Authorization:"Bearer owner"}}),cookie=opened.headers.get("set-cookie")!.split(";")[0]!,headers={Authorization:"Bearer owner",cookie,origin,"Content-Type":"application/json","X-AP-System-Session":"1"};
 const writes:[[string,unknown],[string,unknown],[string,unknown],[string,unknown]]=[["/learning/seed-demo",{idempotencyKey:"seed"}],["/learning/review",review],["/learning/evaluate",{context,idempotencyKey:"eval"}],["/cases/case/work/control",work]];
 for(const [route,body] of writes){for(const forged of [{scope},{subject:"intruder"},{token:"secret",seatId:"admin"}])expect((await fetch(base+route,{method:"POST",headers,body:JSON.stringify({...body as object,...forged})})).status).toBe(400);for(const authorization of ["Bearer other","Bearer unapproved","Bearer expired"]){expect((await fetch(base+route,{method:"POST",headers:{...headers,Authorization:authorization},body:JSON.stringify(body)})).status).toBe(authorization==="Bearer expired"?401:403);}expect((await fetch(base+route,{method:"POST",headers:{...headers,origin:"https://untrusted.invalid"},body:JSON.stringify(body)})).status).toBe(403);}
 expect(seedDemo).not.toHaveBeenCalled();expect(reviewRule).not.toHaveBeenCalled();expect(evaluate).not.toHaveBeenCalled();expect(workControl).not.toHaveBeenCalled();
 expect((await fetch(base+"/cases/wrong/work/control",{method:"POST",headers,body:JSON.stringify(work)})).status).toBe(400);
 for(const [route,body] of writes)expect((await fetch(base+route,{method:"POST",headers,body:JSON.stringify(body)})).status).toBe(200);
 expect(workControl).toHaveBeenLastCalledWith(work);expect(reviewRule).toHaveBeenLastCalledWith(review);expect(evaluate).toHaveBeenLastCalledWith({context,idempotencyKey:"eval"});expect(seedDemo).toHaveBeenLastCalledWith("seed");
 expect((await fetch(base+"/learning",{headers})).status).toBe(200);expect(overview).toHaveBeenCalledTimes(1);
});
