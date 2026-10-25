// Fetches the public Vals AI Finance Agent leaderboards and extracts the numbers
// the report compares against. The pages embed a hashed JSON data file
// (/_astro/benchmark_view_<slug>.<hash>.json); we follow that link from the HTML.
// Usage: npx tsx evals/external/vals-finance-agent/src/leaderboard.ts
import path from "node:path";
import { RUNS_DIR } from "./config";
import { writeJson } from "./store";

const PAGES = [
  { key: "v1.1", url: "https://www.vals.ai/benchmarks/finance_agent" },
  { key: "v2.1", url: "https://www.vals.ai/benchmarks/fabv2-1" },
  { key: "v2", url: "https://www.vals.ai/benchmarks/fabv2" },
  { key: "v1", url: "https://www.vals.ai/benchmarks/finance_agent_v1" },
];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

interface Entry {
  accuracy: number | null;
  stderr?: number | null;
  cost_per_test?: number | null;
  latency?: number | null;
  compute_effort?: string | null;
  max_output_tokens?: number | null;
}
interface View {
  metadata: { benchmark: string; version: string; updated: string; archived?: boolean; tasks: Record<string, string> };
  tasks: Record<string, Record<string, Entry>>;
}

export interface LeaderboardSnapshot {
  fetched_at: string;
  versions: {
    key: string;
    page_url: string;
    data_url: string;
    benchmark: string;
    version: string;
    updated: string;
    archived: boolean;
    headline: string | null;
    task_names: Record<string, string>;
    overall_top: { rank: number; model: string; accuracy: number; stderr: number | null; cost_per_test: number | null; latency_s: number | null; compute_effort: string | null }[];
    anthropic: Record<string, Record<string, number | null>>;
    anthropic_settings: Record<string, Entry>;
  }[];
}

function visibleText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

async function snapshot(): Promise<LeaderboardSnapshot> {
  const versions: LeaderboardSnapshot["versions"] = [];
  for (const p of PAGES) {
    const html = await (await fetch(p.url, { headers: { "User-Agent": UA } })).text();
    const rel = /\/_astro\/benchmark_view_[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.json/.exec(html)?.[0];
    if (!rel) throw new Error(`no data file link on ${p.url}`);
    const dataUrl = new URL(rel, p.url).toString();
    const view = (await (await fetch(dataUrl, { headers: { "User-Agent": UA } })).json()) as View;
    const text = visibleText(html);
    const headline = /As of [A-Z][a-z]+ \d{1,2}, \d{4},.{0,400}?%\)?\./.exec(text)?.[0] ?? null;
    const overall = view.tasks.overall ?? {};
    const ranked = Object.entries(overall)
      .filter(([, e]) => typeof e.accuracy === "number")
      .sort((a, b) => b[1].accuracy! - a[1].accuracy!);
    const anthropic: Record<string, Record<string, number | null>> = {};
    const settings: Record<string, Entry> = {};
    for (const [model, e] of Object.entries(overall)) {
      if (!model.startsWith("anthropic/")) continue;
      settings[model] = {
        accuracy: e.accuracy,
        stderr: e.stderr ?? null,
        cost_per_test: e.cost_per_test ?? null,
        latency: e.latency ?? null,
        compute_effort: e.compute_effort ?? null,
        max_output_tokens: e.max_output_tokens ?? null,
      };
      anthropic[model] = Object.fromEntries(
        Object.entries(view.tasks).map(([task, entries]) => [task, entries[model]?.accuracy ?? null]),
      );
    }
    versions.push({
      key: p.key,
      page_url: p.url,
      data_url: dataUrl,
      benchmark: view.metadata.benchmark,
      version: view.metadata.version,
      updated: view.metadata.updated,
      archived: !!view.metadata.archived,
      headline,
      task_names: view.metadata.tasks,
      overall_top: ranked.slice(0, 10).map(([model, e], i) => ({
        rank: i + 1,
        model,
        accuracy: e.accuracy!,
        stderr: e.stderr ?? null,
        cost_per_test: e.cost_per_test ?? null,
        latency_s: e.latency ?? null,
        compute_effort: e.compute_effort ?? null,
      })),
      anthropic,
      anthropic_settings: settings,
    });
  }
  return { fetched_at: new Date().toISOString(), versions };
}

export const LEADERBOARD_FILE = path.join(RUNS_DIR, "leaderboard.json");

if (import.meta.url === `file://${process.argv[1]}`) {
  const snap = await snapshot();
  writeJson(LEADERBOARD_FILE, snap);
  for (const v of snap.versions) {
    console.log(`${v.key} ${v.benchmark} updated ${v.updated}${v.archived ? " (archived)" : ""}: ${v.headline ?? ""}`);
    console.log(`   top: ${v.overall_top.slice(0, 3).map((t) => `${t.model} ${t.accuracy.toFixed(2)}%`).join(", ")}`);
    const o55 = v.anthropic_settings["anthropic/claude-opus-5-5"];
    if (o55) console.log(`   claude-opus-5-5: ${o55.accuracy}% (stderr ${o55.stderr}, $${o55.cost_per_test}/test, effort ${o55.compute_effort})`);
  }
  console.log(`wrote ${LEADERBOARD_FILE}`);
}
