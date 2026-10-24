// On-disk layout for runs (gitignored under var/) and the shared spend ledger.
import fs from "node:fs";
import path from "node:path";
import { EDGAR_RESULT_FORMAT, RUNS_DIR } from "./config";
import type { AgentRecord } from "./agent";
import type { QuestionJudgment } from "./judge";

export interface QuestionRecord extends AgentRecord {
  id: string;
  type: string;
  question: string;
  run_id: string;
  started_at: string;
  harness_version: string;
}

/** Bumped whenever agent-side behaviour changes, so records from different harness versions are never mixed silently. */
/** v1: first full pass (compact-JSON edgar_search results). v2: Python-style JSON output (see edgar.ts pyJsonDumps). */
export const HARNESS_VERSION = EDGAR_RESULT_FORMAT === "compact" ? "1" : "2";

export function runDir(runId: string) {
  return path.join(RUNS_DIR, "runs", runId);
}
const ensure = (dir: string) => fs.mkdirSync(dir, { recursive: true });

export function recordPath(runId: string, id: string) {
  return path.join(runDir(runId), "questions", `${id}.json`);
}
export function transcriptPath(runId: string, id: string) {
  return path.join(runDir(runId), "transcripts", `${id}.json`);
}
export function judgmentPath(runId: string, judgeTag: string, id: string) {
  return path.join(runDir(runId), `judge-${judgeTag}`, `${id}.json`);
}

export function writeJson(file: string, value: unknown) {
  ensure(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function readRecords(runId: string): QuestionRecord[] {
  const dir = path.join(runDir(runId), "questions");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as QuestionRecord);
}

export function readJudgments(runId: string, judgeTag: string): QuestionJudgment[] {
  const dir = path.join(runDir(runId), `judge-${judgeTag}`);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as QuestionJudgment);
}

// ---- spend ledger (all phases: probe, agent runs, judge) ----

export interface LedgerEntry {
  ts: string;
  phase: "probe" | "agent" | "judge" | "other";
  run_id: string;
  id: string;
  usd: number;
  note?: string;
}

const LEDGER = path.join(RUNS_DIR, "ledger.jsonl");

export function appendLedger(entry: Omit<LedgerEntry, "ts">) {
  ensure(RUNS_DIR);
  fs.appendFileSync(LEDGER, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

export function readLedger(): LedgerEntry[] {
  if (!fs.existsSync(LEDGER)) return [];
  return fs
    .readFileSync(LEDGER, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LedgerEntry);
}

export function ledgerTotal(): number {
  return readLedger().reduce((a, e) => a + e.usd, 0);
}
