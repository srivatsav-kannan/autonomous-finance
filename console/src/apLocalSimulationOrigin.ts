// The second origin belongs only to the dev-only, isolated I3 process-recovery rehearsal.
export function isLocalSimulationOrigin(runtime: unknown, origin: string, development: boolean): boolean {
  if (!runtime || typeof runtime !== "object") return false;
  const value = runtime as { identityMode?: unknown; runId?: unknown; scope?: { provider?: unknown; environment?: unknown; runId?: unknown; organizationId?: unknown; accountId?: unknown } };
  if (value.identityMode !== "simulated_human") return false;
  if (origin === "http://127.0.0.1:5193") return true;
  return development && origin === "http://127.0.0.1:5195"
    && value.runId === "ap97-i3-20261025"
    && value.scope?.runId === value.runId
    && value.scope.provider === "fake" && value.scope.environment === "local"
    && value.scope.organizationId === "ap97-i3-synthetic-company"
    && value.scope.accountId === "ap97-i3-usd-operating";
}
