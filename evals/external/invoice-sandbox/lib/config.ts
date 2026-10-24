import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** autonomous-finance repo root (evals/external/invoice-sandbox/lib -> ../../../..). */
export const REPO_ROOT = path.resolve(here, "../../../..");
export const HARNESS_DIR = path.resolve(here, "..");

/** The cloned benchmark (fixture, answer key, scorer). Never exposed to the model. */
export const BENCH_DIR = path.resolve(process.env.INVOICE_SANDBOX_DIR ?? path.join(REPO_ROOT, "../benchdata/invoice-sandbox"));
export const BENCH_PYTHON = path.join(BENCH_DIR, ".venv/bin/python");
export const RUNS_DIR = path.join(BENCH_DIR, "runs");
export const CACHE_DIR = path.join(BENCH_DIR, "cache");
/** One spend ledger for every fixture (original seed and fresh-seed copies), so the cap covers all runs. */
export const LEDGER_PATH = path.resolve(process.env.INVOICE_SANDBOX_LEDGER ?? path.join(REPO_ROOT, "../benchdata/invoice-sandbox/ledger.jsonl"));

/** Hard spend cap across every run (task budget $25 after the fresh-seed addition; stop short of it). */
export const HARD_CAP_USD = Number(process.env.INVOICE_SANDBOX_HARD_CAP ?? "24.5");

export function runPaths(runId: string) {
  const runDir = path.join(RUNS_DIR, runId);
  return {
    runDir,
    workspace: path.join(runDir, "workspace"),
    textCache: path.join(runDir, "text_cache"),
    out: path.join(runDir, "out"),
  };
}

/**
 * Reads ANTHROPIC_API_KEY from autonomous-finance/.env.local (only that variable).
 * The key is passed straight to the SDK client and never logged or written anywhere.
 */
export function loadApiKey(): string {
  const file = path.join(REPO_ROOT, ".env.local");
  if (!fs.existsSync(file)) throw new Error(`${file} not found`);
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("ANTHROPIC_API_KEY=")) continue;
    const value = line.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  }
  throw new Error("ANTHROPIC_API_KEY is missing from .env.local");
}
