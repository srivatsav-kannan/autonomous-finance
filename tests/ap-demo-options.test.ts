import { describe, expect, it } from "vitest";
import { LEASE_MS } from "../convex/lib/payments/applyEffect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DISPATCH_LEASE_MS, MIN_LEASE_WAIT_MS, parseDemoArgs, resolveAdminSecret } from "../scripts/ap-demo-options";

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

describe("demo:local admin secret", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ap-demo-secret-"));

  it("reuses the KERNEL_ADMIN_SECRET loaded from .env.local instead of replacing the deployment's", () => {
    const file = path.join(tmp(), ".env.local");
    fs.writeFileSync(file, "CONVEX_URL=http://127.0.0.1:3210\nKERNEL_ADMIN_SECRET=kept-secret-value\n");
    const env: Record<string, string | undefined> = { KERNEL_ADMIN_SECRET: "kept-secret-value" };
    expect(resolveAdminSecret(env, file)).toEqual({ secret: "kept-secret-value", source: "env" });
    expect(fs.readFileSync(file, "utf8")).toBe("CONVEX_URL=http://127.0.0.1:3210\nKERNEL_ADMIN_SECRET=kept-secret-value\n");
  });

  it("generates a secret for a missing or placeholder value and saves it so other runners agree", () => {
    for (const line of ["KERNEL_ADMIN_SECRET=change-me\n", "KERNEL_ADMIN_SECRET=\n", ""]) {
      const file = path.join(tmp(), ".env.local");
      fs.writeFileSync(file, `CONVEX_URL=http://127.0.0.1:3210\n${line}VITE_GATEWAY_TOKEN=abc\n`);
      const env: Record<string, string | undefined> = { KERNEL_ADMIN_SECRET: line ? line.split("=")[1]!.trim() : undefined };
      const resolved = resolveAdminSecret(env, file);
      expect(resolved.source).toBe("generated_saved");
      expect(resolved.secret).toMatch(/^[a-f0-9]{64}$/);
      expect(env.KERNEL_ADMIN_SECRET).toBe(resolved.secret);
      const saved = fs.readFileSync(file, "utf8");
      expect(saved).toContain(`KERNEL_ADMIN_SECRET=${resolved.secret}\n`);
      expect(saved).toContain("CONVEX_URL=http://127.0.0.1:3210\n");
      expect(saved).toContain("VITE_GATEWAY_TOKEN=abc\n");
      expect(saved.match(/KERNEL_ADMIN_SECRET=/g)).toHaveLength(1);
    }
  });

  it("uses a one-off secret without creating .env.local in an isolated checkout (CI)", () => {
    const file = path.join(tmp(), ".env.local");
    expect(resolveAdminSecret({}, file).source).toBe("generated_unsaved");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("is wired into the demo after .env.local is loaded", () => {
    const source = fs.readFileSync("scripts/ap-demo.ts", "utf8");
    expect(source).toContain('import "../src/core/env";');
    expect(source).toContain("resolveAdminSecret(process.env)");
    expect(source).not.toMatch(/KERNEL_ADMIN_SECRET \?\? random\(\)/);
  });
});
