// The other origins belong only to dev-only, isolated FakeBank rehearsals with one exact run and scope each.
const DEV_REHEARSALS: Record<string, { runId: string; organizationId: string; accountId: string }> = {
  "http://127.0.0.1:5198": { runId: "ap97-b3-guidance-20261025-v1", organizationId: "ap97-b3-synthetic-company", accountId: "ap97-b3-usd-operating" },
  "http://127.0.0.1:5195": { runId: "ap97-i3-20261025", organizationId: "ap97-i3-synthetic-company", accountId: "ap97-i3-usd-operating" },
  // Issue #107 APEX World 9 replay.
  "http://127.0.0.1:5197": { runId: "apex107-replay-20261025", organizationId: "apex107-synthetic-sterling-marsh", accountId: "apex107-usd-operating" },
};
export function isLocalSimulationOrigin(runtime: unknown, origin: string, development: boolean): boolean {
  if (!runtime || typeof runtime !== "object") return false;
  const value = runtime as { identityMode?: unknown; runId?: unknown; scope?: { provider?: unknown; environment?: unknown; runId?: unknown; organizationId?: unknown; accountId?: unknown } };
  if (value.identityMode !== "simulated_human") return false;
  // 5193 is the isolated AP workspace. 5173 is the combined console started by `npm run demo`. Neither is the Auth0 origin (5192).
  if (origin === "http://127.0.0.1:5193" || origin === "http://127.0.0.1:5173") return true;
  const rehearsal = Object.hasOwn(DEV_REHEARSALS, origin) ? DEV_REHEARSALS[origin] : undefined;
  return development && !!rehearsal
    && value.runId === rehearsal.runId
    && value.scope?.runId === value.runId
    && value.scope.provider === "fake" && value.scope.environment === "local"
    && value.scope.organizationId === rehearsal.organizationId
    && value.scope.accountId === rehearsal.accountId;
}
