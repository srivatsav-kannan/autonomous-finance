import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntakeProgress } from "../../src/ap-system/intake-progress";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() { const directory = await mkdtemp(path.join(tmpdir(), "intake-progress-")); directories.push(directory); return { directory, progress: createIntakeProgress(directory) }; }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };

describe("connected intake progress", () => {
  it("observes actual parsing and ingestion without initiating either operation", async () => {
    const { directory, progress } = await fixture(), gate = deferred();
    expect(await progress.status("request/one")).toBeNull();
    const parse = progress.parse("request/one", async () => { await gate.promise; return "parsed"; });
    await vi.waitFor(async () => expect((await progress.status("request/one"))?.status).toBe("parsing"));
    gate.resolve(); expect(await parse).toBe("parsed");
    expect((await progress.status("request/one"))?.status).toBe("ingesting");
    expect(await progress.ingest("request/one", async () => ({ caseId: "case-1" }))).toEqual({ caseId: "case-1" });
    const saved = await progress.status("request/one");
    expect(saved).toMatchObject({ status: "complete", caseId: "case-1", parser: null, error: null });
    expect(saved?.completedAt).toBeGreaterThanOrEqual(saved!.startedAt);
    const files = await readdir(path.join(directory, "intake-progress"));
    expect(files).toHaveLength(1); expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect((await stat(path.join(directory, "intake-progress", files[0]!))).mode & 0o077).toBe(0);
    expect(await createIntakeProgress(directory).status("request/one")).toEqual(saved);
  });

  it("shows parser failure without persisting provider secrets or raw responses", async () => {
    const { directory, progress } = await fixture();
    const failure = new Error("Authorization Bearer SECRET_PRIVATE_VALUE provider response");
    await expect(progress.parse("failed-parse", async () => { throw failure; })).rejects.toBe(failure);
    expect(await progress.status("failed-parse")).toMatchObject({ status: "failed", caseId: null, parser: null });
    expect((await progress.status("failed-parse"))?.error).toContain("PDF parsing");
    const file = (await readdir(path.join(directory, "intake-progress")))[0]!;
    expect(await readFile(path.join(directory, "intake-progress", file), "utf8")).not.toContain("SECRET_PRIVATE_VALUE");
  });

  it("records ingest rejection and allows the durable request key to retry", async () => {
    const { progress } = await fixture();
    await progress.parse("retry", async () => ({}));
    await expect(progress.ingest("retry", async () => { throw new Error("stale revision"); })).rejects.toThrow("stale revision");
    expect((await progress.status("retry"))?.error).toContain("could not be saved");
    await progress.parse("retry", async () => ({}));
    await progress.ingest("retry", async () => ({ caseId: "case-recovered" }));
    expect(await progress.status("retry")).toMatchObject({ status: "complete", caseId: "case-recovered", error: null });
  });

  it("reports unfinished persisted work as interrupted after a process restart", async () => {
    const { directory, progress } = await fixture();
    await progress.parse("interrupted", async () => ({}));
    const restarted = createIntakeProgress(directory);
    expect(await restarted.status("interrupted")).toMatchObject({ status: "failed", caseId: null });
    expect((await restarted.status("interrupted"))?.error).toContain("server stopped");
    await restarted.parse("interrupted", async () => ({}));
    await restarted.ingest("interrupted", async () => ({ caseId: "case-after-restart" }));
    expect((await restarted.status("interrupted"))?.status).toBe("complete");
  });

  it("keeps a successful result when a conflicting reuse of its request key is rejected", async () => {
    const { progress } = await fixture();
    await progress.parse("complete", async () => ({}));
    await progress.ingest("complete", async () => ({ caseId: "original-case" }));
    await expect(progress.parse("complete", async () => { throw new Error("idempotency conflict"); })).rejects.toThrow("idempotency conflict");
    expect(await progress.status("complete")).toMatchObject({ status: "complete", caseId: "original-case", error: null });
  });

  it("supports directly ingesting prepared packets without a previous parse record", async () => {
    const { progress } = await fixture(), gate = deferred();
    const ingest = progress.ingest("prepared-packet", async () => { await gate.promise; return { caseId: "prepared-case", replayed: false }; });
    await vi.waitFor(async () => expect((await progress.status("prepared-packet"))?.status).toBe("ingesting"));
    gate.resolve();
    expect(await ingest).toEqual({ caseId: "prepared-case", replayed: false });
    expect(await progress.status("prepared-packet")).toMatchObject({ status: "complete", caseId: "prepared-case", parser: null, error: null });
  });
});
