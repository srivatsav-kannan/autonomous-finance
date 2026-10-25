import { describe, expect, it } from "vitest";
import { LEASE_MS } from "../convex/lib/payments/applyEffect";
import { DISPATCH_LEASE_MS, MIN_LEASE_WAIT_MS, parseDemoArgs } from "../scripts/ap-demo-options";

describe("demo:local options", () => {
  it("keeps the default run unchanged: local, simulated approval, 31 s lease wait", () => {
    expect(parseDemoArgs([])).toEqual({ profile: "local", browserApproval: false, leaseWaitMs: 31_000 });
    expect(parseDemoArgs(["local"])).toEqual({ profile: "local", browserApproval: false, leaseWaitMs: 31_000 });
    expect(parseDemoArgs(["sandbox"])).toEqual({ profile: "sandbox", browserApproval: false, leaseWaitMs: 31_000 });
  });

  it("tracks the dispatcher lease the backend actually enforces", () => {
    expect(DISPATCH_LEASE_MS).toBe(LEASE_MS);
    expect(MIN_LEASE_WAIT_MS).toBeGreaterThan(LEASE_MS);
  });

  it("accepts browser approval and a longer lease wait", () => {
    expect(parseDemoArgs(["local", "--browser-approval"])).toMatchObject({ browserApproval: true, leaseWaitMs: 31_000 });
    expect(parseDemoArgs(["local", "--browser-approval", "--lease-wait-seconds", "45"])).toMatchObject({ browserApproval: true, leaseWaitMs: 45_000 });
    expect(parseDemoArgs(["local", "--lease-wait-seconds=60"])).toMatchObject({ leaseWaitMs: 60_000 });
  });

  it("refuses a wait shorter than the lease, malformed values and unknown flags", () => {
    for (const args of [["local", "--lease-wait-seconds", "10"], ["local", "--lease-wait-seconds", "30"], ["local", "--lease-wait-seconds", "31.5"],
      ["local", "--lease-wait-seconds"], ["local", "--lease-wait-seconds", "601"], ["local", "--lease-wait-seconds=abc"]]) {
      expect(() => parseDemoArgs(args)).toThrow(/--lease-wait-seconds must be/);
    }
    expect(() => parseDemoArgs(["local", "--browser"])).toThrow(/Unknown option --browser/);
    expect(() => parseDemoArgs(["staging"])).toThrow(/Usage/);
  });

  it("keeps browser approval and lease waits out of the sandbox profile", () => {
    expect(() => parseDemoArgs(["sandbox", "--browser-approval"])).toThrow(/local crash-recovery demo only/);
    expect(() => parseDemoArgs(["sandbox", "--lease-wait-seconds", "40"])).toThrow(/local crash-recovery demo only/);
  });
});
