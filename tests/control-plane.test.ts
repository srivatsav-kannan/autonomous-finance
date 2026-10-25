import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/core/kernel-client";
import { ControlPlane, ControlPlaneUnavailable, OperatorActionRequired, pause, workerFetch, WorkerHttpError } from "../src/agents/control-plane";
import { installShutdown } from "../src/agents/shutdown";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); process.exitCode = undefined; });

describe("bounded transport recovery", () => {
  it("uses capped exponential jitter, then marks recovery", async () => {
    const report = vi.fn();
    const control = new ControlPlane(report);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const work = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockRejectedValueOnce(new WorkerHttpError(503)).mockResolvedValue("ok");
    const pending = control.call("test", work);
    await vi.advanceTimersByTimeAsync(74);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(150);
    await expect(pending).resolves.toBe("ok");
    expect(control.degraded.size).toBe(0);
    expect(report).toHaveBeenLastCalledWith({ event: "recovered", operation: "test" });
  });

  it("bounds hung calls and never retries an unknown application exception", async () => {
    const control = new ControlPlane(vi.fn(), { timeoutMs: 10, baseDelayMs: 1 });
    const work = vi.fn(() => new Promise(() => {}));
    const rejected = expect(control.call("hung", work)).rejects.toBeInstanceOf(ControlPlaneUnavailable);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(work).toHaveBeenCalledTimes(3);
    const invalid = vi.fn(async () => { throw new Error("schema mismatch: token=secret"); });
    await expect(control.call("invalid", invalid)).rejects.toBeInstanceOf(OperatorActionRequired);
    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it("interrupts a retry backoff on stop", async () => {
    const stop = new AbortController();
    const work = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const pending = expect(new ControlPlane(vi.fn()).call("claim", work, stop.signal)).rejects.toThrow("stopped");
    await vi.advanceTimersByTimeAsync(1);
    stop.abort(); await pending;
    expect(work).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(pause(100, stop.signal)).rejects.toThrow("stopped");
  });

  it.each([401, 403, 429, 500, 502, 503, 504])("preserves HTTP %s from the real Convex client without exposing response bodies", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("sensitive body token=secret", { status })));
    const client = new ConvexHttpClient("https://test.convex.cloud", { fetch: workerFetch });
    const control = new ControlPlane(vi.fn(), { baseDelayMs: 1 });
    const pending = expect(control.call("query", () => client.query(api.tasks.queueStats, { runId: "test" }))).rejects.toBeInstanceOf(status < 408 ? OperatorActionRequired : ControlPlaneUnavailable);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(status < 408 ? 1 : 3);
  });

  it("keeps Convex function failures on the nontransient operator path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "error", errorMessage: "schema mismatch token=secret", logLines: [] }, { status: 560 })));
    const client = new ConvexHttpClient("https://test.convex.cloud", { fetch: workerFetch });
    await expect(new ControlPlane(vi.fn()).call("query", () => client.query(api.tasks.queueStats, { runId: "test" })))
      .rejects.toThrow("nontransient RPC failure");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{ attempts: Infinity }, { attempts: 11 }, { attempts: 1.5 }, { timeoutMs: 0 }, { maxDelayMs: NaN }])("rejects an unbounded or invalid retry policy: %j", (policy) => {
    expect(() => new ControlPlane(vi.fn(), policy)).toThrow();
  });
});

describe("CLI signal shutdown", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("stops claims on %s and forces exit at the grace deadline", (signal) => {
    const stop = vi.fn();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = installShutdown({ stop }, 30_000);
    try {
      process.emit(signal);
      expect(stop).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(29_999);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(signal === "SIGINT" ? 130 : 143);
    } finally { cleanup(); }
  });

  it("cancels the grace timer when work finishes", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = installShutdown({ stop: vi.fn() });
    process.emit("SIGTERM"); cleanup();
    vi.advanceTimersByTime(60_000);
    expect(exit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
