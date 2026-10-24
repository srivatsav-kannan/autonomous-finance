// As-of audit: the benchmark asks for answers "as of April 07, 2025" and the
// official tools cap search dates there, but Anthropic's web_search has no date
// filter. This finds SEC filings filed after the cap that each answer cited or
// that the agent fetched, using EDGAR filing index pages for the filing date.
// Usage: npx tsx evals/external/vals-finance-agent/src/asof-audit.ts --runs main[,rep2]
import path from "node:path";
import { parseArgs } from "./args";
import { MAX_END_DATE } from "./config";
import { secGet } from "./edgar";
import { readJson, readRecords, runDir, transcriptPath, writeJson } from "./store";

const SEC_DOC = /https?:\/\/(?:www\.)?sec\.gov\/Archives\/edgar\/data\/(\d+)\/(\d{18})\b/g;

const dateCache = new Map<string, Promise<string | null>>();

function filingDate(cik: string, accNoDashes: string): Promise<string | null> {
  const key = accNoDashes;
  let p = dateCache.get(key);
  if (!p) {
    const acc = `${accNoDashes.slice(0, 10)}-${accNoDashes.slice(10, 12)}-${accNoDashes.slice(12)}`;
    p = (async () => {
      const res = await secGet(`https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}/${acc}-index.htm`, "text/html");
      if (!res.ok) return null;
      const html = await res.text();
      return /Filing Date<\/div>\s*<div class="info">(\d{4}-\d{2}-\d{2})/.exec(html)?.[1] ?? null;
    })();
    dateCache.set(key, p);
  }
  return p;
}

function accessions(text: string): { cik: string; acc: string }[] {
  const out = new Map<string, { cik: string; acc: string }>();
  for (const m of text.matchAll(SEC_DOC)) out.set(m[2]!, { cik: m[1]!, acc: m[2]! });
  return [...out.values()];
}

export interface AsOfAuditRow {
  id: string;
  cited_after_cap: { accession: string; filed: string }[];
  fetched_after_cap: { accession: string; filed: string }[];
  cited_unknown: number;
}

async function audit(runId: string): Promise<AsOfAuditRow[]> {
  const rows: AsOfAuditRow[] = [];
  for (const r of readRecords(runId)) {
    const t = readJson<{ messages: { role: string; content: unknown }[] }>(transcriptPath(runId, r.id));
    // URLs the agent asked web_fetch for (direct or from code) in its own turns.
    const fetchedText = (t?.messages ?? [])
      .filter((m) => m.role === "assistant" && Array.isArray(m.content))
      .flatMap((m) => m.content as { type: string; name?: string; input?: unknown }[])
      .filter((b) => b.type === "server_tool_use" && b.name === "web_fetch")
      .map((b) => JSON.stringify(b.input))
      .join("\n");
    const check = async (list: { cik: string; acc: string }[]) => {
      const after: { accession: string; filed: string }[] = [];
      let unknown = 0;
      for (const a of list) {
        const d = await filingDate(a.cik, a.acc);
        if (!d) unknown++;
        else if (d > MAX_END_DATE) after.push({ accession: a.acc, filed: d });
      }
      return { after, unknown };
    };
    const cited = await check(accessions(r.final_answer));
    const fetched = await check(accessions(fetchedText));
    rows.push({ id: r.id, cited_after_cap: cited.after, fetched_after_cap: fetched.after, cited_unknown: cited.unknown });
  }
  return rows;
}

const args = parseArgs(process.argv.slice(2));
const runIds = (typeof args.runs === "string" ? args.runs : "main").split(",");
for (const runId of runIds) {
  const rows = await audit(runId);
  writeJson(path.join(runDir(runId), "asof-audit.json"), { as_of_cap: MAX_END_DATE, generated_at: new Date().toISOString(), rows });
  const cited = rows.filter((r) => r.cited_after_cap.length).length;
  const fetched = rows.filter((r) => r.fetched_after_cap.length).length;
  console.log(`${runId}: ${rows.length} answers; ${cited} cite an SEC filing filed after ${MAX_END_DATE}; ${fetched} fetched one`);
}
