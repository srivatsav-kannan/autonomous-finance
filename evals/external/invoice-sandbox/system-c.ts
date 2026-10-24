// System C: the actual autonomous-finance system. Every workspace file is delivered to a fresh company
// run as a received document; the agent team (AR clerk, integrations engineer, controller) handles them
// through the kernel and git memory exactly as in the Sweetgreen world; the submission is read back from
// the kernel's receivables records and dispositions. No benchmark-specific code runs inside the team:
// this file only delivers documents and reads results.
import fs from "node:fs";
import path from "node:path";
import "../../../src/core/env";
import { AdminClient, api, convex, hashToken, newToken } from "../../../src/core/kernel-client";
import { INITIAL_ORG } from "../../../src/core/org";
import { MemoryStore, type FileChange } from "../../../src/memory/store";
import { DEFAULT_RECEIVABLES_POLICY } from "../../../src/memory/schemas";
import { Team } from "../../../src/agents/team";
import { llmAvailable, MODEL } from "../../../src/agents/llm";
import { memoryDir, runDir } from "../../../src/world/scenario";
import { LEDGER_PATH } from "./lib/config";
import { writeSubmission, type Submission, type SuspiciousDoc } from "./lib/submission";
import type { Workspace } from "./lib/workspace";

export interface SystemCResult {
  status: "completed" | "stopped_at_cap" | "timed_out";
  kernel_run_id: string;
  claude: boolean;
  documents: number;
  tasks: number;
  llm_tasks: number;
  cost_usd: number;
  parsers_learned: number;
  customers_registered: number;
  undisposed_documents: number;
  kernel_blocks: number;
  memory_commits: number;
  open_asks: number;
  wall_ms: number;
}

/** What the mailroom knows about a file without reading it: its folder and extension. */
function kindOf(rel: string): string {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".pdf")) return "ar_document";
  if (lower.endsWith(".eml")) return "ar_email";
  if (lower.startsWith("crm/") && lower.endsWith(".csv")) return "customer_master";
  if (lower.startsWith("bank_exports/")) return "bank_export";
  return "reference";
}

const PERIODS = Array.from({ length: 5 * 12 }, (_, i) => `${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`);

// Day-zero memory for a company we know nothing about yet: limits and the receivables policy only.
const SEED: FileChange[] = [
  { path: "policies/approval-limits.yaml", data: { autoApproveCents: 5_000_00, dualApprovalCents: 10_000_00, humanApprovalCents: 50_000_00 } },
  { path: "policies/materiality.yaml", data: { priceVarianceBps: 100, quantityToleranceUnits: 0, payoutToleranceCents: 500, bankMatchToleranceCents: 0 } },
  { path: "policies/receivables.yaml", data: DEFAULT_RECEIVABLES_POLICY },
];

const money = (cents: number) => (cents / 100).toFixed(2);

export async function runSystemC(opts: { runId: string; ws: Workspace; outDir: string; runCapUsd: number; timeoutMs?: number; verbose?: boolean }): Promise<SystemCResult> {
  const started = Date.now();
  const kernelRunId = `bench-is-${opts.runId}-${Date.now().toString(36)}`;
  const admin = new AdminClient();
  const tokens: Record<string, string> = {};
  for (const s of INITIAL_ORG) tokens[s.seatId] = newToken();
  const created = await admin.client.mutation(api.admin.createRun, {
    secret: admin.secret,
    runId: kernelRunId,
    label: `invoice-sandbox ${opts.runId}`,
    company: "invoice-sandbox",
    simDate: "2026-01-15",
    periods: PERIODS,
    seats: INITIAL_ORG.map((s) => ({ seatId: s.seatId, role: s.role, name: s.name, kind: s.kind, reportsTo: s.reportsTo, tokenHash: hashToken(tokens[s.seatId]!), effort: s.effort })),
  });
  if (!created.ok) throw new Error(`createRun failed: ${created.code} ${created.error}`);
  fs.mkdirSync(runDir(kernelRunId), { recursive: true });
  fs.writeFileSync(path.join(runDir(kernelRunId), "seats.json"), JSON.stringify(tokens, null, 2), { mode: 0o600 });
  const mem = new MemoryStore(memoryDir(kernelRunId));
  await mem.init();
  await mem.bootstrap(SEED, { seatId: "system", name: "System" }, "Seed company memory (day zero)");

  const files = opts.ws.allFiles();
  for (const rel of files) {
    const r = await admin.client.mutation(api.admin.ingestEvent, {
      secret: admin.secret, runId: kernelRunId, type: "document.received", externalId: `workspace:${rel}`, occurredOn: "2026-01-15",
      payload: { kind: kindOf(rel), path: rel, channel: "workspace", text: opts.ws.readText(rel) },
    });
    if (!r.ok) throw new Error(`ingest ${rel}: ${r.code} ${r.error}`);
  }
  console.log(`C ${opts.runId}: ${files.length} documents delivered to ${kernelRunId} · Claude ${llmAvailable() ? "on" : "off"}`);

  const cost = async () => (await convex().query(api.observe.agentRuns, { runId: kernelRunId })).reduce((s, r) => s + r.costMicros, 0) / 1e6;
  const team = new Team(kernelRunId, { log: opts.verbose ? (s) => console.log(s) : undefined });
  let status: SystemCResult["status"] = "completed";
  const guard = setInterval(() => {
    void cost().then((c) => {
      if (c >= opts.runCapUsd) {
        status = "stopped_at_cap";
        team.stop();
      }
    });
  }, 5_000);
  const deadline = started + (opts.timeoutMs ?? 30 * 60_000);
  try {
    // Deferred work (documents waiting for a parser) is queued with a delay; keep going until nothing is queued.
    for (;;) {
      await team.runUntilIdle({ idleRounds: 2 });
      if (status !== "completed") break;
      const stats = await convex().query(api.tasks.queueStats, { runId: kernelRunId });
      const pending = Object.values(stats).reduce((s, r) => s + (r.queued ?? 0) + (r.leased ?? 0), 0);
      if (pending === 0) break;
      if (Date.now() > deadline) {
        status = "timed_out";
        break;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  } finally {
    clearInterval(guard);
  }

  const [totals, dispositions, undisposed, runs, violations, commits, asks, stats] = await Promise.all([
    convex().query(api.receivables.customerTotals, { runId: kernelRunId }),
    convex().query(api.receivables.dispositions, { runId: kernelRunId }),
    convex().query(api.receivables.undisposed, { runId: kernelRunId }),
    convex().query(api.observe.agentRuns, { runId: kernelRunId }),
    convex().query(api.observe.violations, { runId: kernelRunId }),
    convex().query(api.observe.commits, { runId: kernelRunId, limit: 5000 }),
    convex().query(api.asks.list, { runId: kernelRunId }),
    convex().query(api.tasks.queueStats, { runId: kernelRunId }),
  ]);
  const parsers = (await mem.list("integrations/parsers/")).length;
  const treatment = (t: string): SuspiciousDoc["treatment"] =>
    t === "subtracted_as_credit" ? "subtracted_as_credit" : t === "counted_with_flag" ? "counted_with_flag" : "excluded_from_spend";
  const sub: Submission = {
    customers: totals.map((t) => ({
      customer_id: t.customerId, customer_name: t.legalName, valid_invoice_count: t.validInvoiceCount,
      gross_invoice_spend_usd: money(t.grossCents), credit_memo_total_usd: money(t.creditCents), net_spend_usd: money(t.netCents),
    })),
    suspicious_documents: dispositions
      .filter((d) => d.treatment !== "counted")
      .map((d) => ({
        path: d.path,
        document_id: d.documentNumber ?? null,
        customer_id: d.customerId ?? null,
        category: (["void", "superseded_original", "duplicate_scan", "statement_summary", "email_quoted_total", "bank_deposit", "credit_memo", "reference_only", "data_quality"].includes(d.category) ? d.category : "other") as SuspiciousDoc["category"],
        treatment: treatment(d.treatment),
        reason: d.treatment === "held" || d.treatment === "unreadable" ? `${d.treatment}: ${d.reason}` : d.reason,
      })),
    notes: `Read back from the autonomous-finance kernel (run ${kernelRunId}): open customer invoices and credit memos per customer, and every non-counted document disposition.`,
  };
  writeSubmission(opts.outDir, sub);

  const costUsd = runs.reduce((s, r) => s + r.costMicros, 0) / 1e6;
  const result: SystemCResult = {
    status,
    kernel_run_id: kernelRunId,
    claude: llmAvailable(),
    documents: files.length,
    tasks: runs.length,
    llm_tasks: runs.filter((r) => r.kind === "llm").length,
    cost_usd: Number(costUsd.toFixed(4)),
    parsers_learned: parsers,
    customers_registered: totals.length,
    undisposed_documents: undisposed.length,
    kernel_blocks: violations.length,
    memory_commits: commits.length,
    open_asks: asks.filter((a) => a.status === "open").length,
    wall_ms: Date.now() - started,
  };
  fs.writeFileSync(path.join(opts.outDir, "c_trace.json"), JSON.stringify({
    result, queue: stats, undisposed, violations: violations.map((v) => ({ seat: v.seatId, op: v.operation, reason: v.reason })),
    asks: asks.map((a) => ({ to: a.to, status: a.status, title: a.title })),
    by_seat: Object.entries(runs.reduce<Record<string, { tasks: number; llm: number; cost_usd: number }>>((acc, r) => {
      const k = r.seatId;
      acc[k] ??= { tasks: 0, llm: 0, cost_usd: 0 };
      acc[k].tasks++;
      if (r.kind === "llm") acc[k].llm++;
      acc[k].cost_usd += r.costMicros / 1e6;
      return acc;
    }, {})).map(([seat, v]) => ({ seat, ...v })),
  }, null, 2) + "\n");

  // One ledger line per run so the harness's spend report covers System C too.
  fs.appendFileSync(LEDGER_PATH, JSON.stringify({
    ts: new Date().toISOString(), run_id: opts.runId, system: "C", purpose: "autonomous-finance team (all seats, summed)", model_requested: MODEL,
    models_served: [MODEL], fallback_used: false, stop_reason: null,
    input_tokens: runs.reduce((s, r) => s + r.inputTokens, 0), output_tokens: runs.reduce((s, r) => s + r.outputTokens, 0),
    cache_read_input_tokens: runs.reduce((s, r) => s + r.cacheReadTokens, 0), cache_creation_input_tokens: 0,
    cost_usd: costUsd, latency_ms: result.wall_ms,
  }) + "\n");
  return result;
}
