import type { MutationCtx } from "../_generated/server";
import { checkIdempotency, storeIdempotency, type Fail } from "./kernel";

/** Authenticate before calling. Retries replay a committed response, never a new lease. */
export async function workerRequest<A extends { runId: string; seatId: string; token: string; requestId?: string }, R extends { ok: boolean }>(
  ctx: MutationCtx, args: A, operation: string, work: () => Promise<R>,
): Promise<R | Fail> {
  if (!args.requestId) return await work(); // Existing callers retain strict lease checks.
  const { token: _token, ...payload } = args;
  const key = `worker:${operation}:${args.seatId}:${args.requestId}`;
  const prior = await checkIdempotency(ctx, args.runId, key, operation, payload);
  if ("conflict" in prior) return prior.conflict;
  if (prior.hit) return prior.result as R;
  const result = await work();
  // Empty polls have no side effects to replay and must not fill the idempotency table.
  if (result.ok && !("task" in result && result.task === null)) {
    await storeIdempotency(ctx, args.runId, key, operation, prior.payloadHash, result);
  }
  return result;
}
