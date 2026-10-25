import { apRequestPath, isApexWorkspace } from "./apRuntime";
/** Only the AP gateway receives the human ID token. Tokens live in the Auth0 SDK's memory cache. */
export class APSystemApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}
type Session = { mode: "local" } | { mode: "local_simulation"; actorId:string; expired:()=>void } | { mode: "auth0"; token: () => Promise<string>; expired: () => void };
let session: Session | null = null;
let sessionRuntime = false;
let pending = new AbortController();
export function configureAPSession(next: Session | null) {
  pending.abort(); pending = new AbortController(); session = next; sessionRuntime = isApexWorkspace();
  return () => { if (session === next) configureAPSession(null); };
}
const stale = () => new APSystemApiError("Your sign-in changed. Open the workspace again.", 401, "session_changed");
export async function apProtectedFetch(path: string, init: RequestInit = {}) {
  if (!path.startsWith("/api/ap-system/") || path.includes("\\")) throw new Error("AP requests must use the same-origin AP gateway.");
  const current = session; const runtime = sessionRuntime;
  const assertCurrent = () => { if (session !== current || runtime !== isApexWorkspace()) throw stale(); };
  if (!current) throw new APSystemApiError("Sign in before opening the AP workspace.", 401, "authentication_required");
  const headers = new Headers(init.headers);
  if (current.mode === "auth0") {
    try { headers.set("Authorization", `Bearer ${await current.token()}`); }
    catch { assertCurrent(); current.expired(); throw new APSystemApiError("Your sign-in expired. Sign in again.", 401, "authentication_required"); }
  }
  if(current.mode==="local_simulation")headers.set("Authorization",`Bearer local:${current.actorId}`);
  assertCurrent();
  const signals = [pending.signal, init.signal ?? AbortSignal.timeout(180_000)];
  const response = await fetch(apRequestPath(path, runtime), { ...init, headers, signal: AbortSignal.any(signals), credentials: "same-origin", redirect: "error" });
  assertCurrent();
  if (current.mode === "auth0"||current.mode==="local_simulation") {
    const denied = response.status === 403 && (await response.clone().json().catch(() => null))?.error?.code === "owner_binding_required";
    assertCurrent();
    if (response.status === 401 || denied) current.expired();
  }
  return { response, assertCurrent };
}
/** Hide old data and abort in-flight work before the revocation request completes. */
export async function closeAPSession() {
  const previous = session; const previousRuntime = sessionRuntime; configureAPSession(null);
  if (!previous||previous.mode === "local") return;
  const token = previous.mode==="local_simulation"?`local:${previous.actorId}`:await previous.token();
  await fetch(apRequestPath("/api/ap-system/logout", previousRuntime), { method: "POST", credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${token}`, "X-AP-System-Session": "1" } });
}
