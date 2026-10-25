// Small statistics helpers: Wilson interval and a seeded stratified bootstrap.

export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 0 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mean of per-group means (Vals' class-balanced accuracy). */
export function classBalanced(groups: Map<string, number[]>): number {
  const means = [...groups.values()].filter((g) => g.length).map((g) => g.reduce((a, b) => a + b, 0) / g.length);
  return means.reduce((a, b) => a + b, 0) / means.length;
}

/** Percentile CI of the class-balanced mean, resampling within each group. */
export function stratifiedBootstrap(groups: Map<string, number[]>, iters = 10000, seed = 7): { lo: number; hi: number } {
  const rand = mulberry32(seed);
  const vals: number[] = [];
  const gs = [...groups.values()].filter((g) => g.length);
  for (let it = 0; it < iters; it++) {
    let sum = 0;
    for (const g of gs) {
      let s = 0;
      for (let i = 0; i < g.length; i++) s += g[Math.floor(rand() * g.length)]!;
      sum += s / g.length;
    }
    vals.push(sum / gs.length);
  }
  vals.sort((a, b) => a - b);
  return { lo: vals[Math.floor(0.025 * iters)]!, hi: vals[Math.floor(0.975 * iters)]! };
}

/** Standard error of the class-balanced mean: sqrt(sum p(1-p)/n_k) / K. */
export function classBalancedStderr(groups: Map<string, number[]>): number {
  const gs = [...groups.values()].filter((g) => g.length);
  let v = 0;
  for (const g of gs) {
    const p = g.reduce((a, b) => a + b, 0) / g.length;
    v += (p * (1 - p)) / g.length;
  }
  return Math.sqrt(v) / gs.length;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
