import { describe, expect, it, vi } from "vitest";
import { emptyUsage } from "../../agents/llm";
import { gradeAnswer, scoreDab } from "./score";
import { summarize } from "./report";
import type { Answer, BenchmarkTask, Gold, Result } from "./types";

const task = { id: "apex-17", benchmark: "apex", prompt: "Reconcile payroll." } as BenchmarkTask;
const answer = (status: Answer["status"] = "answered"): Answer => ({ status, answer: "Payroll totals reconcile.", usage: emptyUsage(), trace: [] });
const rubric: Gold = { kind: "rubric", answer: "Expert answer", criteria: [{ id: "a", description: "Correct total" }, { id: "b", description: "Correct adjustment" }] };

describe("DABstep local scorer", () => {
  it("uses stated numeric precision and accommodates upstream floating artifacts", () => {
    expect(scoreDab("0.120132", { kind: "number", answer: "0.120132", decimals: 6 })).toBe(true);
    expect(scoreDab("0.120133", { kind: "number", answer: "0.120132", decimals: 6 })).toBe(false);
    expect(scoreDab("-0.94810300000000", { kind: "number", answer: "-0.94810300000017", decimals: 14 })).toBe(true);
  });
  it("rejects numbers embedded in prose, multiple answers, nonfinite values and empty output", () => {
    for (const bad of ["0.12 or 0.120132", "Expected 0.120132", "", "NaN", "Infinity", "1e999"])
      expect(scoreDab(bad, { kind: "number", answer: "0.120132", decimals: 6 })).toBe(false);
  });
  it("compares complete fee-ID sets without depending on order", () => {
    const gold: Gold = { kind: "integer-set", answer: "1, 2, 5" };
    expect(scoreDab("5,2,1", gold)).toBe(true);
    for (const bad of ["1,2", "1,2,5,6", "1,2,5,5", "Fee IDs: 1,2,5"]) expect(scoreDab(bad, gold)).toBe(false);
  });
});

describe("APEX rubric scoring", () => {
  it("computes fractional criterion credit and retains explanations", async () => {
    const result = await gradeAnswer(task, answer(), rubric, true, async () => [{ id: "b", met: false, reason: "Missing correction" }, { id: "a", met: true, reason: "Correct total" }]);
    expect(result).toMatchObject({ score: 0.5, passed: false, status: "graded" });
    expect(result.criteria).toHaveLength(2);
  });
  it("never silently scores a disabled judge", async () => {
    const judge = vi.fn();
    expect(await gradeAnswer(task, answer(), rubric, false, judge)).toMatchObject({ score: null, status: "ungraded", passed: null });
    expect(judge).not.toHaveBeenCalled();
  });
  it("records malformed or failed judging as errors, not passes or zeroes", async () => {
    for (const verdicts of [[{ id: "a", met: true, reason: "yes" }], [{ id: "a", met: true, reason: "yes" }, { id: "a", met: true, reason: "yes" }], [{ id: "a", met: true, reason: "yes" }, { id: "unknown", met: true, reason: "yes" }]]) {
      expect(await gradeAnswer(task, answer(), rubric, true, async () => verdicts)).toMatchObject({ status: "error", score: null });
    }
    expect(await gradeAnswer(task, answer(), rubric, true, async () => { throw new Error("judge outage"); })).toMatchObject({ status: "error", score: null, reason: "judge outage" });
  });
  it("counts agent failure and abstention as zero without calling a judge", async () => {
    const judge = vi.fn();
    for (const status of ["abstained", "error"] as const) expect(await gradeAnswer(task, answer(status), rubric, true, judge)).toMatchObject({ score: 0, passed: false });
    expect(judge).not.toHaveBeenCalled();
  });
});

function result(taskId: string, mode: Result["mode"], repeat: number, score: number | null): Result {
  return { ...answer(), taskId, benchmark: "apex", mode, repeat, wallSeconds: 1, grade: { status: score === null ? "error" : "graded", score, passed: score === 1, method: "test", judgeUsage: emptyUsage() } };
}
describe("comparison aggregation", () => {
  it("withholds aggregate comparisons for an interrupted execution", () => {
    const summary = summarize([result("a", "full-team", 1, 1), result("a", "generalist", 1, 0)], 6);
    expect(summary.progress).toEqual({ completedRuns: 2, expectedRuns: 6, complete: false });
    expect(summary.groups.every((g) => g.meanScore === null)).toBe(true);
    expect(summary.paired).toEqual([]);
  });
  it("withholds group means when grades are incomplete and pairs only matching task/repeat", () => {
    const summary = summarize([result("a", "full-team", 1, 1), result("b", "full-team", 1, null), result("a", "generalist", 1, 0.5), result("a", "generalist", 2, 1)]);
    expect(summary.groups.find((g) => g.mode === "full-team")).toMatchObject({ graded: 1, runs: 2, meanScore: null });
    expect(summary.paired).toEqual([{ benchmark: "apex", baseline: "generalist", pairs: 1, meanDelta: 0.5 }]);
  });
});
