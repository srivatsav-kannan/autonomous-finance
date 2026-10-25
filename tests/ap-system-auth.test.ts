import { describe, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { createAPExternalAuthentication, parseAPAuth0Config } from "../src/ap-system/auth";
import { parseAPSandboxConfig, createAPSandboxRuntime } from "../src/ap-system/sandbox-runtime";
import type { APWorkspaceService } from "../src/ap-system/server";
const issuer="https://unit-fixture.us.auth0.com/";
const config={issuer,domain:"unit-fixture.us.auth0.com",clientId:"fixture-spa-client",approvedSubject:issuer+"|auth0|owner"};
const identity={issuer,subject:"auth0|owner",tokenIdentifier:config.approvedSubject};
const modules=import.meta.glob("../convex/**/*.ts");
describe("AP verified human identity boundary",()=>{
 it("creates a new request-owned Convex client and checks the scoped binding",async()=>{
  const clients: {setAuth:ReturnType<typeof vi.fn>;clearAuth:ReturnType<typeof vi.fn>;query:ReturnType<typeof vi.fn>}[]=[];
  const authorize=vi.fn(async(_human:ConvexHttpClient)=>{}),service=vi.fn((_human:ConvexHttpClient)=>({}) as APWorkspaceService);
  const auth=createAPExternalAuthentication({config,convexUrl:"http://127.0.0.1:3252",authorize,service,clientFactory:()=>{const client={setAuth:vi.fn(),clearAuth:vi.fn(),query:vi.fn().mockResolvedValue(identity)};clients.push(client);return client as unknown as ConvexHttpClient;}});
  expect((await auth.authenticate("opaque-fixture-a")).approved).toBe(true);
  await auth.authenticate("opaque-fixture-b");
  expect(clients).toHaveLength(2);expect(clients[0]!.setAuth).toHaveBeenCalledWith("opaque-fixture-a");expect(clients[1]!.setAuth).toHaveBeenCalledWith("opaque-fixture-b");
  expect(authorize.mock.calls.map(row=>row[0])).toEqual(clients);expect(service.mock.calls.map(row=>row[0])).toEqual(clients);
  expect(auth.publicConfig).toEqual({mode:"auth0",domain:config.domain,clientId:config.clientId});
 });
 it.each(["expired","bad-signature","wrong-audience","malformed"])("rejects Convex verification failure (%s) without exposing transport/token contents",async()=>{
  // Upstream rejection is mocked: this tests the boundary, not Convex cryptography.
  const clearAuth=vi.fn(),service=vi.fn(),authorize=vi.fn();
  const auth=createAPExternalAuthentication({config,convexUrl:"http://127.0.0.1:3252",authorize,service,clientFactory:()=>({setAuth:vi.fn(),clearAuth,query:vi.fn().mockRejectedValue(new Error("private-token-contents"))}) as unknown as ConvexHttpClient});
  await expect(auth.authenticate("invalid-fixture")).rejects.toMatchObject({status:401,code:"authentication_required"});
  expect(service).not.toHaveBeenCalled();expect(authorize).not.toHaveBeenCalled();expect(clearAuth).toHaveBeenCalled();
 });
 it.each([{...identity,issuer:"https://different.auth0.com/"},{...identity,tokenIdentifier:"forged-owner"}])("rejects an inconsistent verified identity",async value=>{
  const auth=createAPExternalAuthentication({config,convexUrl:"http://127.0.0.1:3252",authorize:async()=>{},service:()=>({}) as APWorkspaceService,clientFactory:()=>({setAuth:vi.fn(),clearAuth:vi.fn(),query:vi.fn().mockResolvedValue(value)}) as unknown as ConvexHttpClient});
  await expect(auth.authenticate("opaque-fixture")).rejects.toMatchObject({status:401});
 });
 it("does not enroll a first login or authorize a revoked scoped seat",async()=>{
  for(const approvedSubject of [undefined,config.approvedSubject]) {
   const authorize=vi.fn(async()=>{throw Error("seat inactive");});
   const auth=createAPExternalAuthentication({config:{...config,approvedSubject},convexUrl:"http://127.0.0.1:3252",authorize,service:()=>({}) as APWorkspaceService,clientFactory:()=>({setAuth:vi.fn(),clearAuth:vi.fn(),query:vi.fn().mockResolvedValue(identity)}) as unknown as ConvexHttpClient});
   expect(await auth.authenticate("opaque-fixture")).toMatchObject({subject:identity.tokenIdentifier,approved:false});
   expect(authorize).toHaveBeenCalledTimes(approvedSubject?1:0);
  }
 });
 it("requires both the private multi-user allowlist and each current backend binding",async()=>{
  const subjects=["auth0|approver-a","auth0|approver-b","auth0|notlisted","auth0|revoked"];
  const authorize=vi.fn(async(client:ConvexHttpClient)=>{if((client as unknown as {subject:string}).subject==="auth0|revoked")throw Error("revoked");});
  for(const subject of subjects){
   const auth=createAPExternalAuthentication({config:{...config,approvedSubject:undefined,approvedSubjects:[...subjects.filter(s=>s!=="auth0|notlisted").map(s=>issuer+"|"+s)]},convexUrl:"http://127.0.0.1:3252",authorize,service:()=>({}) as APWorkspaceService,clientFactory:()=>({subject,setAuth:vi.fn(),clearAuth:vi.fn(),query:vi.fn().mockResolvedValue({issuer,subject,tokenIdentifier:issuer+"|"+subject})}) as unknown as ConvexHttpClient});
   expect((await auth.authenticate("opaque-fixture")).approved).toBe(subject==="auth0|approver-a"||subject==="auth0|approver-b");
  }
  expect(authorize).toHaveBeenCalledTimes(3);
 });
 it("whoami requires ctx.auth and never inserts a human seat",async()=>{
  const t=convexTest(schema,modules),whoami=makeFunctionReference<"query">("apIdentity:whoami");
  await expect(t.query(whoami,{})).rejects.toThrow(/authentication_required/);
  expect(await t.withIdentity(identity).query(whoami,{})).toEqual(identity);
  expect(await t.run(ctx=>ctx.db.query("seats").collect())).toEqual([]);
 });
 it("requires a scoped payment-capable human binding beyond a signed identity",async()=>{
  const t=convexTest(schema,modules);
  await expect(t.withIdentity(identity).query(makeFunctionReference<"query">("apIdentity:workspaceAccess"),{scope:{organizationId:"fixture",runId:"fixture",provider:"increase",environment:"sandbox",accountId:"fixture-account"}})).rejects.toThrow(/Forbidden/);
 });
});
const env={AP_HUMAN_AUTH_ISSUER:issuer,AP_HUMAN_AUTH_AUDIENCE:config.clientId,AP_SANDBOX_CONVEX_URL:"http://127.0.0.1:3252",AP_BANK_SCOPE:JSON.stringify({organizationId:"fixture",runId:"ap97-auth0-fixture",provider:"increase",environment:"sandbox",accountId:"fixture-account"}),AP_SANDBOX_AP_SEAT_ID:"fixture-ap",AP_SANDBOX_AP_SEAT_TOKEN:"fixture-ap-credential",AP_SANDBOX_PAYMENTS_SEAT_ID:"fixture-payments",AP_SANDBOX_PAYMENTS_SEAT_TOKEN:"fixture-payments-credential",AP_SANDBOX_TRUSTED_CONTEXT:JSON.stringify({supplier:{supplierId:"fixture-supplier",legalName:"Fixture supplier"},coding:{account:"5000",store:null,department:null,project:null,treatment:"expense"}})};
describe("AP sandbox startup configuration",()=>{
 it("fails closed without explicit Auth0 and Increase configuration",()=>{
  expect(()=>parseAPSandboxConfig({})).toThrow(/ISSUER/);
  expect(()=>parseAPSandboxConfig({...env,AP_SANDBOX_CONVEX_URL:"http://127.0.0.1:3250"})).toThrow(/reserved/);
  expect(()=>parseAPSandboxConfig({...env,AP_BANK_SCOPE:JSON.stringify({organizationId:"f",runId:"ap97-fixture",provider:"fake",environment:"local",accountId:"fake"})})).toThrow(/Increase/);
  expect(()=>parseAPSandboxConfig({...env,AP_SANDBOX_AP_SEAT_TOKEN:undefined})).toThrow(/AP_SANDBOX_AP_SEAT_TOKEN/);
 });
 it("requires exact Auth0 issuer/audience and never accepts local test identity",()=>{
  for(const bad of ["http://unit-fixture.auth0.com/","https://unit-fixture.auth0.com","https://ap-demo.invalid/","https://unit-fixture.auth0.com/other"])expect(()=>parseAPAuth0Config({...env,AP_HUMAN_AUTH_ISSUER:bad})).toThrow();
  expect(()=>parseAPAuth0Config({...env,AP_HUMAN_AUTH_AUDIENCE:""})).toThrow();
  expect(()=>parseAPAuth0Config({...env,AP_HUMAN_SUBJECT:"https://ap-demo.invalid|human"})).toThrow();
 });
 it("parses only explicit private same-issuer subject lists and retains single-subject compatibility",()=>{
  const subjects=[issuer+"|auth0|a",issuer+"|auth0|b"];
  expect(parseAPAuth0Config({...env,AP_HUMAN_SUBJECT:config.approvedSubject,AP_HUMAN_SUBJECTS:JSON.stringify([...subjects,subjects[0]])})).toMatchObject({approvedSubject:config.approvedSubject,approvedSubjects:subjects});
  for(const value of ["not json","{}",JSON.stringify([issuer+"|"]),JSON.stringify(["https://other.auth0.com/|auth0|a"]),JSON.stringify([""])])expect(()=>parseAPAuth0Config({...env,AP_HUMAN_SUBJECTS:value})).toThrow();
  expect(()=>parseAPAuth0Config({...env,AP_HUMAN_SUBJECT:issuer+"|"})).toThrow();
 });
 it("supports identity-only owner setup and exposes no private scope or credentials",()=>{
  const parsed=parseAPSandboxConfig(env,"/private/tmp/auth0-unit");
  expect(parsed.auth.approvedSubject).toBeUndefined();
  const runtime=createAPSandboxRuntime(parsed,env);
  expect(runtime.runtime()).toMatchObject({identityMode:"authenticated_human",ownerBindingConfigured:false});
  const serialized=JSON.stringify({runtime:runtime.runtime(),auth:runtime.auth.publicConfig});
  for(const privateValue of [env.AP_SANDBOX_AP_SEAT_TOKEN,env.AP_SANDBOX_PAYMENTS_SEAT_TOKEN,"fixture-account","ap97-auth0-fixture"])expect(serialized).not.toContain(privateValue);
 });
});
