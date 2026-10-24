import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskLeaseLost, withTaskLease } from "../src/agents/task-lease";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("handler lease renewal", () => {
  it("renews a long handler every 30 seconds and clears its timer on completion", async () => {
    const work = deferred<string>();
    const renew = vi.fn(async () => ({ ok: true as const }));
    const run = withTaskLease(renew, () => work.promise);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(renew).toHaveBeenCalledTimes(5);
    work.resolve("done");
    await expect(run).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledTimes(5);
  });

  it("serializes renewals and awaits the last heartbeat before allowing a final transition", async () => {
    const work = deferred<string>();
    const heartbeat = deferred<{ ok: true }>();
    const renew = vi.fn(() => heartbeat.promise);
    let finished = false;
    const run = withTaskLease(renew, () => work.promise).then((result) => { finished = true; return result; });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(renew).toHaveBeenCalledTimes(1);
    work.resolve("done");
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    heartbeat.resolve({ ok: true });
    await expect(run).resolves.toBe("done");
    expect(finished).toBe(true);
  });

  it.each(["denied", "network"])("does not report success after a %s heartbeat", async (mode) => {
    const work = deferred<string>();
    const renew = vi.fn(async () => {
      if (mode === "network") throw new Error("connection lost");
      return { ok: false as const, code: "stale_lease", error: "claimed again" };
    });
    const run = withTaskLease(renew, () => work.promise);
    const rejected = expect(run).rejects.toBeInstanceOf(TaskLeaseLost);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(renew).toHaveBeenCalledTimes(1);
    work.resolve("handler result");
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops renewing when a handler throws", async () => {
    const work = deferred<string>();
    const renew = vi.fn(async () => ({ ok: true as const }));
    const run = withTaskLease(renew, () => work.promise);
    const rejected = expect(run).rejects.toThrow("handler failed");
    await vi.advanceTimersByTimeAsync(30_000);
    work.reject(new Error("handler failed"));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
