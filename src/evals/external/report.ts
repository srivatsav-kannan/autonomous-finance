import type { Mode, Result } from "./types";

export function summarize(results: Result[], expectedRuns = results.length) {
  const progress = { completedRuns: results.length, expectedRuns, complete: results.length === expectedRuns };
  const groups = [...new Set(results.map((r) => `${r.mode}/${r.benchmark}`))].map((key) => {
    const rows = results.filter((r) => `${r.mode}/${r.benchmark}` === key);
    const scored = rows.filter((r) => r.grade.score !== null);
    return {
      mode: rows[0]!.mode, benchmark: rows[0]!.benchmark, runs: rows.length,
      answered: rows.filter((r) => r.status === "answered").length,
      abstained: rows.filter((r) => r.status === "abstained").length,
      errors: rows.filter((r) => r.status === "error").length,
      graded: scored.length,
      // Never make a partial evaluation look like a completed comparison.
      meanScore: progress.complete && scored.length === rows.length ? scored.reduce((s, r) => s + r.grade.score!, 0) / rows.length : null,
      fullyPassed: rows.filter((r) => r.grade.passed === true).length,
      agentTurns: rows.reduce((s, r) => s + r.usage.turns, 0),
      inputTokens: rows.reduce((s, r) => s + r.usage.inputTokens, 0),
      outputTokens: rows.reduce((s, r) => s + r.usage.outputTokens, 0),
      estimatedAgentCostUsd: rows.reduce((s, r) => s + r.usage.costMicros, 0) / 1e6,
      estimatedJudgeCostUsd: rows.reduce((s, r) => s + r.grade.judgeUsage.costMicros, 0) / 1e6,
      wallSeconds: rows.reduce((s, r) => s + r.wallSeconds, 0),
    };
  });
  const paired = (["generalist", "rules-only"] as Mode[]).flatMap((baseline) => (["apex", "dabstep"] as const).map((benchmark) => {
    const team = results.filter((r) => r.mode === "full-team" && r.benchmark === benchmark);
    const pairs = team.flatMap((r) => {
      const other = results.find((x) => x.mode === baseline && x.taskId === r.taskId && x.repeat === r.repeat);
      return other && r.grade.score !== null && other.grade.score !== null ? [r.grade.score - other.grade.score] : [];
    });
    return { benchmark, baseline, pairs: pairs.length, meanDelta: pairs.length ? pairs.reduce((a,b) => a+b,0)/pairs.length : null };
  })).filter((p) => p.pairs && progress.complete);
  return { progress, groups, paired };
}

export function formatComparison(results: Result[], expectedRuns = results.length): string {
  const { progress, groups, paired } = summarize(results, expectedRuns);
  const pct = (value: number | null) => value === null ? "pending" : `${(value*100).toFixed(1)}%`;
  const cell = (value: unknown) => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    "# Finance eight-task comparison", "",
    `Run progress: ${progress.completedRuns}/${progress.expectedRuns} task runs recorded. ${progress.complete ? "Execution complete; grading coverage is shown below." : "INCOMPLETE — aggregate scores and paired deltas are withheld."}`, "",
    "Local development-subset evaluation, not an official APEX or DABstep leaderboard score. APEX uses mean rubric credit; DABstep uses exact sets and numeric tolerances. Results remain separate by benchmark.", "",
    "Full-team uses the real seat scheduler, specialist → controller handoff, and Git decision records. External cases produce answers, not ledger mutations. Generalist has the same evidence tools and total turn cap. Rules-only has task-specific deterministic procedures for all eight cases. Errors and abstentions receive zero.", "",
    "| Mode | Benchmark | Runs | Answered | Graded | Mean score | Fully passed | Abstained | Errors | Agent turns | Agent $ est. | Judge $ est. | Seconds |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...groups.map((g) => `| ${g.mode} | ${g.benchmark} | ${g.runs} | ${g.answered} | ${g.graded} | ${pct(g.meanScore)} | ${g.fullyPassed} | ${g.abstained} | ${g.errors} | ${g.agentTurns} | ${g.estimatedAgentCostUsd.toFixed(4)} | ${g.estimatedJudgeCostUsd.toFixed(4)} | ${g.wallSeconds.toFixed(1)} |`), "",
    "Costs use the run's approved provider/model prices, not provider billing; judge usage is separate. Unverified requests retain their reserved cost ceiling; consult the budget ledger for uncertain charges. A pending mean means execution is incomplete or at least one grade is missing or failed. Fixed external tasks are repeated trials, not new synthetic-world seeds.", "",
    "| Case | Mode | Repeat | Answer status | Score | Grade status | Detail |", "|---|---|---:|---|---:|---|---|",
    ...results.map((r) => `| ${r.taskId} | ${r.mode} | ${r.repeat} | ${r.status} | ${pct(r.grade.score)} | ${r.grade.status} | ${cell(r.reason ?? r.grade.reason)} |`), "",
    ...(paired.length ? ["Paired deltas (full-team minus baseline; matched task and repeat):", "", ...paired.map((p) => `- ${p.benchmark} / ${p.baseline}: ${(p.meanDelta!*100).toFixed(1)} percentage points across ${p.pairs} scored pairs.`)] : []),
    "",
  ].join("\n");
}
