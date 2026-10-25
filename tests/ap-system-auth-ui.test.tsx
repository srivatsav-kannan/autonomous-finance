import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { APLocalSimulationGate, APLocalSimulationBanner } from "../console/src/APLocalSimulationGate";
import { APAuthGate, APAuthStatus, apAuthReturnUrl, isHyphenateDemoRuntime } from "../console/src/APAuthGate";
import { apProtectedFetch, closeAPSession, configureAPSession } from "../console/src/apAuthSession";
import { apSystemApi, downloadOriginal, loadPage, validatePaymentRequest } from "../console/src/apSystemApi";
import { apUIFixture, uiSourceText } from "./ap-system-ui.fixture";
afterEach(()=>{configureAPSession(null);vi.unstubAllGlobals();vi.restoreAllMocks();});
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}});
const hooks={onLogin:()=>{},onRetry:()=>{},onLogout:()=>{}};
describe("Auth0 AP gate and request lifetime",()=>{
 it("admits only the isolated Hyphenate FakeBank run at the dedicated local origin",()=>{
  const runtime={identityMode:"simulated_human",runId:"ap97-b3-hyphenate-test",scope:{runId:"ap97-b3-hyphenate-test",provider:"fake",environment:"local"}};
  expect(isHyphenateDemoRuntime(runtime,"http://127.0.0.1:5196")).toBe(true);
  for(const origin of ["http://127.0.0.1:5192","http://localhost:5196","https://127.0.0.1:5196","https://demo.invalid"])expect(isHyphenateDemoRuntime(runtime,origin)).toBe(false);
  for(const bad of [{...runtime,identityMode:"authenticated_human"},{...runtime,runId:"apex107-replay-20261025"},{...runtime,scope:{...runtime.scope,provider:"increase"}},{...runtime,scope:{...runtime.scope,environment:"sandbox"}},{...runtime,scope:{...runtime.scope,runId:"different"}},null])expect(isHyphenateDemoRuntime(bad,"http://127.0.0.1:5196")).toBe(false);
 });
 it("does not mount workspace before runtime and identity are established",()=>{
  const html=renderToStaticMarkup(<APAuthGate><div>private case content</div></APAuthGate>);
  expect(html).toContain("Checking your sign-in");expect(html).not.toContain("private case content");
  const login=renderToStaticMarkup(<APAuthStatus state="login" {...hooks}/>);
  expect(login).toContain("Sign in with Auth0");expect(login).toContain("Signing in does not authorize a transfer");expect(login).not.toContain("textarea");
  const pending=renderToStaticMarkup(<APAuthStatus state="unapproved" identity="https://fixture.auth0.com/|auth0|reviewer" {...hooks}/>);
  expect(pending).toContain("Verified identity for owner setup");expect(pending).not.toContain("Authorize this payment");expect(pending).toContain("Check access again");
 });
 it("requires explicit local actor selection and labels every identity as simulated",()=>{
  const actors=[{id:"owner-a",name:"Simulated owner A"},{id:"owner-b",name:"Simulated owner B"}];
  const html=renderToStaticMarkup(<APLocalSimulationGate actors={actors}><p>private prior actor case</p></APLocalSimulationGate>);
  expect(html).toContain("Local multi-human simulation / FakeBank");expect(html).toContain("Choose a simulated actor");expect(html).not.toContain("private prior actor case");expect(html).not.toContain("textarea");
  const ready=renderToStaticMarkup(<APLocalSimulationBanner actors={actors} selected="owner-b" busy={true} state="ready" onSelect={()=>{}} onRetry={()=>{}}/>);
  expect(ready).toContain("Acting as Simulated owner B");expect(ready).toMatch(/<select[^>]*disabled/);expect(ready).toContain("not an Auth0 login");
 });
 it("keeps public simulated selection in memory and rejects an old actor response after switching",async()=>{
  let finish!:(value:Response)=>void;const fetcher=vi.fn((_url:string,_init?:RequestInit)=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal("fetch",fetcher);
  configureAPSession({mode:"local_simulation",actorId:"owner-a",expired:vi.fn()});const result=apSystemApi.list();await vi.waitFor(()=>expect(fetcher).toHaveBeenCalled());
  expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get("Authorization")).toBe("Bearer local:owner-a");const signal=fetcher.mock.calls[0]![1]!.signal!;
  configureAPSession({mode:"local_simulation",actorId:"owner-b",expired:vi.fn()});expect(signal.aborted).toBe(true);finish(response([]));await expect(result).rejects.toMatchObject({code:"session_changed"});
 });
 it("returns from the SDK callback only to the AP route with a case identifier",()=>{
  expect(apAuthReturnUrl({caseId:"case /1",returnTo:"https://other.invalid"})).toBe("http://127.0.0.1:5192/ap-system?case=case+%2F1");
  expect(apAuthReturnUrl("https://other.invalid")).toBe("http://127.0.0.1:5192/ap-system");
 });
 it("blocks requests before a runtime mode is established",async()=>{
  const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
  await expect(apSystemApi.list()).rejects.toMatchObject({code:"authentication_required"});expect(fetcher).not.toHaveBeenCalled();
 });
 it("attaches the current memory token only to the same-origin AP gateway and forbids redirects",async()=>{
  const fetcher=vi.fn().mockResolvedValue(response([]));vi.stubGlobal("fetch",fetcher);
  const token=vi.fn().mockResolvedValue("opaque-memory-fixture");configureAPSession({mode:"auth0",token,expired:vi.fn()});
  await apSystemApi.list();
  expect(new Headers(fetcher.mock.calls[0]![1].headers).get("Authorization")).toBe("Bearer opaque-memory-fixture");expect(fetcher.mock.calls[0]![1]).toMatchObject({credentials:"same-origin",redirect:"error"});
  await expect(apProtectedFetch("https://other.invalid/api/ap-system/cases")).rejects.toThrow(/same-origin/);expect(token).toHaveBeenCalledTimes(1);
 });
 it("keeps explicit local simulated requests usable without a human Bearer",async()=>{
  const fetcher=vi.fn().mockResolvedValue(response([]));vi.stubGlobal("fetch",fetcher);configureAPSession({mode:"local"});await apSystemApi.list();
  expect(new Headers(fetcher.mock.calls[0]![1].headers).has("Authorization")).toBe(false);
 });
 it("invalidates old responses after a user change and aborts their network signal",async()=>{
  let finish!:(result:Response)=>void;const fetcher=vi.fn((_url:string,_init?:RequestInit)=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal("fetch",fetcher);
  configureAPSession({mode:"auth0",token:async()=>"user-a",expired:vi.fn()});const result=apSystemApi.list();await vi.waitFor(()=>expect(fetcher).toHaveBeenCalled());
  const signal=fetcher.mock.calls[0]![1]!.signal as AbortSignal;
  configureAPSession({mode:"auth0",token:async()=>"user-b",expired:vi.fn()});expect(signal.aborted).toBe(true);finish(response([]));
  await expect(result).rejects.toMatchObject({code:"session_changed"});
 });
 it("does not issue an old user's request when token acquisition finishes after logout",async()=>{
  let finish!:(token:string)=>void;const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
  configureAPSession({mode:"auth0",token:()=>new Promise<string>(resolve=>{finish=resolve;}),expired:vi.fn()});const result=apSystemApi.list();configureAPSession(null);finish("old-user");
  await expect(result).rejects.toMatchObject({code:"session_changed"});expect(fetcher).not.toHaveBeenCalled();
 });
 it("closes local access immediately while the subject-bound logout request is pending",async()=>{
  let finish!:(result:Response)=>void;const fetcher=vi.fn((_url:string,_init?:RequestInit)=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal("fetch",fetcher);
  configureAPSession({mode:"auth0",token:async()=>"logout-fixture",expired:vi.fn()});const closing=closeAPSession();await vi.waitFor(()=>expect(fetcher).toHaveBeenCalled());
  await expect(apSystemApi.list()).rejects.toMatchObject({code:"authentication_required"});
  expect(fetcher.mock.calls[0]![0]).toBe("/api/ap-system/logout");expect(fetcher.mock.calls[0]![1]).toMatchObject({method:"POST",headers:{Authorization:"Bearer logout-fixture","X-AP-System-Session":"1"}});finish(response({ok:true}));await closing;
 });
 it.each([401,403])("hides access when the token expires or owner binding changes (%s)",async status=>{
  const expired=vi.fn(()=>configureAPSession(null));vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({error:{code:status===403?"owner_binding_required":"authentication_required"}},status)));
  configureAPSession({mode:"auth0",token:async()=>"revoked-fixture",expired});await expect(apSystemApi.list()).rejects.toThrow();expect(expired).toHaveBeenCalledOnce();
 });
 it("authenticates both raster and original downloads and retains byte/version checks",async()=>{
  const source=apUIFixture().sources[0]!;
  const fetcher=vi.fn().mockResolvedValueOnce(new Response("raster-fixture",{headers:{"Content-Type":"image/png","X-AP-Source-SHA256":source.sha256,"X-AP-Source-Revision":"1","X-AP-Page":"1"}})).mockResolvedValueOnce(new Response(uiSourceText));vi.stubGlobal("fetch",fetcher);
  const click=vi.fn();vi.stubGlobal("document",{createElement:()=>({click})});
  configureAPSession({mode:"auth0",token:async()=>"source-fixture",expired:vi.fn()});
  expect((await loadPage(source,1,new AbortController().signal)).type).toBe("image/png");await downloadOriginal(source);expect(click).toHaveBeenCalledOnce();
  for(const [url,options] of fetcher.mock.calls){expect(url).not.toContain("source-fixture");expect(new Headers(options.headers).get("Authorization")).toBe("Bearer source-fixture");}
 });
 it("validates calendar/cents/credit requests before fetch and keeps cancel separate",async()=>{
  const base={expectedRevision:1,snapshotHash:"a".repeat(64),idempotencyKey:"key"};
  expect(validatePaymentRequest({...base,executionDate:"2028-02-29",amountCents:500,credits:[{creditId:"credit",amountCents:100}]}).amountCents).toBe(500);
  for(const delta of [{executionDate:"2026-02-29"},{amountCents:1.2},{credits:[{creditId:"c",amountCents:1},{creditId:"c",amountCents:1}]}])expect(()=>validatePaymentRequest({...base,...delta})).toThrow();
  const fetcher=vi.fn().mockResolvedValue(response({ok:true}));vi.stubGlobal("fetch",fetcher);configureAPSession({mode:"local"});await apSystemApi.cancelPayment("case","version",{expectedRevision:1,snapshotHash:base.snapshotHash});expect(fetcher.mock.calls[0]![0]).toBe("/api/ap-system/cases/case/payments/version/cancel");
 });
});
