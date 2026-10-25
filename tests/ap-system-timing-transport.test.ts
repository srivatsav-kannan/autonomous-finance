import {afterEach,it,expect,vi} from "vitest";
import type {AddressInfo} from "node:net";
import type {ConvexHttpClient} from "convex/browser";
import {getFunctionName} from "convex/server";
import {createAPWorkspaceService} from "../src/ap-system/service";
import {APHttpError,createAPSystemServer,type APWorkspaceService} from "../src/ap-system/server";
import {apUIFixture} from "./ap-system-ui.fixture";
import {timingUIFixture} from "./ap-system-timing-ui.fixture";
const servers:ReturnType<typeof createAPSystemServer>[]=[],origin="http://127.0.0.1:5192";
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}});
it("uses only the request-owned human and configured scope for operational reads",async()=>{
 const data=timingUIFixture([apUIFixture()]),agent={mutation:vi.fn(),query:vi.fn()},human={mutation:vi.fn(),query:vi.fn(async(_ref:unknown,_args:unknown)=>data)};
 const value=createAPWorkspaceService({agent:agent as unknown as ConvexHttpClient,human:human as unknown as ConvexHttpClient,scope:data.scope,apCredential:{seatId:"ap",token:"private"},paymentsCredential:{seatId:"payments",token:"private"},parseUploads:vi.fn(),runtime:()=>({})});
 expect(await value.operationalTimings!()).toEqual(data);expect(getFunctionName(human.query.mock.calls[0]![0] as never)).toBe("apOperationalMetrics:current");expect(human.query.mock.calls[0]![1]).toEqual({scope:data.scope});expect(agent.query).not.toHaveBeenCalled();expect(agent.mutation).not.toHaveBeenCalled();expect(human.mutation).not.toHaveBeenCalled();
});
it("requires current authentication plus matching session and keeps metrics read-only",async()=>{
 const data=timingUIFixture([apUIFixture()]),operationalTimings=vi.fn(async()=>data),service={list:async()=>[],runtime:()=>({}),operationalTimings} as unknown as APWorkspaceService;
 const server=createAPSystemServer({runtime:service.runtime},{port:0,runId:"timing-http",storageRoot:"/private/tmp",allowedOrigins:[origin],auth:{publicConfig:{mode:"auth0",domain:"synthetic.invalid",clientId:"synthetic"},authenticate:async token=>{if(token==="expired")throw new APHttpError("authentication_required",401,"Expired synthetic identity");return{subject:`synthetic|${token}`,issuer:"synthetic",approved:token!=="unapproved",service};}}});servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ap-system`;
 expect((await fetch(base+"/metrics",{headers:{Authorization:"Bearer owner"}})).status).toBe(403);
 const opened=await fetch(base+"/cases",{headers:{Authorization:"Bearer owner"}}),cookie=opened.headers.get("set-cookie")!.split(";")[0]!,headers={cookie,Authorization:"Bearer owner",origin,"X-AP-System-Session":"1"};
 for(const authorization of [undefined,"Bearer expired","Bearer another","Bearer unapproved"]){const h:Record<string,string>={cookie};if(authorization)h.Authorization=authorization;expect((await fetch(base+"/metrics",{headers:h})).status).toBe(authorization===undefined||authorization==="Bearer expired"?401:403);}
 expect((await fetch(base+"/metrics",{headers:{...headers,origin:"https://other.invalid"}})).status).toBe(403);expect(operationalTimings).not.toHaveBeenCalled();
 const response=await fetch(base+"/metrics?scope=forged",{headers});expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");expect(await response.json()).toEqual(data);expect(operationalTimings).toHaveBeenCalledWith();
 expect((await fetch(base+"/metrics",{method:"POST",headers})).status).toBe(404);expect(operationalTimings).toHaveBeenCalledTimes(1);
 service.operationalTimings=undefined;expect((await fetch(base+"/metrics",{headers})).status).toBe(503);
});
