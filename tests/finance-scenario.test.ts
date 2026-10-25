import { describe, expect, it } from "vitest";
import { chooseFinanceScenario } from "../console/src/financeScenario";

describe("finance scenario navigation", () => {
  const recent = [{ runId: "memory-review-latest" }, { runId: "finance-workbench" }];
  it("opens the finance demo instead of a newer empty diagnostic run", () => {
    expect(chooseFinanceScenario(recent, "")).toBe("finance-workbench");
  });
  it("preserves explicit links even outside the recent-run window", () => {
    expect(chooseFinanceScenario(recent, "older-run", "finance-workbench")).toBe("older-run");
  });
  it("restores a chosen available scenario, but ignores a stale preference", () => {
    expect(chooseFinanceScenario(recent, "", "memory-review-latest")).toBe("memory-review-latest");
    expect(chooseFinanceScenario(recent, "", "deleted-run")).toBe("finance-workbench");
  });
  it("handles installations without a finance demo or any runs", () => {
    expect(chooseFinanceScenario([{ runId: "customer-demo" }], "")).toBe("customer-demo");
    expect(chooseFinanceScenario([], "")).toBe("");
  });
});
