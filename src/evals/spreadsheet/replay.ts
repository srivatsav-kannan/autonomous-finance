// Apply a whole stream to either path, timing each operation and counting its tool calls.
import { KernelBooks } from "./kernel-books";
import { SheetBooks } from "./sheet-books";
import { SheetTools } from "./workbook";
import type { OpKind, Step } from "./world-ops";

export interface TrialResult { perOp: { kind: OpKind; ms: number; actions: number; cellsRead: number; cellsWritten: number }[]; ingestMs: number; ingestActions: number; opsMs: number }

export async function replayKernel(stream: Step[]): Promise<{ k: KernelBooks; trial: TrialResult }> {
  const k = await KernelBooks.create();
  const perOp: TrialResult["perOp"] = [];
  let ingestMs = 0;
  for (const s of stream) {
    const t0 = performance.now();
    if (s.kind === "ingest") { await k.ingest(s.event); ingestMs += performance.now() - t0; continue; }
    const before = k.calls;
    const r = await k.apply(s.op);
    const ms = performance.now() - t0;
    if (!r.ok) throw new Error(`clean stream op ${s.op.key} was refused by the kernel: ${r.code} ${r.error}`);
    perOp.push({ kind: s.op.kind, ms, actions: k.calls - before, cellsRead: 0, cellsWritten: 0 });
  }
  return { k, trial: { perOp, ingestMs, ingestActions: 0, opsMs: perOp.reduce((a, b) => a + b.ms, 0) } };
}

export async function replaySheet(stream: Step[], file: string | null): Promise<{ s: SheetBooks; trial: TrialResult }> {
  const s = new SheetBooks(await SheetTools.create(file));
  const perOp: TrialResult["perOp"] = [];
  let ingestMs = 0, ingestActions = 0;
  for (const step of stream) {
    const a0 = s.t.actions.length;
    const t0 = performance.now();
    if (step.kind === "ingest") {
      await s.ingest(step.event);
      ingestMs += performance.now() - t0;
      ingestActions += s.t.actions.length - a0;
      continue;
    }
    await s.apply(step.op);
    const ms = performance.now() - t0;
    const acts = s.t.actions.slice(a0);
    perOp.push({ kind: step.op.kind, ms, actions: acts.length, cellsRead: acts.reduce((x, a) => x + a.cellsRead, 0), cellsWritten: acts.reduce((x, a) => x + a.cellsWritten, 0) });
  }
  return { s, trial: { perOp, ingestMs, ingestActions, opsMs: perOp.reduce((a, b) => a + b.ms, 0) } };
}

