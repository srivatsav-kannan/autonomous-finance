/** Transport failures are classified without copying URLs, tokens or response bodies. */
export class WorkerHttpError extends Error {
  constructor(readonly status: number) { super(`kernel HTTP ${status}`); }
}

export const workerFetch: typeof fetch = async (input, init) => {
  const timeout = AbortSignal.timeout(5_000);
  const response = await fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  // 560 is Convex's function-error response, which its client must decode.
  if (!response.ok && response.status !== 560) {
    void response.body?.cancel();
    throw new WorkerHttpError(response.status);
  }
  return response;
};

export class ControlPlaneUnavailable extends Error {}
export class OperatorActionRequired extends Error {}
export class WorkerStopped extends Error {}
class RpcTimeout extends Error {}

export type Diagnostic = Record<string, string | number | boolean | undefined>;
export const reportDiagnostic = (event: Diagnostic) => console.error(JSON.stringify({ component: "agent-worker", ...event }));

export function transientFailure(error: unknown): boolean {
  if (error instanceof RpcTimeout) return true;
  if (error instanceof WorkerHttpError) return [408, 429, 500, 502, 503, 504].includes(error.status);
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code)) return true;
  // Node's fetch wraps socket/DNS failures; unknown application exceptions fail closed.
  return error.name === "TimeoutError" || (error instanceof TypeError && /fetch failed|failed to fetch|networkerror/i.test(error.message));
}

export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new WorkerStopped("worker stopped")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface RetryOptions { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; timeoutMs?: number }

export class ControlPlane {
  readonly degraded = new Set<string>();
  constructor(private readonly report = reportDiagnostic, private readonly options: RetryOptions = {}) {
    for (const value of Object.values(options)) {
      if (!Number.isFinite(value) || value <= 0) throw new Error("retry options must be positive and finite");
    }
    if (!Number.isInteger(options.attempts ?? 3) || (options.attempts ?? 3) > 10) throw new Error("retry attempts must be an integer from 1 to 10");
  }

  async call<T>(operation: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const attempts = this.options.attempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw new WorkerStopped("worker stopped");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => {
            if (signal?.aborted) throw new WorkerStopped("worker stopped");
            return work();
          }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RpcTimeout()), this.options.timeoutMs ?? 5_000); }),
        ]);
        if (this.degraded.delete(operation)) this.report({ event: "recovered", operation });
        return result;
      } catch (error) {
        if (error instanceof WorkerStopped) throw error;
        if (!transientFailure(error)) {
          this.report({ event: "operator_action_required", operation, reason: "nontransient_rpc_failure" });
          throw new OperatorActionRequired(`${operation}: nontransient RPC failure; check deployment, credentials and server logs`);
        }
        this.degraded.add(operation);
        this.report({ event: "degraded", operation, attempt, exhausted: attempt >= attempts });
        if (attempt >= attempts) throw new ControlPlaneUnavailable(`${operation}: transient RPC retry budget exhausted`);
      } finally {
        clearTimeout(timer);
      }
      const cap = Math.min(this.options.maxDelayMs ?? 1_000, (this.options.baseDelayMs ?? 100) * 2 ** (attempt - 1));
      await pause(Math.max(1, Math.round(cap * (0.5 + Math.random() * 0.5))), signal);
    }
  }
}

/** Lease rejections are expected fencing, while authentication/configuration needs an operator. */
export function checkWorkerResult(result: { ok: boolean; code?: string }, operation: string): void {
  if (!result.ok && !["not_leased", "not_lease_owner", "stale_lease", "lease_expired"].includes(result.code ?? "")) {
    throw new OperatorActionRequired(`${operation}: kernel rejected request; check seat credentials, configuration and violation records`);
  }
}
