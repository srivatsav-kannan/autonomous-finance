// "Why?" answered from the record: decision commits in git memory and entries in the ledger,
// with citations. Shared by the human gateway (POST /runs/:id/why) and `npm run ask`.
// With a model it runs a cited-answer tool loop; without one it ranks decision commits by the
// question's keywords. The keyword path reads only git memory, so it needs no backend.
import { z } from "zod";
import { api, convex } from "../core/kernel-client";
import { llmAvailable, runTools, type ToolDef } from "../agents/llm";
import { MemoryStore, type CommitInfo } from "../memory/store";
import { memoryDir } from "../world/scenario";

export interface WhyAnswer {
  answer: string;
  cited?: string[];
  mode: "model" | "keyword";
}

const STOP = new Set(["the", "and", "for", "was", "were", "why", "who", "what", "which", "when", "how", "did", "does", "with", "from", "that", "this", "has", "have", "had", "are", "its", "our", "any", "about", "into", "then", "there", "they", "them", "you", "your", "happen", "happened"]);
// Decision subjects say HOLD/ACT/REJECT; questions say held/approved/blocked.
const SYNONYMS: Record<string, string[]> = { held: ["hold"], hold: ["held"], block: ["hold", "reject"], approv: ["act"], reject: ["block"], pay: ["payment"], payment: ["pay", "remit"] };

const stem = (t: string) => (t.length > 4 ? t.replace(/(ing|ed|es|s|e)$/, "") : t);
export function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)).map(stem))];
}
const commitTerms = (c: CommitInfo) => new Set(terms(`${c.subject} ${Object.values(c.trailers).join(" ")}`));

/**
 * Rank commits by the question's keywords, weighting rare words (an invoice number, a vendor)
 * above common ones ("bill"). Ties keep log order, newest first.
 */
export function rankCommits(log: CommitInfo[], question: string, limit = 6): CommitInfo[] {
  const docs = log.map((c) => ({ c, t: commitTerms(c) }));
  const df = (term: string) => docs.filter((d) => d.t.has(term)).length;
  const weights = terms(question).map((q) => {
    const forms = [q, ...(SYNONYMS[q] ?? [])];
    const n = Math.max(...forms.map(df));
    return { forms, w: n ? Math.log(1 + docs.length / n) : 0 };
  });
  return docs
    .map((d, i) => ({ c: d.c, i, score: weights.reduce((s, { forms, w }) => s + (forms.some((f) => d.t.has(f)) ? w : 0), 0) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.c);
}

const clip = (s: string, n = 320) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function why(runId: string, question: string, opts: { mem?: MemoryStore; model?: boolean } = {}): Promise<WhyAnswer> {
  const mem = opts.mem ?? new MemoryStore(memoryDir(runId));
  const log = await mem.log({ limit: 2000 });
  if (!(opts.model ?? llmAvailable())) {
    const hits = rankCommits(log, question);
    return {
      mode: "keyword",
      answer: hits.length ? hits.map((h) => `${h.author}: ${clip(h.subject)} (${h.sha.slice(0, 8)})`).join("\n") : "No matching decisions.",
      cited: hits.map((h) => h.sha),
    };
  }
  const tools: ToolDef[] = [
    {
      name: "search_decisions", description: "Search decision commits in company memory by keyword. Returns subject, author, sha.",
      schema: z.object({ query: z.string() }),
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      run: async (input) => {
        const q = (input as { query: string }).query;
        const exact = log.filter((c) => c.subject.toLowerCase().includes(q.toLowerCase()));
        const ranked = rankCommits(log, q, 15).filter((c) => !exact.includes(c));
        return [...exact, ...ranked].slice(0, 15).map((c) => ({ sha: c.sha, author: c.author, subject: c.subject, trailers: c.trailers }));
      },
    },
    {
      name: "read_memory", description: "Read a YAML record from company memory, e.g. decisions/2026-01/<id>.yaml or vendors/<id>.yaml.",
      schema: z.object({ path: z.string() }),
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      run: async (input) => (await mem.readText((input as { path: string }).path)) ?? "not found",
    },
    {
      name: "recent_entries", description: "Most recent ledger entries with their decision paths.",
      schema: z.object({ limit: z.number().int() }),
      inputSchema: { type: "object", properties: { limit: { type: "integer" } }, required: ["limit"], additionalProperties: false },
      // The ledger lives in the backend; git memory does not. Say so instead of failing the answer.
      run: async (input) => {
        try {
          return (await convex().query(api.ledger.entries, { runId, limit: Math.min(50, (input as { limit: number }).limit) }))
            .map((e) => ({ seq: e.sequence, memo: e.memo, total: e.totalCents, by: e.postedBy, decision: e.decisionPath }));
        } catch { return "ledger unavailable: the backend is not reachable; answer from memory only"; }
      },
    },
  ];
  const text = await runTools({
    system: "You answer a CFO's questions about what the company's finance agents did and why. Use only the tools; cite commit SHAs (first 8 chars) and decision paths. Be brief and specific. If the record doesn't say, say so.",
    user: question, tools, effort: "medium", maxTurns: 8,
  });
  return { mode: "model", answer: text };
}
