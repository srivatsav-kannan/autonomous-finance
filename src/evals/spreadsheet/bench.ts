// Part A: deterministic timing benchmark, no model. The same world event stream is applied
// (1) through the kernel's typed operations and (2) through a real .xlsx workbook behind
// spreadsheet tools, then the same bad operations are injected into both.
//   npm run eval:sheets-bench -- [--seed 7] [--stores 3] [--days 14] [--trials 10] [--warmup 2] [--out docs/evals]
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addDays } from "../../world/rng";
import { badCases, runKernelCase, runSheetCase, type KernelOutcome, type SheetOutcome } from "./bad-ops";
import type { KernelBooks } from "./kernel-books";
import { SheetBooks } from "./sheet-books";
import { summarize, type Summary } from "./stats";
import { SheetTools } from "./workbook";
import { buildStream, opCounts, type OpKind } from "./world-ops";
import { replayKernel, replaySheet, type TrialResult } from "./replay";
import { formatBenchReport } from "./report";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const options = { seed: Number(flag("seed", "7")), storeCount: Number(flag("stores", "3")), start: flag("start", "2026-01-01"), days: Number(flag("days", "14")), plantErrors: true };
const trials = Number(flag("trials", "10"));
const warmup = Number(flag("warmup", "2"));
const outDir = flag("out", path.join("docs", "evals"));
const workDir = path.join("var", "evals", "spreadsheet-bench");
fs.mkdirSync(workDir, { recursive: true });

const { world, steps } = buildStream(options);
const lastDay = addDays(options.start, options.days - 1);
const OP_KINDS: OpKind[] = ["record_bill", "resolve_bill", "post_entry", "match_bank"];
type PathName = "kernel" | "spreadsheet_saved" | "spreadsheet_in_memory";
const PATHS: PathName[] = ["kernel", "spreadsheet_saved", "spreadsheet_in_memory"];

const results: Record<PathName, TrialResult[]> = { kernel: [], spreadsheet_saved: [], spreadsheet_in_memory: [] };
const toolMs: Record<string, number[]> = {};
let lastKernel: KernelBooks | null = null;
let lastSheet: SheetBooks | null = null;
const baselineFile = path.join(workDir, "baseline.xlsx");
const started = performance.now();

for (let t = 0; t < warmup + trials; t++) {
  // Rotate the order each trial so neither path always runs on a cold or warm process.
  const order = PATHS.map((_, i) => PATHS[(i + t) % PATHS.length]!);
  for (const p of order) {
    if (p === "kernel") {
      const { k, trial } = await replayKernel(steps);
      if (t >= warmup) results.kernel.push(trial);
      lastKernel = k;
    } else {
      const file = p === "spreadsheet_saved" ? path.join(workDir, `trial-${t}.xlsx`) : null;
      const { s, trial } = await replaySheet(steps, file);
      if (t >= warmup) {
        results[p].push(trial);
        if (p === "spreadsheet_saved") for (const a of s.t.actions) (toolMs[a.tool] ??= []).push(a.ms);
      }
      if (p === "spreadsheet_saved") { lastSheet = s; await s.t.save(baselineFile); }
      if (file && t < warmup + trials - 1) fs.rmSync(file, { force: true });
    }
  }
  process.stdout.write(`trial ${t + 1}/${warmup + trials}${t < warmup ? " (warmup)" : ""} done\n`);
}

// ---- parity: both paths must have produced the same books from the same stream ----
const k = lastKernel!, sheet = lastSheet!;
const kernelTb = new Map((await k.trialBalance()).map((a) => [a.code, a.net]));
const sheetTb = new Map(sheet.t.rows("TB").filter((r) => r[0] !== "TOTAL").map((r) => [String(r[0]), Number(r[4])]));
const tbMismatches = [...new Set([...kernelTb.keys(), ...sheetTb.keys()])].filter((c) => (kernelTb.get(c) ?? 0) !== (sheetTb.get(c) ?? 0));
const statusTotals = (rows: { status: string; total: number }[]) => {
  const out: Record<string, { count: number; cents: number }> = {};
  for (const r of rows) { const o = out[r.status] ??= { count: 0, cents: 0 }; o.count++; o.cents += r.total; }
  return out;
};
const kernelBills = statusTotals(k.h.all("bills").map((b) => ({ status: b.status, total: b.totalCents })));
const sheetBills = statusTotals(sheet.t.rows("AP").map((r) => ({ status: String(r[8]), total: Number(r[7]) })));
const baselineChecks = sheet.t.checkValues();
const chain = await k.verifyChain();
const parity = {
  trialBalanceAccounts: sheetTb.size,
  trialBalanceMismatches: tbMismatches,
  kernelTrialBalanceNetsToZero: [...kernelTb.values()].reduce((a, b) => a + b, 0) === 0,
  billsByStatus: { kernel: kernelBills, spreadsheet: sheetBills, identical: JSON.stringify(kernelBills) === JSON.stringify(sheetBills) },
  journalEntries: k.h.all("journalEntries").length,
  ledgerRows: sheet.t.rows("Ledger").length,
  kernelHashChain: chain.ok,
  spreadsheetChecksAtBaseline: baselineChecks,
  workbookBytes: fs.statSync(baselineFile).size,
};
if (tbMismatches.length || !parity.billsByStatus.identical || baselineChecks.some((c) => !c.ok)) {
  console.error(JSON.stringify(parity, null, 2));
  throw new Error("the two paths disagree on the clean stream; timings would not be comparable");
}

// ---- injected bad operations: same cases, fresh copy of the clean books for each ----
const cases = badCases(steps, lastDay);
const injected: { id: string; invariant: string; description: string; kernel: { outcome: KernelOutcome; detail: string }; spreadsheet: { outcome: SheetOutcome; detail: string; actions: number } }[] = [];
for (const c of cases) {
  const { k: kc } = await replayKernel(steps);
  const kernel = await runKernelCase(kc, c);
  const s = new SheetBooks(await SheetTools.load(baselineFile, path.join(workDir, `case-${c.id}.xlsx`)));
  const spreadsheet = await runSheetCase(s, c);
  injected.push({ id: c.id, invariant: c.invariant, description: c.description, kernel, spreadsheet });
}

// ---- summarize ----
const pooled = (p: PathName, kind?: OpKind) => results[p].flatMap((t) => t.perOp.filter((o) => !kind || o.kind === kind).map((o) => o.ms));
const perPath = Object.fromEntries(PATHS.map((p) => [p, {
  allOps: summarize(pooled(p)),
  byKind: Object.fromEntries(OP_KINDS.map((kind) => [kind, summarize(pooled(p, kind))])) as Record<OpKind, Summary>,
  // Does an operation get slower as the books grow? First vs last tenth of the stream.
  firstTenthOps: summarize(results[p].flatMap((t) => t.perOp.slice(0, Math.ceil(t.perOp.length / 10)).map((o) => o.ms))),
  lastTenthOps: summarize(results[p].flatMap((t) => t.perOp.slice(-Math.ceil(t.perOp.length / 10)).map((o) => o.ms))),
  opsTotalPerTrialMs: summarize(results[p].map((t) => t.opsMs)),
  ingestTotalPerTrialMs: summarize(results[p].map((t) => t.ingestMs)),
}])) as Record<PathName, { allOps: Summary; byKind: Record<OpKind, Summary>; firstTenthOps: Summary; lastTenthOps: Summary; opsTotalPerTrialMs: Summary; ingestTotalPerTrialMs: Summary }>;

const actionStats = (p: PathName) => {
  const ops = results[p][0]!.perOp;
  const byKind = Object.fromEntries(OP_KINDS.map((kind) => {
    const xs = ops.filter((o) => o.kind === kind);
    const mean = (f: (o: (typeof xs)[number]) => number) => Math.round((xs.reduce((s, o) => s + f(o), 0) / Math.max(1, xs.length)) * 100) / 100;
    return [kind, { ops: xs.length, actionsPerOp: mean((o) => o.actions), cellsReadPerOp: mean((o) => o.cellsRead), cellsWrittenPerOp: mean((o) => o.cellsWritten) }];
  })) as Record<OpKind, { ops: number; actionsPerOp: number; cellsReadPerOp: number; cellsWrittenPerOp: number }>;
  const total = ops.reduce((s, o) => s + o.actions, 0);
  return { byKind, totalActions: total, actionsPerOp: Math.round((total / ops.length) * 100) / 100, ingestActions: results[p][0]!.ingestActions };
};

let commit = "unknown", dirty = false;
try {
  commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0;
} catch { /* not a git checkout */ }
const exceljsVersion = JSON.parse(fs.readFileSync(path.join("node_modules", "exceljs", "package.json"), "utf8")).version as string;
const count = <T extends string>(xs: T[], v: T) => xs.filter((x) => x === v).length;
const kOut = injected.map((i) => i.kernel.outcome), sOut = injected.map((i) => i.spreadsheet.outcome);

const report = {
  generatedAt: new Date().toISOString(),
  command: `npm run eval:sheets-bench -- --seed ${options.seed} --stores ${options.storeCount} --days ${options.days} --trials ${trials} --warmup ${warmup}`,
  commit, dirtyWorkingTree: dirty,
  machine: { cpu: os.cpus()[0]?.model ?? "unknown", logicalCores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version, exceljs: exceljsVersion },
  world: { ...options, events: world.events.length, steps: steps.length, counts: opCounts(steps), ops: steps.filter((s) => s.kind === "op").length },
  trials, warmup, wallSeconds: Math.round((performance.now() - started) / 100) / 10,
  timing: perPath,
  actions: { kernel: actionStats("kernel"), spreadsheet: actionStats("spreadsheet_saved") },
  spreadsheetToolMs: Object.fromEntries(Object.entries(toolMs).map(([tool, xs]) => [tool, summarize(xs)])),
  parity,
  injected,
  injectedSummary: {
    cases: injected.length,
    kernel: { prevented: count(kOut, "prevented"), absorbed: count(kOut, "absorbed"), detected: count(kOut, "detected"), missed: count(kOut, "missed") },
    spreadsheet: { prevented: count(sOut, "prevented"), detected: count(sOut, "detected"), missed: count(sOut, "missed") },
  },
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "spreadsheet-vs-kernel.json"), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, "spreadsheet-vs-kernel.md"), formatBenchReport(report));
console.log(`\nwrote ${path.join(outDir, "spreadsheet-vs-kernel.md")} and .json in ${report.wallSeconds}s`);
console.log(`median per op: kernel ${perPath.kernel.allOps.medianMs} ms, spreadsheet (saved) ${perPath.spreadsheet_saved.allOps.medianMs} ms, spreadsheet (in memory) ${perPath.spreadsheet_in_memory.allOps.medianMs} ms`);
console.log(`actions per op: kernel ${report.actions.kernel.actionsPerOp}, spreadsheet ${report.actions.spreadsheet.actionsPerOp}`);
console.log(`injected ${injected.length}: kernel stopped ${injected.length - report.injectedSummary.kernel.missed}; spreadsheet prevented ${report.injectedSummary.spreadsheet.prevented}, flagged ${report.injectedSummary.spreadsheet.detected}`);

export type BenchReport = typeof report;
