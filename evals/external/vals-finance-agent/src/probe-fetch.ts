// Probe: can web_fetch read a large 10-K whose URL came from a client tool result / user message?
// Usage: npx tsx evals/external/vals-finance-agent/src/probe-fetch.ts <url> [user|tool]
import { getClient } from "./env";
import { FALLBACK_BETA, MODEL } from "./config";
import { costOfUsage } from "./pricing";
import { appendLedger } from "./store";

const url = process.argv[2] ?? "https://www.sec.gov/Archives/edgar/data/1163302/000116330225000018/x-20241231.htm";
const via = process.argv[3] ?? "tool";
const client = getClient();
const messages: any[] =
  via === "user"
    ? [{ role: "user", content: `Fetch ${url} with web_fetch and report the first heading and the document length in characters. One line.` }]
    : [
        { role: "user", content: "Look up the U.S. Steel FY2024 10-K with edgar_search, then fetch its filingUrl with web_fetch and report the first heading and the document length in characters. One line." },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_probe1", name: "edgar_search", input: { search_query: "United States Steel 10-K 2024" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_probe1", content: JSON.stringify([{ formType: "10-K", filedAt: "2025-01-31", filingUrl: url }]) }] },
      ];
const stream = client.beta.messages.stream({
  model: MODEL,
  max_tokens: 8000,
  betas: [FALLBACK_BETA],
  fallbacks: "default",
  thinking: { type: "adaptive" },
  output_config: { effort: "low" },
  tools: [
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 2, ...(process.env.MCT ? { max_content_tokens: Number(process.env.MCT) } : {}) },
    { name: "edgar_search", description: "Search EDGAR", input_schema: { type: "object", properties: { search_query: { type: "string" } }, required: ["search_query"] } },
  ],
  messages,
});
const msg = await stream.finalMessage();
for (const b of msg.content) {
  if (b.type === "server_tool_use") console.log("call", b.name, JSON.stringify(b.input).slice(0, 160), JSON.stringify(b.caller ?? null));
  else if (b.type === "web_fetch_tool_result") {
    const c = b.content as any;
    console.log(c.type === "web_fetch_tool_result_error" ? `ERROR ${c.error_code}` : `ok ${c.url} chars=${c.content?.source?.data?.length}`);
  } else if (b.type === "text") console.log("text:", b.text.slice(0, 200));
}
const cost = costOfUsage(msg.usage).total;
appendLedger({ phase: "probe", run_id: "probe", id: "probe-fetch", usd: cost, note: `${via} ${url}` });
console.log(msg.stop_reason, cost.toFixed(4), JSON.stringify({ in: msg.usage.input_tokens, cr: msg.usage.cache_read_input_tokens, cw: msg.usage.cache_creation_input_tokens, out: msg.usage.output_tokens, it: msg.usage.iterations }));
