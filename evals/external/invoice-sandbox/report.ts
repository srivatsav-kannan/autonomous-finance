// Collects every run (original fixture + fresh-seed copies) into docs/evals/invoice-sandbox.json and
// prints the markdown tables used in docs/evals/invoice-sandbox.md.
//   npx tsx evals/external/invoice-sandbox/report.ts [extra bench dirs...]
import fs from "node:fs";
import path from "node:path";
import { BENCH_DIR, HARD_CAP_USD, LEDGER_PATH, REPO_ROOT } from "./lib/config";
import { readLedger } from "./lib/llm";

const benchDirs = [BENCH_DIR, ...process.argv.slice(2).map((p) => path.resolve(p))];
for (const d of fs.readdirSync(path.dirname(BENCH_DIR))) {
  const p = path.join(path.dirname(BENCH_DIR), d);
  if (/^invoice-sandbox-seed\d+$/.test(d) && !benchDirs.includes(p)) benchDirs.push(p);
}

const readJson = (p: string) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
const ledger = readLedger();

interface Row {
  fixture: string;
  seed: number;
  run_id: string;
  system: "A" | "B" | "C";
  kind: "scored" | "pilot" | "partial";
  status: string;
  customers_exact: number | null;
  customers: number;
  all_four_exact: number | null;
  count_exact: number | null;
  gross_exact: number | null;
  credit_exact: number | null;
  net_abs_error_usd: number | null;
  trap_entries_ok: number | null;
  trap_entries: number | null;
  trap_docs_ok: number | null;
  trap_docs: number | null;
  false_exclusions: number | null;
  flagged_valid_invoices: number | null;
  suspicious_entries: number | null;
  cost_usd: number; // ledger total for this run id (all invocations)
  wall_s: number | null; // null for partial runs assembled offline
  api_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  fallback_calls: number;
  detail: Record<string, unknown>;
}

const rows: Row[] = [];
for (const bench of benchDirs) {
  const manifest = readJson(path.join(bench, "answer_key/manifest.json"));
  const seed = manifest?.seed as number;
  const fixture = seed === 487291 ? "original (committed seed 487291)" : `fresh (seed ${seed})`;
  const runsDir = path.join(bench, "runs");
  if (!fs.existsSync(runsDir)) continue;
  for (const id of fs.readdirSync(runsDir).sort()) {
    const out = path.join(runsDir, id, "out");
    const meta = readJson(path.join(out, "run_meta.json"));
    const score = readJson(path.join(out, "score.json"));
    if (!meta || !score || meta.result?.status === undefined || meta.limit_docs) continue; // skip partial pilots
    const calls = ledger.filter((e) => e.run_id === id); // run ids are unique across fixtures (fresh-seed runs use an -f suffix)
    const r = meta.result;
    rows.push({
      fixture,
      seed,
      run_id: id,
      system: meta.system,
      kind: id.includes("pilot") ? "pilot" : meta.offline ? "partial" : "scored",
      status: r.status,
      customers_exact: score.official?.customers_exact ?? null,
      customers: score.official?.customers_scored ?? 18,
      all_four_exact: score.fields?.all_four_exact ?? null,
      count_exact: score.fields?.valid_invoice_count_exact ?? null,
      gross_exact: score.fields?.gross_invoice_spend_usd_exact ?? null,
      credit_exact: score.fields?.credit_memo_total_usd_exact ?? null,
      net_abs_error_usd: score.official?.total_absolute_error_usd ?? null,
      trap_entries_ok: score.traps?.trap_entries_ok ?? null,
      trap_entries: score.traps?.trap_entries ?? null,
      trap_docs_ok: score.traps?.trap_documents_ok ?? null,
      trap_docs: score.traps?.trap_documents ?? null,
      false_exclusions: score.false_exclusions?.count ?? null,
      flagged_valid_invoices: score.flagged_but_counted_valid_invoices?.length ?? null,
      suspicious_entries: score.suspicious_entries ?? null,
      cost_usd: calls.reduce((s, e) => s + e.cost_usd, 0),
      wall_s: meta.offline ? null : meta.wall_ms / 1000,
      api_calls: calls.length,
      input_tokens: calls.reduce((s, e) => s + e.input_tokens, 0),
      output_tokens: calls.reduce((s, e) => s + e.output_tokens, 0),
      cache_read_tokens: calls.reduce((s, e) => s + e.cache_read_input_tokens, 0),
      cache_write_tokens: calls.reduce((s, e) => s + e.cache_creation_input_tokens, 0),
      fallback_calls: calls.filter((e) => e.fallback_used).length,
      detail: {
        result: r,
        effort: meta.effort ?? { extract: meta.extract_effort, adjudicate: meta.adjudicate_effort },
        sample: meta.sample ?? null,
        mismatches: (score.per_customer ?? []).filter((c: Record<string, { ok: boolean }>) => Object.values(c).some((v) => typeof v === "object" && v && v.ok === false)),
        trap_detail: score.traps?.detail ?? null,
        false_exclusion_docs: score.false_exclusions?.documents ?? [],
      },
    });
  }
}

const stats = (xs: number[]) =>
  xs.length ? { n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) } : null;
const groups = new Map<string, Row[]>();
for (const r of rows.filter((r) => r.kind === "scored")) {
  const k = `${r.fixture} | ${r.system}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
const summary = [...groups].map(([k, rs]) => ({
  group: k,
  runs: rs.map((r) => r.run_id),
  customers_exact: stats(rs.map((r) => r.customers_exact ?? 0)),
  all_four_exact: stats(rs.map((r) => r.all_four_exact ?? 0)),
  trap_docs_ok: stats(rs.map((r) => r.trap_docs_ok ?? 0)),
  trap_entries_ok: stats(rs.map((r) => r.trap_entries_ok ?? 0)),
  false_exclusions: stats(rs.map((r) => r.false_exclusions ?? 0)),
  net_abs_error_usd: stats(rs.map((r) => r.net_abs_error_usd ?? 0)),
  cost_usd: stats(rs.map((r) => r.cost_usd)),
  wall_s: stats(rs.flatMap((r) => (r.wall_s === null ? [] : [r.wall_s]))),
}));

const totalSpent = ledger.reduce((s, e) => s + e.cost_usd, 0);
const byRun = Object.fromEntries(
  [...new Set(ledger.map((e) => e.run_id))].map((id) => [id, Number(ledger.filter((e) => e.run_id === id).reduce((s, e) => s + e.cost_usd, 0).toFixed(4))]),
);
// Facts checked by hand during setup (see docs/evals/invoice-sandbox.md for the narrative).
const CONTEXT = {
  fixture_determinism: {
    regenerated_with: "Python 3.12.10, reportlab 5.1.0, pillow 13.0.0 (uv venv), scripts/generate_fixture.py --clean",
    answer_key: "invoices.csv and customer_totals.csv byte-identical to the committed files; traps.json identical apart from CRLF line endings; manifest.json differs only in generated_at_utc and line endings",
    pdfs: "all 112 PDFs: pypdf-extracted text identical to the committed PDFs (bytes differ only by embedded timestamps)",
    other_files: "35 non-PDF files identical apart from CRLF line endings; support_inbox.mbox identical apart from its From_ timestamp lines",
  },
  fresh_fixture: {
    seed: 20261024,
    change: "patches/seed-override.patch: SEED = int(os.environ.get('INVOICE_SANDBOX_SEED', '487291')) plus `import os`; with the variable unset the patched generator reproduces the committed answer key exactly",
    same_structure: "112 PDFs, 105 valid invoices, 2 credit memos, 5 excluded PDFs, 18 customers, same trap file names",
    differs: "0/18 customer net totals equal to the original; 2/112 invoice totals equal; duplicate scan belongs to C004 instead of C013",
  },
  settings: {
    model: "claude-opus-5-5",
    endpoint: "client.beta.messages (TypeScript SDK 1.3.0), betas server-side-fallback-2026-07-01, fallbacks: 'default'",
    thinking: "adaptive (default; not sent)",
    sampling_params: "none sent",
    system_a: "effort high, max 40 turns, read_file default 4000 chars (max 20000), $5 run cap, no code execution",
    system_b: "extraction effort low (structured outputs, 8 concurrent), adjudication effort high, $4 run cap",
  },
};

// Planned runs; anything without a scored, non-partial row is reported as missing.
const PLANNED: { fixture_seed: number; system: "A" | "B"; run_id: string }[] = [
  ...["a-r1", "a-r2", "a-r3"].map((run_id) => ({ fixture_seed: 487291, system: "A" as const, run_id })),
  ...["b-r1", "b-r2", "b-r3"].map((run_id) => ({ fixture_seed: 487291, system: "B" as const, run_id })),
  ...["a-f1", "a-f2"].map((run_id) => ({ fixture_seed: 20261024, system: "A" as const, run_id })),
  ...["b-f1", "b-f2"].map((run_id) => ({ fixture_seed: 20261024, system: "B" as const, run_id })),
];
const coverage = {
  completed: rows.filter((r) => r.kind === "scored").map((r) => r.run_id),
  partial: rows.filter((r) => r.kind === "partial").map((r) => ({ run_id: r.run_id, note: "extraction + rules completed; adjudication not run (API credit exhausted); 6 judgment cases held for review" })),
  missing: PLANNED.filter((p) => !rows.some((r) => r.run_id === p.run_id && r.kind === "scored")).map((p) => p.run_id),
  blocker:
    "Anthropic API returned 400 'Your credit balance is too low' from 2026-10-24T08:14:49Z (harness spend at that point: see spend.total_usd). No API calls were made after the failure was confirmed.",
};

const PUBLISHED = [
  {
    source: "Ciru Inference Lab (benchmark author), Invoice Sandbox, 2026-07-17",
    url: "https://benchmarks-mu.vercel.app/invoicesandbox/",
    setup: "Pi 0.78.0 coding harness with bash; 4 local quantized open-weight models; prescriptive prompt (pdf-parse, page 1 only, regex hints) + HTML dashboard; same commit b8cb58f",
    results: [
      { model: "HY3 IQ1_M", customer_net_exact: "18/18", invoice_totals_exact: "105/105", trap_families: "6/6" },
      { model: "Ternary Bonsai 27B Q2_0", customer_net_exact: "0/18 strict (16/18 after removing an ID prefix)", invoice_totals_exact: "105/105", trap_families: "5/6" },
      { model: "HY3 iFP2", customer_net_exact: "1/18", invoice_totals_exact: "9/105", trap_families: "5/6" },
      { model: "Step 3.7 Flash FP3", customer_net_exact: "failed (no dashboard)" },
    ],
    comparable: "partially: same fixture and strict per-customer net metric; different models, harness (code execution) and prompt",
  },
  {
    source: "cadel.ai, Can Coding Agents Do Accounting? Benchmarking Invoice Reconciliation, 2026-07-08",
    url: "https://cadel.ai/us/blog/ai-agents-invoice-reconciliation-benchmark",
    comparable: "no: a different 35-case freight-invoice dataset, not this benchmark",
  },
];

const report = {
  generated_at: new Date().toISOString(),
  benchmark: { repository: "https://github.com/ciru-ai/invoice-sandbox-benchmark", commit: "b8cb58ff9747486e86c623e867b76fad5d8d075f", bench_dirs: benchDirs },
  coverage,
  published_results: PUBLISHED,
  context: CONTEXT,
  model: "claude-opus-5-5",
  spend: { hard_cap_usd: HARD_CAP_USD, total_usd: Number(totalSpent.toFixed(4)), by_run_usd: byRun, ledger: LEDGER_PATH, api_calls: ledger.length, fallback_calls: ledger.filter((e) => e.fallback_used).length },
  summary,
  runs: rows,
};
const outJson = path.join(REPO_ROOT, "docs/evals/invoice-sandbox.json");
fs.mkdirSync(path.dirname(outJson), { recursive: true });
fs.writeFileSync(outJson, JSON.stringify(report, null, 2) + "\n");

const f2 = (n: number) => n.toFixed(2);
console.log("| Fixture | Run | System | Customers exact (net) | All 4 fields exact | Trap docs ok | Trap entries ok | False exclusions | Net abs error | Cost | Wall |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(
    `| ${r.fixture} | ${r.run_id}${r.kind !== "scored" ? ` (${r.kind})` : ""} | ${r.system} | ${r.customers_exact}/${r.customers} | ${r.all_four_exact}/${r.customers} | ${r.trap_docs_ok}/${r.trap_docs} | ${r.trap_entries_ok}/${r.trap_entries} | ${r.false_exclusions} | $${f2(r.net_abs_error_usd ?? 0)} | $${f2(r.cost_usd)} | ${r.wall_s === null ? "n/a" : `${r.wall_s.toFixed(0)} s`} |`,
  );
}
console.log(`\nTotal spend: $${f2(totalSpent)} across ${ledger.length} API calls (${ledger.filter((e) => e.fallback_used).length} served by a fallback model).`);
console.log(`Wrote ${outJson}`);
