import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { APCaseDetail, APIntake } from "../contracts";
import type { ApexCorpusEntry } from "./apex-corpus";
import { createApexProcessing, type ApexProcessingOptions } from "./apex-processing";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "apex-processing-")); directories.push(dir);
  const bytes = [new TextEncoder().encode("%PDF-first"), new TextEncoder().encode("%PDF-second")];
  const entries = bytes.map((b, i) => ({ file: `${i}.pdf`, sha256: createHash("sha256").update(b).digest("hex"), invoiceNumber: `INVOICE-${i}` }) as ApexCorpusEntry);
  const parseInputs: Parameters<ApexProcessingOptions["parseUploads"]>[0][] = [];
  const options: ApexProcessingOptions = {
    runId: "fresh-demo-run", corpus: { entries }, stateFile: path.join(dir, "processing.json"),
    loadOriginal: async e => bytes[entries.indexOf(e)]!,
    parseUploads: async input => { parseInputs.push(input); return { idempotencyKey: input.idempotencyKey, documents: [{ name: input.uploads[0]!.name }] } as APIntake; },
    ingest: async input => ({ caseId: `case-${input.documents[0]!.name}` }),
    detail: async caseId => {
      const e = entries.find(row => caseId === `case-${row.file}`)!;
      const source = { sourceId: e.file, revision: 1, sha256: e.sha256, kind: "invoice", parser: { provider: "local-poppler-pdftotext" } };
      return { caseId, runId: "fresh-demo-run", sources: [source], currentSourceBindings: [source], extraction: { status: "complete" }, candidate: { supplierId: "apex-v041" }, exceptions: [{ code: "business_plan_required" }] } as unknown as APCaseDetail;
    },
  };
  return { options, entries, parseInputs };
}

describe("live APEX document processing", () => {
  it("shows real parse/import stages, coalesces Start, and creates no work before Start", async () => {
    const { options, parseInputs } = await fixture(), parsed = deferred(), imported = deferred();
    const parse = options.parseUploads, ingest = options.ingest;
    options.parseUploads = async input => { const value = await parse(input); await parsed.promise; return value; };
    options.ingest = async input => { await imported.promise; return ingest(input); };
    const worker = createApexProcessing(options);
    expect(await worker.status()).toBeNull(); expect(parseInputs).toHaveLength(0);
    const [one, two] = await Promise.all([worker.start(), worker.start()]); expect(one.id).toBe(two.id);
    await vi.waitFor(() => expect(parseInputs).toHaveLength(1));
    expect((await worker.status())?.counts).toMatchObject({ parsing: 1, queued: 1, complete: 0 });
    parsed.resolve();
    await vi.waitFor(async () => expect((await worker.status())?.counts.importing).toBe(1));
    expect(parseInputs).toHaveLength(1);
    imported.resolve();
    const finished = await worker.waitForIdle();
    expect(finished?.status).toBe("complete"); expect(finished?.counts.complete).toBe(2);
    expect(finished?.steps[0]).toMatchObject({ caseId: "case-0.pdf", disposition: "created", supplierId: "apex-v041", extractionStatus: "complete", parser: "local-poppler-pdftotext", exceptions: ["business_plan_required"] });
    expect(await worker.start()).toEqual(finished); expect(parseInputs).toHaveLength(2);
    expect((await stat(options.stateFile)).mode & 0o077).toBe(0);
  });

  it("retains failed work and retries only incomplete files using the same request key", async () => {
    const { options, parseInputs } = await fixture();
    const ingest = options.ingest; let fail = true;
    options.ingest = async input => { if (fail && input.documents[0]?.name === "0.pdf") throw new Error("Database unavailable"); return ingest(input); };
    const worker = createApexProcessing(options); await worker.start();
    const failed = await worker.waitForIdle();
    expect(failed?.counts).toMatchObject({ failed: 1, complete: 1 });
    expect(failed?.steps[0]?.error).toBe("Database unavailable");
    fail = false; await worker.start();
    const finished = await worker.waitForIdle();
    expect(finished?.status).toBe("complete"); expect(parseInputs).toHaveLength(3);
    expect(parseInputs[0]?.idempotencyKey).toBe(parseInputs[2]?.idempotencyKey);
    expect(parseInputs[1]?.uploads[0]?.name).toBe("1.pdf");
  });

  it("rejects changed bytes before parsing and reports an error beside that original", async () => {
    const { options, parseInputs } = await fixture();
    const load = options.loadOriginal;
    options.loadOriginal = async e => e.file === "0.pdf" ? new Uint8Array([1, 2, 3]) : load(e);
    const worker = createApexProcessing(options); await worker.start();
    const finished = await worker.waitForIdle();
    expect(finished?.steps[0]?.error).toContain("original PDF changed");
    expect(finished?.steps[0]?.caseId).toBeNull(); expect(parseInputs).toHaveLength(1);
    expect(finished?.steps[1]?.status).toBe("complete");
  });

  it("resumes an interrupted persisted job without repeating completed documents", async () => {
    const { options, parseInputs } = await fixture();
    const first = createApexProcessing(options); await first.start(); await first.waitForIdle();
    const state = JSON.parse(await readFile(options.stateFile, "utf8"));
    state.job.status = "running"; state.job.completedAt = null; state.job.steps[0].status = "importing";
    await writeFile(options.stateFile, JSON.stringify(state), { mode: 0o600 });
    options.ingest = async input => ({ caseId: `case-${input.documents[0]!.name}`, replayed: true });
    const recovered = createApexProcessing(options);
    expect((await recovered.status())?.status).toBe("interrupted");
    await recovered.start(); const finished = await recovered.waitForIdle();
    expect(finished?.status).toBe("complete"); expect(parseInputs).toHaveLength(3);
    expect(parseInputs[2]?.idempotencyKey).toBe(parseInputs[0]?.idempotencyKey);
    expect(finished?.steps[0]?.disposition).toBe("existing");
  });

  it("prevents a second worker taking the same state file while processing is active", async () => {
    const { options, parseInputs } = await fixture(), gate = deferred(), parse = options.parseUploads;
    options.parseUploads = async input => { const value = await parse(input); await gate.promise; return value; };
    const one = createApexProcessing(options); await one.start();
    await vi.waitFor(() => expect(parseInputs).toHaveLength(1));
    const two = createApexProcessing(options);
    await expect(two.start()).rejects.toThrow("already owns this run");
    expect(parseInputs).toHaveLength(1); gate.resolve(); await one.waitForIdle();
  });

  it("refuses a saved job from a different run", async () => {
    const { options } = await fixture(); const first = createApexProcessing(options);
    await first.start(); await first.waitForIdle();
    const otherRun = createApexProcessing({ ...options, runId: "another-demo" });
    await expect(otherRun.status()).rejects.toThrow("different run or source corpus");
  });
});
