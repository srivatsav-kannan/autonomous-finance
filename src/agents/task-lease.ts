/** A lost lease prevents the worker from reporting a successful queue transition. */
export class TaskLeaseLost extends Error {}

type Renewal = { ok: true } | { ok: false; code: string; error: string };

/** Keep long handlers alive, with at most one renewal in flight and no timer after work ends. */
export async function withTaskLease<T>(renew: () => Promise<Renewal>, work: () => Promise<T>): Promise<T> {
  let pending: Promise<void> = Promise.resolve();
  let renewing = false;
  let lost: TaskLeaseLost | undefined;
  const timer = setInterval(() => {
    if (renewing || lost) return;
    renewing = true;
    pending = Promise.resolve().then(renew).then((result) => {
      if (!result.ok) lost = new TaskLeaseLost(`${result.code}: ${result.error}`);
    }, (error: unknown) => {
      lost = new TaskLeaseLost("lease renewal failed", { cause: error });
    }).finally(() => { renewing = false; });
  }, 30_000);
  let result: T;
  try {
    result = await work();
  } finally {
    clearInterval(timer);
    // Finish a pending renewal before the final transition clears the lease.
    await pending;
  }
  if (lost) throw lost;
  return result;
}
