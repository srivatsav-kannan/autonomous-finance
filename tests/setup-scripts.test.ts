// npm run setup / backend:configure / evals: the pure rules they rely on.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeExample, isPlaceholderSecret, parseEnv, upsertEnv } from "../scripts/lib/env-file";
import { approvedPolicy, externalMaxRequests, formatTable, paidTotal, parseEvalArgs, requestCeilingUsd, splitBudget } from "../scripts/lib/evals-plan";
import { loadModelPolicy } from "../src/evals/external/models";

describe(".env.local handling", () => {
  const existing = "# mine\nCONVEX_URL=http://127.0.0.1:3410\nKERNEL_ADMIN_SECRET=keep-me\nOPENAI_API_KEY=\nCONVEX_DEPLOYMENT=anonymous:anonymous-agent\n";

  it("adds only the settings .env.example has and .env.local lacks, keeping every value", () => {
    const example = fs.readFileSync(".env.example", "utf8");
    const { text, added } = mergeExample(existing, example);
    expect(text.startsWith(existing)).toBe(true);
    const env = parseEnv(text);
    expect(env.get("CONVEX_URL")).toBe("http://127.0.0.1:3410");
    expect(env.get("KERNEL_ADMIN_SECRET")).toBe("keep-me");
    expect(added).toContain("VITE_CONVEX_URL");
    expect(added).not.toContain("CONVEX_URL");
    expect(added).not.toContain("OPENAI_API_KEY");
    // Rerunning is a no-op.
    expect(mergeExample(text, example)).toEqual({ text, added: [] });
  });

  it("fills empty values in place and overwrites a set value only when told to", () => {
    expect(upsertEnv(existing, { OPENAI_API_KEY: "x", KERNEL_ADMIN_SECRET: "new" })).toEqual({ text: existing.replace("OPENAI_API_KEY=", "OPENAI_API_KEY=x"), changed: ["OPENAI_API_KEY"] });
    expect(upsertEnv(existing, { KERNEL_ADMIN_SECRET: "new" }, ["KERNEL_ADMIN_SECRET"]).text).toContain("KERNEL_ADMIN_SECRET=new\n");
    expect(upsertEnv("", { A: "1" }).text).toBe("A=1\n");
  });

  it("treats a missing, empty or documented placeholder admin secret as unset", () => {
    for (const v of [undefined, "", "  ", "change-me"]) expect(isPlaceholderSecret(v)).toBe(true);
    expect(isPlaceholderSecret("3f9a")).toBe(false);
  });
});

describe("npm run evals options", () => {
  it("runs free by default and refuses paid runs without a budget", () => {
    expect(parseEvalArgs([])).toEqual({ paid: false });
    expect(parseEvalArgs(["--paid", "--budget-usd", "15"])).toEqual({ paid: true, budgetUsd: 15 });
    expect(parseEvalArgs(["--paid", "--budget-usd=7.5"])).toEqual({ paid: true, budgetUsd: 7.5 });
    expect(() => parseEvalArgs(["--paid"])).toThrow(/needs --budget-usd/);
    expect(() => parseEvalArgs(["--budget-usd", "5"])).toThrow(/only with --paid/);
    for (const bad of ["0", "-1", "abc", "1000"]) expect(() => parseEvalArgs(["--paid", "--budget-usd", bad])).toThrow(/--budget-usd must be/);
    expect(() => parseEvalArgs(["--pay"])).toThrow(/Unknown option/);
  });

  it("never allots more than the budget across the paid runs", () => {
    for (const budget of [1, 7.33, 15, 99.99, 500]) {
      const shares = splitBudget(budget);
      expect(paidTotal(shares)).toBeLessThanOrEqual(budget);
      expect(shares.external).toBeGreaterThan(shares.sheetsAgent);
    }
    expect(splitBudget(20)).toEqual({ worldPerSeed: 0.5, sheetsAgent: 3, external: 15 });
  });

  it("writes a one-time policy the benchmark accepts, capped at the external share", () => {
    const base = loadModelPolicy();
    expect(base.approval).toBeNull(); // the checked-in policy stays disabled
    const policy = approvedPolicy(base, 11.25, "test", new Date("2026-10-25T00:00:00Z"));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "evals-policy-")), "policy.json");
    fs.writeFileSync(file, JSON.stringify(policy));
    expect(loadModelPolicy(file).approval).toEqual({ approvedBy: "test", approvedAt: "2026-10-25T00:00:00.000Z", maxCostUsd: 11.25, maxRequests: externalMaxRequests(), maxTurnsPerCase: 30 });
    expect(policy.agent).toEqual(base.agent);
    expect(() => approvedPolicy(policy, 1, "again")).toThrow(/unapproved/);
    expect(externalMaxRequests()).toBe(15 * 2 * 30 + 6);
    expect(requestCeilingUsd(base.agent)).toBeCloseTo(0.29096, 5);
  });

  it("prints one row per eval", () => {
    expect(formatTable([{ name: "Control tests", status: "pass", result: "20/20 | held", seconds: 1.4 }])).toBe(
      "| Eval | Status | Result | Time | Cost |\n|---|---|---|---:|---:|\n| Control tests | pass | 20/20 \\| held | 1 s | $0 |");
  });
});
