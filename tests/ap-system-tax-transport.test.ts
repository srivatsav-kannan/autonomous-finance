import {afterEach,it,expect,vi} from "vitest";
import type {ConvexHttpClient} from "convex/browser";
import type {AddressInfo} from "node:net";
import {getFunctionName} from "convex/server";
import {createAPWorkspaceService} from "../src/ap-system/service";
import {createAPSystemServer,type APWorkspaceService} from "../src/ap-system/server";
import {apSystemApi} from "../console/src/apSystemApi";
import {configureAPSession} from "../console/src/apAuthSession";
import {apUIFixture} from "./ap-system-ui.fixture";
const scope=apUIFixture().scope;
const action={kind:"tax_adjustment" as const,originalEntryId:"journal",originalApprovalId:"recognition",costSnapshotHash:"c".repeat(64),taxSnapshotHash:"d".repeat(64),initialAttribution:[],targets:[{originalLineId:"line",recoverableCents:0}],movements:[{from:{originalLineId:"line",allocationIndex:1,account:"1180",treatment:"tax" as const,store:null,department:"ops",project:null,amountCents:100},toAccount:"5000",toTreatment:"expense" as const}],date:"2026-10-31",eligibilityEvidence:[{source:{sourceId:"support",revision:1,sha256:"a".repeat(64)},page:1,start:0,end:4,quote:"test",rawValue:"test"}],reason:"Current independently reviewed eligibility"};
const servers:ReturnType<typeof createAPSystemServer>[]=[];
afterEach(async()=>{configureAPSession(null);vi.unstubAllGlobals();for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
it("loads tax state under the request human and sends immutable proposals only as the scoped controller",async()=>{
 const human={query:vi.fn(async(_ref:unknown,_args:unknown)=>({})),mutation:vi.fn(async(_ref:unknown,_args:unknown)=>({}))},agent={mutation:vi.fn(async(_ref:unknown,_args:unknown)=>({}))},controller={seatId:"controller",token:"private-controller"};
 const service=createAPWorkspaceService({scope,human:human as unknown as ConvexHttpClient,agent:agent as unknown as ConvexHttpClient,apCredential:{seatId:"ap",token:"private-ap"},paymentsCredential:{seatId:"payments",token:"private-payment"},controllerCredential:controller,parseUploads:vi.fn(),runtime:()=>({})});
 await service.close!.taxState("original-journal");expect(getFunctionName(human.query.mock.calls[0]![0] as never)).toBe("apClose:taxState");expect(human.query.mock.calls[0]![1]).toEqual({scope,originalEntryId:"original-journal"});
 const input={idempotencyKey:"tax-change",action};await service.close!.execute("propose",input);expect(getFunctionName(agent.mutation.mock.calls[0]![0] as never)).toBe("apClose:propose");expect(agent.mutation.mock.calls[0]![1]).toEqual({scope,...controller,input});
 const vote={actionId:"tax-action",actionHash:"f".repeat(64),idempotencyKey:"tax-vote",outcome:"approved" as const,reason:"Independent eligibility evidence reviewed"};await service.close!.execute("vote",vote);expect(getFunctionName(human.mutation.mock.calls[0]![0] as never)).toBe("apClose:vote");expect(human.mutation.mock.calls[0]![1]).toEqual({scope,input:vote});
});
it("protects HTTP tax reads and rejects identity, scope, malformed dates and altered share shapes before execution",async()=>{
 const close={taxState:vi.fn(async()=>({snapshotHash:"d".repeat(64)})),execute:vi.fn(async(_ref:unknown,_args:unknown)=>({}))};const server=createAPSystemServer({list:async()=>[],runtime:()=>({}),close} as unknown as APWorkspaceService,{port:0,runId:scope.runId,storageRoot:"/private/tmp",allowedOrigins:["http://127.0.0.1:5191"]});servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ap-system`;
 expect((await fetch(base+"/close/tax-state/journal")).status).toBe(403);expect(close.taxState).not.toHaveBeenCalled();const opened=await fetch(base+"/cases"),cookie=opened.headers.get("set-cookie")!.split(";")[0]!,headers={cookie,origin:"http://127.0.0.1:5191","Content-Type":"application/json","X-AP-System-Session":"1"};
 expect((await fetch(base+"/close/tax-state/journal%2Fone",{headers})).status).toBe(200);expect(close.taxState).toHaveBeenCalledWith("journal/one");expect((await fetch(base+"/close/tax-state/%20",{headers})).status).toBe(400);
 const post=(body:unknown,h=headers)=>fetch(base+"/close/propose",{method:"POST",headers:h,body:JSON.stringify(body)}),input={idempotencyKey:"tax",action};expect((await post(input,{...headers,origin:"https://untrusted.invalid"})).status).toBe(403);
 for(const bad of [{...input,scope},{...input,subject:"admin"},{...input,action:{...action,date:"2026-02-30"}},{...input,action:{...action,movements:[{...action.movements[0],from:{...action.movements[0]!.from,actor:"admin"}}]}}])expect((await post(bad)).status).toBe(400);
 expect(close.execute).not.toHaveBeenCalled();expect((await post(input)).status).toBe(200);expect(close.execute).toHaveBeenCalledWith("propose",input);
});
it("preserves exact tax action payloads in browser transport and keeps reads separate from writes",async()=>{
 const fetcher=vi.fn(async(_input:unknown,_init?:RequestInit)=>new Response("{}"));vi.stubGlobal("fetch",fetcher);configureAPSession({mode:"local"});await apSystemApi.taxState("journal/one");expect(fetcher.mock.calls[0]![0]).toBe("/api/ap-system/close/tax-state/journal%2Fone");await apSystemApi.close("propose",{idempotencyKey:"change",action});const init=fetcher.mock.calls[1]![1] as RequestInit;expect(JSON.parse(init.body as string)).toEqual({idempotencyKey:"change",action});expect(()=>apSystemApi.close("propose",{idempotencyKey:"change",action:{...action,date:"2026-02-30"}})).toThrow();expect(fetcher).toHaveBeenCalledTimes(2);
});
