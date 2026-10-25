import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Auth0Client } from "@auth0/auth0-spa-js";
import { z } from "zod";
import { configureAPSession } from "./apAuthSession";
import { apSystemApi } from "./apSystemApi";
import { APLocalSimulationGate } from "./APLocalSimulationGate";
import "./apAuth.css";
import { isLocalSimulationOrigin } from "./apLocalSimulationOrigin";

export const AP_AUTH_CALLBACK = "http://127.0.0.1:5192/ap-system";
export function apAuthReturnUrl(appState: unknown) {
  const url = new URL(AP_AUTH_CALLBACK);
  const result = z.object({ caseId: z.string().min(1).max(200).optional() }).safeParse(appState);
  if (result.success && result.data.caseId) url.searchParams.set("case", result.data.caseId);
  return url.toString();
}
const authConfig = z.object({ mode: z.literal("auth0"), domain: z.string().regex(/^[a-z0-9.-]+\.auth0\.com$/), clientId: z.string().min(1) });
const simulationConfig=z.object({mode:z.literal("local_simulation"),actors:z.array(z.object({id:z.string().regex(/^[-a-z0-9]{1,80}$/),name:z.string().trim().min(1).max(120)})).min(1).max(20)});
type Boot = { mode: "local" } | { mode: "auth0"; client: Auth0Client } | z.infer<typeof simulationConfig>;
let boot: Promise<Boot> | undefined;
async function initialize(): Promise<Boot> {
  const response = await fetch("/api/ap-system/runtime", { credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("AP service unavailable. Start the configured gateway, then retry.");
  const runtime = await response.json();
  if (!runtime.auth && runtime.identityMode === "simulated_human") return { mode: "local" };
  if(runtime.auth?.mode==="local_simulation"){
    if(!isLocalSimulationOrigin(runtime,location.origin,import.meta.env.DEV))throw new Error("Local simulation must use its isolated development workspace.");
    return simulationConfig.parse(runtime.auth);
  }
  const config = authConfig.safeParse(runtime.auth);
  if (!config.success) throw new Error("Auth0 is not configured. Complete the development tenant setup before signing in.");
  if (location.origin !== new URL(AP_AUTH_CALLBACK).origin) throw new Error(`Open ${AP_AUTH_CALLBACK} to use the configured Auth0 callback.`);
  const { Auth0Client } = await import("@auth0/auth0-spa-js");
  const client = new Auth0Client({ domain: config.data.domain, clientId: config.data.clientId, cacheLocation: "memory", useRefreshTokens: false, authorizationParams: { redirect_uri: AP_AUTH_CALLBACK, scope: "openid profile" } });
  const params = new URLSearchParams(location.search);
  if (params.has("state") && (params.has("code") || params.has("error"))) {
    try { const result = await client.handleRedirectCallback(); history.replaceState(null, "", apAuthReturnUrl(result.appState)); }
    catch (error) { history.replaceState(null, "", AP_AUTH_CALLBACK); throw error; }
  } else { try { await client.checkSession(); } catch { /* Browser silent-auth restrictions still allow explicit redirect login. */ } }
  return { mode: "auth0", client };
}
async function idToken(client: Auth0Client) {
  // Same ID-token flow used by ConvexProviderWithAuth0. Convex validates the SPA client-ID audience.
  const result = await client.getTokenSilently({ detailedResponse: true });
  if (!result?.id_token) throw new Error("Sign in again.");
  return result.id_token;
}
export type APAuthViewState = "loading" | "login" | "unavailable" | "unapproved" | "signing_out";
export function APAuthStatus({ state, message, identity, onLogin, onRetry, onLogout }: { state: APAuthViewState; message?: string; identity?: string; onLogin: () => void; onRetry: () => void; onLogout: () => void }) {
  return <section className="ap-auth aps-app" aria-labelledby="ap-auth-title">
    <p className="ap-auth-context">{state === "unavailable" || state === "loading" ? "Accounts payable" : "Increase sandbox"}</p>
    <h2 id="ap-auth-title">{state === "loading" ? "Checking your sign-in" : state === "signing_out" ? "Signing out" : state === "unavailable" ? "Connect the AP service" : state === "unapproved" ? "Your account needs workspace access" : "Sign in to review and authorize"}</h2>
    {state === "loading" || state === "signing_out" ? <p role="status">{state === "loading" ? "Checking the configured service and your browser session…" : "Closing your AP session…"}</p> : <>
      <p>{state === "unapproved" ? "You are signed in. The workspace owner must approve this identity before cases or source documents become available." : state === "unavailable" ? "Start the AP gateway. For Increase sandbox, complete Auth0 setup before signing in." : "Use your Auth0 account to access evidence and approve an exact payment. Signing in does not authorize a transfer."}</p>
      {message && <p className="ap-auth-message" role="status">{message}</p>}
      {identity && <dl className="ap-auth-identity"><dt>Verified identity for owner setup</dt><dd><code>{identity}</code></dd></dl>}
      <div className="ap-auth-actions">{state === "login" && <button className="primary" onClick={onLogin}>Sign in with Auth0</button>}{state !== "login" && <button onClick={onRetry}>{state === "unapproved" ? "Check access again" : "Retry connection"}</button>}{state === "unapproved" && <button onClick={onLogout}>Sign out</button>}</div>
      <p className="ap-auth-caption">{state === "unapproved" ? "Share this identity privately with the workspace owner. It is not a token or a password." : "Local FakeBank uses a simulated identity. Increase sandbox requires an approved human account."}</p>
    </>}
  </section>;
}
export function APAuthGate({ children,busy=false }: { children: ReactNode;busy?:boolean }) {
  const stop = useRef(() => {});
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<APAuthViewState | "ready" | "local" | "simulation">("loading");
  const [actors,setActors]=useState<{id:string;name:string}[]>([]);
  const [client, setClient] = useState<Auth0Client>();
  const [identity, setIdentity] = useState<string>();
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    let live = true; let release = () => {}; let timer: ReturnType<typeof setInterval> | undefined;
    setState("loading"); setMessage(undefined); setIdentity(undefined);
    const expired = () => { if (timer) clearInterval(timer); configureAPSession(null); if (live) { setIdentity(undefined); setState("login"); setMessage("Your sign-in expired. Sign in again to continue."); } };
    const start = async () => {
      const result = await (boot ??= initialize().catch(error => { boot = undefined; throw error; }));
      if (!live) return;
      if (result.mode === "local") { release = configureAPSession({ mode: "local" }); setState("local"); return; }
      if(result.mode==="local_simulation"){setActors(result.actors);setState("simulation");return;}
      setClient(result.client);
      if (!await result.client.isAuthenticated()) { if (live) setState("login"); return; }
      if (!live) return;
      release = configureAPSession({ mode: "auth0", token: () => idToken(result.client), expired });
      const verify = async () => {
        try { const user = await apSystemApi.whoami(); if (live) { setIdentity(user.tokenIdentifier); setState(user.approved ? "ready" : "unapproved"); } return true; }
        catch { if (live) expired(); return false; }
      };
      const verified = await verify();
      if (live && verified) timer = setInterval(() => { void verify(); }, 60_000);
    };
    void start().catch(() => { if (live) { configureAPSession(null); setState("unavailable"); setMessage("The sign-in service could not be initialized. Check the Auth0 callback and gateway configuration."); } });
    const cleanup = () => { live = false; release(); if (timer) clearInterval(timer); };
    stop.current = cleanup;
    return cleanup;
  }, [attempt]);
  const retry = () => { boot = undefined; setAttempt(value => value + 1); };
  const login = async () => {
    if (!client) return;
    setState("loading"); setMessage(undefined);
    try { await client.loginWithRedirect({ appState: { caseId: new URLSearchParams(location.search).get("case") ?? undefined }, authorizationParams: { redirect_uri: AP_AUTH_CALLBACK, prompt: "select_account" } }); }
    catch { setState("login"); setMessage("Sign-in could not start. Check the Auth0 application settings and retry."); }
  };
  const logout = async () => {
    setState("signing_out"); setIdentity(undefined);
    const closing = apSystemApi.logout(); stop.current();
    try { await closing; } catch { /* Local data is already hidden; Auth0 logout still follows. */ }
    boot = undefined;
    try { await client?.logout({ logoutParams: { returnTo: AP_AUTH_CALLBACK } }); }
    catch { setState("login"); setMessage("Your local AP session is closed. Retry sign-in to choose an account."); }
  };
  if(state==="simulation")return <APLocalSimulationGate actors={actors} busy={busy}>{children}</APLocalSimulationGate>;
  if (state === "local") return children;
  if (state === "ready") return <><div className="ap-auth-session aps-app"><span>Signed in to Increase sandbox<small>{identity}</small></span><button onClick={() => { void logout(); }}>Sign out</button></div>{children}</>;
  return <APAuthStatus state={state} identity={identity} message={message} onLogin={() => { void login(); }} onRetry={retry} onLogout={() => { void logout(); }} />;
}
