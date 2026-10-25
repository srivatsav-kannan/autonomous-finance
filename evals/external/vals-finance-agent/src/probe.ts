// Capability probe: checks that the request shape the harness uses is accepted
// (fallbacks "default", adaptive thinking, effort, auto caching) and whether the
// server-side web_fetch tool can read SEC EDGAR documents. Spends a few cents.
// Usage: npx tsx evals/external/vals-finance-agent/src/probe.ts
import { getClient } from "./env";
import { FALLBACK_BETA, MODEL } from "./config";
import { costOfUsage } from "./pricing";
import { appendLedger } from "./store";

const client = getClient();

async function basic() {
  const msg = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    cache_control: { type: "ephemeral" },
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });
  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const cost = costOfUsage(msg.usage).total;
  appendLedger({ phase: "probe", run_id: "probe", id: "basic", usd: cost });
  console.log("[basic]", msg.model, msg.stop_reason, JSON.stringify(text), cost.toFixed(4));
}

async function fetchSec() {
  const url = "https://www.sec.gov/Archives/edgar/data/1065280/000106528025000044/nflx-20241231.htm";
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    tools: [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 2, max_content_tokens: 6000 }],
    messages: [
      {
        role: "user",
        content: `Use web_fetch on ${url} and tell me the exact title line of the document (first heading). One line only.`,
      },
    ],
  });
  const msg = await stream.finalMessage();
  for (const b of msg.content) {
    if (b.type === "server_tool_use") console.log("[fetch] call", b.name, JSON.stringify(b.input).slice(0, 200));
    else if (b.type === "web_fetch_tool_result") {
      const c = b.content as unknown as Record<string, unknown>;
      if (c.type === "web_fetch_tool_result_error") console.log("[fetch] ERROR", c.error_code);
      else {
        const doc = (c as { content?: { source?: { data?: string; type?: string } } }).content;
        console.log("[fetch] ok", c.url, "chars:", doc?.source?.data?.length, doc?.source?.type);
      }
    } else if (b.type === "text") console.log("[fetch] text:", b.text.slice(0, 300));
    else console.log("[fetch] block", b.type);
  }
  const cost = costOfUsage(msg.usage).total;
  appendLedger({ phase: "probe", run_id: "probe", id: "fetch-sec", usd: cost });
  console.log("[fetch]", msg.stop_reason, JSON.stringify(msg.usage.server_tool_use), cost.toFixed(4));
}

await basic();
await fetchSec();
