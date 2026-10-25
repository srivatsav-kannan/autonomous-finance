// Shared preflight for runners that need the local backend: reachable, and accepting our admin secret.
import { AdminClient, api } from "../../src/core/kernel-client";

/** Returns an AdminClient, or a one-line reason the backend can't be used yet. */
export async function checkBackend(): Promise<{ ok: true; admin: AdminClient } | { ok: false; reason: string }> {
  try {
    const admin = new AdminClient();
    // A valid secret gets past the admin check and fails only on the unknown run; nothing is written.
    const probe = await admin.client.mutation(api.admin.setSimDate, { secret: admin.secret, runId: "__preflight-probe__", simDate: "2026-01-01" });
    if (probe.ok || probe.code === "not_found") return { ok: true, admin };
    return { ok: false, reason: `the backend refused the admin secret (${probe.code}); run npm run backend:configure` };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0]! : String(e);
    return { ok: false, reason: /missing env var/.test(msg) ? `${msg}; run npm run setup` : `cannot reach the backend (${msg}); start npm run backend, then npm run backend:configure` };
  }
}
