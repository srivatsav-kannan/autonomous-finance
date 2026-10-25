/** Live processing of the original APEX PDFs. Every transition surrounds real parser/storage work. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { APCaseDetail, APIntake } from "../contracts";
import type { ApexCorpus, ApexCorpusEntry } from "./apex-corpus";

const stepSchema = z.object({
  file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), invoiceNumber: z.string().nullable(),
  status: z.enum(["queued", "parsing", "importing", "complete", "failed"]),
  startedAt: z.number().nullable(), completedAt: z.number().nullable(), caseId: z.string().nullable(),
  disposition: z.enum(["created", "existing"]).nullable(), extractionStatus: z.string().nullable(),
  supplierId: z.string().nullable(), parser: z.string().nullable(), exceptions: z.array(z.string()), error: z.string().nullable(),
});
const jobSchema = z.object({
  id: z.string(), runId: z.string(), status: z.enum(["running", "complete", "failed", "interrupted"]),
  startedAt: z.number(), updatedAt: z.number(), completedAt: z.number().nullable(), error: z.string().nullable(),
  counts: z.object({ total: z.number(), queued: z.number(), parsing: z.number(), importing: z.number(), complete: z.number(), failed: z.number() }),
  steps: z.array(stepSchema),
});
export type ApexProcessingStep = z.infer<typeof stepSchema>;
export type ApexProcessingJob = z.infer<typeof jobSchema>;
export type ApexProcessing = {
  start(): Promise<ApexProcessingJob>;
  status(): Promise<ApexProcessingJob | null>;
  /** Server shutdown/tests can wait for in-flight work without initiating any work. */
  waitForIdle(): Promise<ApexProcessingJob | null>;
};
export type ApexProcessingOptions = {
  runId: string; corpus: Pick<ApexCorpus, "entries">; stateFile: string;
  loadOriginal(entry: ApexCorpusEntry): Promise<Uint8Array>;
  parseUploads(input: { uploads: { bytes: Uint8Array; name: string; mimeType: string; kind: "invoice" }[]; idempotencyKey: string }): Promise<APIntake>;
  ingest(input: APIntake): Promise<{ caseId: string; duplicate?: boolean; replayed?: boolean }>;
  detail(caseId: string): Promise<APCaseDetail>;
};

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 700);
const hasCode = (error: unknown, code: string) => error instanceof Error && "code" in error && error.code === code;
async function privateJson(file: string): Promise<unknown | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 2 * 1024 * 1024) throw new Error("Processing state must be a private regular file smaller than 2 MiB");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

/** Create once per owned gateway/run. Concurrent Start clicks share the same in-flight job. */
export function createApexProcessing(options: ApexProcessingOptions): ApexProcessing {
  const entries = options.corpus.entries;
  if (!entries.length || new Set(entries.map(e => e.sha256)).size !== entries.length) throw new Error("Processing corpus must contain unique original PDFs");
  const manifestHash = hash(JSON.stringify(entries.map(e => [e.file, e.sha256])));
  const id = `apex-process-${hash(options.runId + ":" + manifestHash).slice(0, 24)}`;
  const file = path.resolve(options.stateFile), lockFile = file + ".lock";
  let job: ApexProcessingJob | null = null, work: Promise<void> | null = null, starting: Promise<ApexProcessingJob> | null = null;
  const snapshot = () => job ? structuredClone(job) : null;
  const refreshCounts = () => {
    if (!job) return;
    job.counts = { total: job.steps.length, queued: 0, parsing: 0, importing: 0, complete: 0, failed: 0 };
    for (const step of job.steps) job.counts[step.status]++;
    job.updatedAt = Date.now();
  };
  const persist = async () => {
    refreshCounts();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, manifestHash, job }) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, file); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  };
  const initialize = (async () => {
    const saved = await privateJson(file);
    if (saved === null) return;
    const state = z.object({ version: z.literal(1), manifestHash: z.string(), job: jobSchema }).parse(saved);
    if (state.manifestHash !== manifestHash || state.job.id !== id || state.job.runId !== options.runId || JSON.stringify(state.job.steps.map(e => [e.file, e.sha256])) !== JSON.stringify(entries.map(e => [e.file, e.sha256]))) throw new Error("Processing state belongs to a different run or source corpus");
    job = state.job;
    if (job.status === "running") {
      job.status = "interrupted"; job.error = "The previous worker stopped before completion. Start resumes unfinished documents with the same request keys.";
      for (const step of job.steps) if (step.status === "parsing" || step.status === "importing") step.status = "queued";
      refreshCounts();
    }
  })();
  // State is read eagerly; attach a handler immediately while preserving rejection for callers.
  void initialize.catch(() => {});
  const acquireLock = async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(lockFile, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, id })); } finally { await handle.close(); }
        return;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const lock = z.object({ pid: z.number().int().positive(), id: z.string() }).parse(await privateJson(lockFile));
        try { process.kill(lock.pid, 0); throw new Error("An APEX processing worker already owns this run"); }
        catch (probeError) { if (!hasCode(probeError, "ESRCH")) throw probeError; }
        await unlink(lockFile);
      }
    }
    throw new Error("Unable to acquire the APEX processing worker lock");
  };
  const run = async () => {
    for (const [index, entry] of entries.entries()) {
      const step = job!.steps[index]!;
      if (step.status === "complete") continue;
      try {
        step.status = "parsing"; step.startedAt = Date.now(); step.completedAt = null; step.error = null;
        await persist();
        const bytes = await options.loadOriginal(entry);
        if (hash(bytes) !== entry.sha256) throw new Error("The original PDF changed after inventory; processing stopped for this document");
        const input = await options.parseUploads({ uploads: [{ bytes, name: entry.file, mimeType: "application/pdf", kind: "invoice" }], idempotencyKey: `${id}-${entry.sha256}` });
        step.status = "importing";
        await persist();
        const result = await options.ingest(input);
        step.caseId = result.caseId;
        const detail = await options.detail(result.caseId);
        if (detail.runId !== options.runId || !detail.currentSourceBindings.some(binding => binding.sha256 === entry.sha256 && detail.sources.some(s => s.kind === "invoice" && s.sourceId === binding.sourceId && s.revision === binding.revision && s.sha256 === binding.sha256))) throw new Error("The returned case is not bound to this run and original PDF");
        step.disposition = result.duplicate || result.replayed ? "existing" : "created";
        step.extractionStatus = detail.extraction.status;
        step.supplierId = detail.candidate?.supplierId ?? null;
        step.parser = detail.sources.find(s => s.kind === "invoice" && s.sha256 === entry.sha256)?.parser?.provider ?? null;
        step.exceptions = detail.exceptions.map(e => e.code);
        step.status = "complete";
      } catch (error) { step.status = "failed"; step.error = errorMessage(error); }
      step.completedAt = Date.now();
      await persist();
    }
    job!.status = job!.steps.some(s => s.status === "failed") ? "failed" : "complete";
    job!.completedAt = Date.now();
    job!.error = job!.status === "failed" ? "Some originals could not complete. Review their errors and Start to retry only unfinished documents." : null;
    await persist();
  };
  const begin = async () => {
    await initialize;
    if (work || job?.status === "complete") return snapshot()!;
    await acquireLock();
    try {
      if (!job) job = { id, runId: options.runId, status: "running", startedAt: Date.now(), updatedAt: Date.now(), completedAt: null, error: null, counts: { total: entries.length, queued: entries.length, parsing: 0, importing: 0, complete: 0, failed: 0 }, steps: entries.map(e => ({ file: e.file, sha256: e.sha256, invoiceNumber: e.invoiceNumber, status: "queued", startedAt: null, completedAt: null, caseId: null, disposition: null, extractionStatus: null, supplierId: null, parser: null, exceptions: [], error: null })) };
      else {
        job.status = "running"; job.completedAt = null; job.error = null;
        for (const step of job.steps) if (step.status !== "complete") { step.status = "queued"; step.error = null; step.completedAt = null; }
      }
      await persist();
      work = run().catch(async error => {
        job!.status = "failed"; job!.completedAt = Date.now(); job!.error = errorMessage(error);
        // If storage itself failed, retain the failure in memory for status polling.
        await persist().catch(() => {});
      }).finally(async () => { await unlink(lockFile).catch(() => {}); work = null; });
      return snapshot()!;
    } catch (error) { await unlink(lockFile).catch(() => {}); throw error; }
  };
  return {
    start() { if (starting) return starting; starting = begin().finally(() => { starting = null; }); return starting; },
    async status() { await initialize; return snapshot(); },
    async waitForIdle() { await initialize; if (starting) await starting; if (work) await work; return snapshot(); },
  };
}
