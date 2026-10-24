import { gateway } from "./gateway";

// Agent-native by default: the console exposes its actions as WebMCP tools, so a human's own
// browser agent can operate it (list what needs a decision, answer it, ask why) without screen-scraping.
// Uses the W3C/Chrome document.modelContext API when present (Chrome 149+ origin trial or flag).

interface ModelContext {
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (input: Record<string, unknown>) => Promise<unknown>;
  }, opts?: { signal?: AbortSignal }): Promise<void> | void;
}

export function registerWebMcpTools(runId: string): () => void {
  const mc = (document as unknown as { modelContext?: ModelContext }).modelContext;
  if (!mc) return () => {};
  const lifetime = new AbortController();
  const tools = [
    {
      name: "list_open_decisions",
      description: "List decisions the finance agents are waiting on the human CFO for.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        const res = await fetch(`${import.meta.env.VITE_CONVEX_URL}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "asks:list", args: { runId, status: "open", to: "human_cfo" }, format: "json" }),
        });
        const data = await res.json();
        return (data.value ?? []).map((a: { _id: string; title: string; severity: string; options: { id: string; label: string }[] }) => ({ id: a._id, title: a.title, severity: a.severity, options: a.options }));
      },
    },
    {
      name: "answer_decision",
      description: "Answer one of the agents' open decisions as the human CFO. Payment approvals and period close co-signs take effect immediately.",
      inputSchema: { type: "object", properties: { askId: { type: "string" }, optionId: { type: "string" }, note: { type: "string" } }, required: ["askId", "optionId"], additionalProperties: false },
      execute: async (input: Record<string, unknown>) => gateway(runId, `asks/${input.askId}/answer`, { method: "POST", body: { optionId: input.optionId, note: input.note } }),
    },
    {
      name: "ask_why",
      description: "Ask why the finance agents did something. The answer cites decision records and ledger entries.",
      inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
      execute: async (input: Record<string, unknown>) => gateway(runId, "why", { method: "POST", body: { question: input.question } }),
    },
  ];
  for (const t of tools) {
    try {
      void mc.registerTool(t, { signal: lifetime.signal });
    } catch {
      // Registration can fail on older builds; the console still works for humans.
    }
  }
  return () => lifetime.abort();
}
