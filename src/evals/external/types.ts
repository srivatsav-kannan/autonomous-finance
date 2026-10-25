import type { Role } from "../../core/roles";
import type { Usage } from "../../agents/llm";

export const MODES = ["full-team", "generalist", "rules-only"] as const;
export type Mode = (typeof MODES)[number];
export interface BenchmarkTask {
  id: string;
  benchmark: "apex" | "dabstep";
  sourceId: string;
  label: string;
  role: Role;
  prompt: string;
  evidence: string;
  evidenceSha256: string;
  answerType?: "number" | "integer-set";
  decimals?: number;
}
export interface Gold {
  kind: "rubric" | "number" | "integer-set";
  answer: string;
  decimals?: number;
  criteria?: { id: string; description: string }[];
}
export interface Trace {
  seat: string;
  tool: string;
  input: unknown;
  output: unknown;
}
export interface Answer {
  status: "answered" | "abstained" | "error";
  answer: string;
  reason?: string;
  usage: Usage;
  trace: Trace[];
  kernelRunId?: string;
}
export interface Grade {
  status: "graded" | "ungraded" | "error";
  score: number | null;
  passed: boolean | null;
  method: string;
  reason?: string;
  criteria?: { id: string; met: boolean; reason: string }[];
  judgeUsage: Usage;
}
export interface Result extends Answer {
  taskId: string;
  benchmark: BenchmarkTask["benchmark"];
  mode: Mode;
  repeat: number;
  wallSeconds: number;
  grade: Grade;
}
