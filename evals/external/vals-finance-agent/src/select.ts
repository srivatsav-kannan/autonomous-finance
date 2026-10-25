// Question selection: explicit ids, all, or a stratified subset across Question Types.
import type { BenchQuestion } from "./dataset";

/** Deterministic PRNG (mulberry32) so a seed always yields the same subset. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Proportional allocation across Question Types with at least one question per
 * type (largest-remainder rounding), then a seeded draw within each type.
 * `exclude` ids (e.g. questions already run) are drawn first so they are reused.
 */
export function stratifiedSubset(questions: BenchQuestion[], n: number, seed = 1, prefer: Set<string> = new Set()): BenchQuestion[] {
  const byType = new Map<string, BenchQuestion[]>();
  for (const q of questions) byType.set(q.type, [...(byType.get(q.type) ?? []), q]);
  const types = [...byType.keys()].sort();
  if (n >= questions.length) return [...questions];
  if (n < types.length) throw new Error(`need at least ${types.length} questions to cover every type`);
  const total = questions.length;
  const alloc = new Map<string, number>();
  let used = 0;
  const remainders: { type: string; r: number }[] = [];
  for (const t of types) {
    const exact = (byType.get(t)!.length * n) / total;
    const base = Math.max(1, Math.floor(exact));
    alloc.set(t, base);
    used += base;
    remainders.push({ type: t, r: exact - Math.floor(exact) });
  }
  remainders.sort((a, b) => b.r - a.r || a.type.localeCompare(b.type));
  for (let i = 0; used < n && i < remainders.length * 4; i++) {
    const t = remainders[i % remainders.length]!.type;
    if (alloc.get(t)! < byType.get(t)!.length) {
      alloc.set(t, alloc.get(t)! + 1);
      used++;
    }
  }
  while (used > n) {
    // Over-allocated because of the one-per-type floor: trim the largest types.
    const t = [...alloc.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    alloc.set(t, alloc.get(t)! - 1);
    used--;
  }
  const rand = rng(seed);
  const picked: BenchQuestion[] = [];
  for (const t of types) {
    const pool = byType.get(t)!;
    const preferred = pool.filter((q) => prefer.has(q.id));
    const others = shuffle(pool.filter((q) => !prefer.has(q.id)), rand);
    picked.push(...[...preferred, ...others].slice(0, alloc.get(t)!));
  }
  return picked.sort((a, b) => a.index - b.index);
}
