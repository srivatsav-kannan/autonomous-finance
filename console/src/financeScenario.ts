export const FINANCE_DEMO_RUN = "finance-workbench";
const PREFERENCE_KEY = "autonomous-finance.scenario";

export function chooseFinanceScenario(
  runs: readonly { runId: string }[],
  requested: string,
  remembered = "",
): string {
  // Explicit links may refer to a run outside the recent-run list.
  if (requested) return requested;
  if (remembered && runs.some(run => run.runId === remembered)) return remembered;
  return runs.find(run => run.runId === FINANCE_DEMO_RUN)?.runId ?? runs[0]?.runId ?? "";
}

export function rememberedFinanceScenario(): string {
  try { return localStorage.getItem(PREFERENCE_KEY) ?? ""; } catch { return ""; }
}

export function rememberFinanceScenario(runId: string): void {
  try { localStorage.setItem(PREFERENCE_KEY, runId); } catch { /* URL navigation still works without browser storage. */ }
}
