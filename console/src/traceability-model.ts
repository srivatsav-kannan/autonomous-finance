import type { APCaseDetail, SourceBinding, SourceDocument } from "../../src/ap-system/contracts";

export const sourceKey = (source: SourceBinding) => `${source.sourceId}:${source.revision}:${source.sha256}`;
export function sourceSnapshots(detail: APCaseDetail) {
  const seen = new Set<string>();
  const history = [...detail.decisions].sort((a, b) => a.at - b.at).flatMap(decision => {
    const key = `${decision.candidateRevision}:${decision.snapshotHash}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: decision.decisionId, label: `Revision ${decision.candidateRevision} · ${new Date(decision.at).toLocaleString()}`, bindings: decision.sourceBindings, hash: decision.snapshotHash }];
  });
  return [...history, { id: "current", label: `Current revision ${detail.revision}`, bindings: detail.currentSourceBindings, hash: detail.snapshotHash }];
}
export function sourceChanges(sources: SourceDocument[], before: SourceBinding[], after: SourceBinding[]) {
  const resolve = (binding: SourceBinding) => sources.find(source => sourceKey(source) === sourceKey(binding));
  const consumed = new Set<string>();
  const result: { key: string; status: string; before?: SourceDocument; after?: SourceDocument; beforeBinding?: SourceBinding; afterBinding?: SourceBinding }[] = after.map(binding => {
    const current = resolve(binding);
    const prior = before.find(old => old.sourceId === binding.sourceId || current?.replaces && sourceKey(old) === sourceKey(current.replaces));
    if (prior) consumed.add(sourceKey(prior));
    const status = !prior ? "added" : sourceKey(prior) === sourceKey(binding) ? "unchanged" : prior.sha256 === binding.sha256 ? "reversioned" : "changed";
    return { key: sourceKey(binding), status, before: prior ? resolve(prior) : undefined, after: current, beforeBinding: prior, afterBinding: binding };
  });
  for (const binding of before) if (!consumed.has(sourceKey(binding))) result.push({ key: sourceKey(binding), status: "removed", before: resolve(binding), after: undefined, beforeBinding: binding, afterBinding: undefined });
  return result;
}
export type ValueDiff = { path: string; before: string; after: string };
export function valueDiff(before: unknown, after: unknown): ValueDiff[] {
  const rows: ValueDiff[] = [];
  const format = (value: unknown) => value === undefined ? "Not present" : JSON.stringify(value);
  const visit = (a: unknown, b: unknown, path: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
      const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) visit(left[key], right[key], path ? `${path}.${key}` : key);
    } else rows.push({ path: path || "record", before: format(a), after: format(b) });
  };
  visit(before, after, "");
  return rows;
}
export function textDiff(before: string, after: string) {
  const a = before.split(/\r?\n/), b = after.split(/\r?\n/);
  // Bound memory for large OCR documents; a full before/after replacement remains exact.
  if (a.length * b.length > 250_000) return [{ kind: "removed", text: before }, { kind: "added", text: after }];
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const rows: { kind: string; text: string }[] = []; let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ kind: "same", text: a[i++]! }); j++; }
    else if (j < b.length && (i === a.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) rows.push({ kind: "added", text: b[j++]! });
    else rows.push({ kind: "removed", text: a[i++]! });
  }
  return rows;
}
