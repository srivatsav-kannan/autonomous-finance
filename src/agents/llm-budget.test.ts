import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The Anthropic path of src/agents/llm.ts must go through the same local spend cap as OpenAI.
// Mock transport only: nothing here reaches a provider.

let dir: string;
let spendFile: string;
const fetcher = vi.fn<typeof fetch>();
const message = (content: unknown[], stop = "end_turn") => new Response(JSON.stringify({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}), { status: 200, headers: { "Content-Type": "application/json" } });

async function load(maxUsd = "15") {
  vi.stubEnv("AGENT_PROVIDER", "anthropic");
  vi.stubEnv("AGENT_MODEL", "claude-opus-5-5");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-only-never-sent");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("AGENT_LLM", "on");
  vi.stubEnv("AGENT_MAX_USD", maxUsd);
  vi.stubEnv("AGENT_SPEND_FILE", spendFile);
  vi.resetModules();
  return await import("./llm");
}
const spent = () => (JSON.parse(fs.readFileSync(spendFile, "utf8")) as { spentMicros: number }).spentMicros;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-spend-"));
  spendFile = path.join(dir, "agent-spend.json");
  fetcher.mockReset();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Anthropic agent calls are capped by AGENT_MAX_USD", () => {
  it("records extract spend in the shared spend file at Anthropic prices", async () => {
    const llm = await load();
    fetcher.mockResolvedValueOnce(message([{ type: "text", text: JSON.stringify({ value: 7 }) }]));
    const usage = llm.emptyUsage();
    expect(await llm.extract({ system: "s", input: "i", schema: z.object({ value: z.number() }), usage })).toEqual({ value: 7 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain("https://api.anthropic.com");
    const expected = 1000 * llm.ANTHROPIC_PRICES.input + 100 * llm.ANTHROPIC_PRICES.output;
    expect(spent()).toBe(expected);
    expect(usage.costMicros).toBe(expected);
  });

  it("records runTools spend too", async () => {
    const llm = await load();
    fetcher.mockResolvedValueOnce(message([{ type: "text", text: "done" }]));
    expect(await llm.runTools({ system: "s", user: "u", tools: [] })).toBe("done");
    expect(spent()).toBeGreaterThan(0);
  });

  it("refuses an extract before dispatch once the cap would be exceeded", async () => {
    fs.writeFileSync(spendFile, JSON.stringify({ spentMicros: 999_000 }));
    const llm = await load("1");
    await expect(llm.extract({ system: "s", input: "i", schema: z.object({ value: z.number() }) })).rejects.toBeInstanceOf(llm.LlmUnavailable);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a tool loop before dispatch once the cap would be exceeded", async () => {
    fs.writeFileSync(spendFile, JSON.stringify({ spentMicros: 999_000 }));
    const llm = await load("1");
    await expect(llm.runTools({ system: "s", user: "u", tools: [] })).rejects.toThrow(/spend cap/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not retry a failed request (a retry would be unbudgeted)", async () => {
    const llm = await load();
    fetcher.mockResolvedValue(new Response("{}", { status: 529 }));
    await expect(llm.extract({ system: "s", input: "i", schema: z.object({ value: z.number() }) })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(spent()).toBeGreaterThan(0); // the reservation is retained when billing can't be verified
  });
});
