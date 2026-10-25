export interface Summary { n: number; medianMs: number; p95Ms: number; meanMs: number; minMs: number; maxMs: number }

/** Nearest-rank percentile on a sorted copy. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export function summarize(values: number[]): Summary {
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    n: values.length,
    medianMs: round(percentile(values, 50)),
    p95Ms: round(percentile(values, 95)),
    meanMs: round(values.reduce((s, v) => s + v, 0) / Math.max(1, values.length)),
    minMs: round(Math.min(...values)),
    maxMs: round(Math.max(...values)),
  };
}
