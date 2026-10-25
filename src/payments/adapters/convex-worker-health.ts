import { api } from "../../../convex/_generated/api";
import { BankProviderError, PAYMENT_EXECUTOR_VERSION, type BankScope } from "../contracts";
import { parseBankScope } from "../domain/validation";
import type { KernelTransport } from "./convex-transport";

export type WorkerPass = { outcome: "ok" | "partial" | "failed"; errorClass?: string };

/** Best-effort wall-clock pass reports. Only an outcome and an error CLASS leave the worker. */
export function createConvexWorkerHealth(client: KernelTransport, binding: BankScope, token: string, worker: "dispatcher" | "evidence", workerId: string) {
  const scope = parseBankScope(binding);
  return async (pass: WorkerPass) => {
    try {
      if (worker === "dispatcher") await client.mutation(api.demoOps.recordDispatcherPass, { scope, token, workerId, paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, ...pass });
      else await client.mutation(api.demoOps.recordEvidencePass, { scope, token, workerId, ...pass });
    } catch { /* Health is observability; a failed report must not fail or retry financial work. */ }
  };
}

export function errorClassOf(error: unknown): string {
  if (error instanceof BankProviderError) return error.errorClass;
  return error instanceof Error && /Forbidden|credential/.test(error.message) ? "authentication" : "kernel";
}

/** Run one pass and report it, rethrowing the pass's own failure unchanged. */
export async function reportedPass<T>(report: (pass: WorkerPass) => Promise<void>, run: () => Promise<T>, classify: (result: T) => WorkerPass): Promise<T> {
  let result: T;
  try { result = await run(); }
  catch (error) { await report({ outcome: "failed", errorClass: errorClassOf(error) }); throw error; }
  await report(classify(result));
  return result;
}
