import{describe,it,expect,vi}from"vitest";
import{getFunctionName}from"convex/server";
import type{ConvexHttpClient}from"convex/browser";
import{createAPWorkspaceService}from"../src/ap-system/service";
import{policy}from"./ap-system/business-fixture";
import{apUIFixture}from"./ap-system-ui.fixture";
const credential={seatId:"ap-fixture",token:"private-ap"},controller={seatId:"controller-fixture",token:"private-controller"};
function service(withController=false){const agent={mutation:vi.fn(async(_ref:unknown,_args:unknown)=>({ok:true}))},human={mutation:vi.fn(async(_ref:unknown,_args:unknown)=>({ok:true})),query:vi.fn(async(_ref:unknown,_args:unknown)=>({policies:[],contacts:[]}))};const value=createAPWorkspaceService({agent:agent as unknown as ConvexHttpClient,human:human as unknown as ConvexHttpClient,scope:apUIFixture().scope,apCredential:credential,paymentsCredential:{seatId:"payments-fixture",token:"private-payments"},...(withController?{controllerCredential:controller}:{}),parseUploads:vi.fn(),runtime:()=>({})});return{agent,human,value};}
describe("business service authority routing",()=>{
 it("routes current reads and votes through the request-owned human without agent credentials",async()=>{
  const f=service();await f.value.domain!.view();expect(getFunctionName(f.human.query.mock.calls[0]![0] as never)).toBe("apBusinessConfig:view");
  const input={proposalId:"proposal",proposalHash:"a".repeat(64),idempotencyKey:"vote",outcome:"approved" as const,reason:"Reviewed exact treatment"};await f.value.domain!.execute("vote",input);
  expect(getFunctionName(f.human.mutation.mock.calls[0]![0] as never)).toBe("apBusiness:vote");expect(f.human.mutation.mock.calls[0]![1]).toEqual({scope:apUIFixture().scope,input});expect(f.agent.mutation).not.toHaveBeenCalled();
 });
 it("requires a separately configured controller for policy proposal and never substitutes AP",async()=>{
  const input={idempotencyKey:"policy",policy:policy()},missing=service();await expect(missing.value.domain!.execute("proposePolicy",input)).rejects.toMatchObject({code:"controller_unavailable"});expect(missing.agent.mutation).not.toHaveBeenCalled();
  const f=service(true);await f.value.domain!.execute("proposePolicy",input);expect(f.agent.mutation.mock.calls[0]![1]).toEqual({scope:apUIFixture().scope,...controller,...input});expect(f.human.mutation).not.toHaveBeenCalled();
 });
});
