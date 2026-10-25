import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import { AskEffectSummary } from "../console/src/AskEffect";
import { registerWebMcpTools } from "../console/src/webmcp";

afterEach(() => { vi.unstubAllGlobals(); });

describe("console WebMCP surface (P1-2)", () => {
  it("registers only read-only tools: a browser agent cannot answer as the human CFO", async () => {
    const tools: { name: string; description: string; execute: (input: Record<string, unknown>) => Promise<unknown> }[] = [];
    vi.stubGlobal("document", { modelContext: { registerTool: (t: (typeof tools)[number]) => { tools.push(t); } } });
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const stop = registerWebMcpTools("run-1");
    expect(tools.map((t) => t.name)).not.toContain("answer_decision");
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.description).not.toMatch(/as the human|take effect/i);
    await tools.find((t) => t.name === "list_open_decisions")!.execute({});
    expect(calls.every((c) => !/\/answer\b/.test(c.url))).toBe(true);
    stop();
  });
});

describe("review drawer effect summary (P1-1)", () => {
  it("describes a payment from the kernel's effect, not the agent's labels", () => {
    const html = renderToStaticMarkup(<AskEffectSummary effect={{ kind: "payment", paymentIntentId: "intent-1" as Id<"paymentIntents">, payee: "bay-farms", amountCents: 486_250, method: "ach", dueDate: "2026-01-30", remitTo: { bank: "First Coastal Bank", accountLast4: "0998" } }} />);
    expect(html).toContain("bay-farms");
    expect(html).toContain("$4,862.50");
    expect(html).toContain("First Coastal Bank ****0998");
  });

  it("describes a merge by branch and paths, and a close by period", () => {
    const merge = renderToStaticMarkup(<AskEffectSummary effect={{ kind: "merge", proposalBranch: "proposal/remit-v1", proposalId: "remit-v1", headSha: "aaa", paths: ["vendors/v1.yaml", "policies/payments.yaml"] }} />);
    expect(merge).toContain("proposal/remit-v1");
    expect(merge).toContain("vendors/v1.yaml");
    expect(merge).toContain("policies/payments.yaml");
    expect(renderToStaticMarkup(<AskEffectSummary effect={{ kind: "close", period: "2026-01" }} />)).toContain("2026-01");
  });

  it("says plainly when an answer has no effect", () => {
    expect(renderToStaticMarkup(<AskEffectSummary />)).toMatch(/only records your response/i);
  });
});
