import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const intakeProgressSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  status: z.enum(["parsing", "ingesting", "complete", "failed"]),
  startedAt: z.number(), updatedAt: z.number(), completedAt: z.number().nullable(),
  caseId: z.string().nullable(), error: z.string().nullable(), parser: z.literal("LlamaParse").nullable(),
}).strict();
export type IntakeProgress = z.infer<typeof intakeProgressSchema>;
const keySchema = intakeProgressSchema.shape.idempotencyKey;
const isMissing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

/** Observes existing intake work; this store never calls a parser or changes a case itself. */
export function createIntakeProgress(directory: string) {
  const root = path.join(directory, "intake-progress");
  const records = new Map<string, IntakeProgress>();
  const writes = new Map<string, Promise<void>>();
  const filename = (key: string) => path.join(root, `${createHash("sha256").update(key).digest("hex")}.json`);
  const save = async (record: IntakeProgress) => {
    records.set(record.idempotencyKey, record);
    const previous = writes.get(record.idempotencyKey) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const file = filename(record.idempotencyKey), temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      try { await rename(temporary, file); }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    });
    writes.set(record.idempotencyKey, task);
    await task;
  };
  const status = async (rawKey: string): Promise<IntakeProgress | null> => {
    const key = keySchema.parse(rawKey), memory = records.get(key);
    if (memory) return structuredClone(memory);
    let handle;
    try { handle = await open(filename(key), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    let record: IntakeProgress;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16384) throw new Error("Invalid private intake progress record");
      record = intakeProgressSchema.parse(JSON.parse(await handle.readFile("utf8")));
      if (record.idempotencyKey !== key) throw new Error("Intake progress request identity differs");
    } finally { await handle.close(); }
    // No work owned by this process can still be running in a cold record.
    if (record.status === "parsing" || record.status === "ingesting") {
      record = { ...record, status: "failed", updatedAt: Date.now(), completedAt: Date.now(), error: "The server stopped before this upload completed. Retry with the same request key to recover it." };
      await save(record);
    } else records.set(key, record);
    return structuredClone(record);
  };
  const update = async (key: string, change: Partial<IntakeProgress>) => {
    const current = await status(key);
    if (!current) throw new Error("Intake progress has no matching upload");
    const record = { ...current, ...change, updatedAt: Date.now() };
    await save(record);
  };
  return {
    status,
    async parse<T>(rawKey: string, operation: () => Promise<T>): Promise<T> {
      const key = keySchema.parse(rawKey), previous = await status(key);
      // Completed receipts remain truthful if an idempotent replay is rejected for a different payload.
      const retained = previous?.status === "complete";
      if (!retained) {
        const now = Date.now();
        await save({ idempotencyKey: key, status: "parsing", startedAt: now, updatedAt: now, completedAt: null, caseId: null, error: null, parser: null });
      }
      try {
        const result = await operation();
        if (!retained) await update(key, { status: "ingesting" });
        return result;
      } catch (error) {
        if (!retained) await update(key, { status: "failed", completedAt: Date.now(), error: "PDF parsing could not complete. Review the upload response and retry with the same request key." });
        throw error;
      }
    },
    async ingest<T extends { caseId: string }>(rawKey: string, operation: () => Promise<T>): Promise<T> {
      const key = keySchema.parse(rawKey), previous = await status(key);
      // Prepared packets can be ingested directly without an HTTP parse step.
      // Observe that real ingestion without inventing a preceding parsing stage.
      if (!previous) {
        const now = Date.now();
        await save({ idempotencyKey: key, status: "ingesting", startedAt: now, updatedAt: now, completedAt: null, caseId: null, error: null, parser: null });
      }
      const retained = previous?.status === "complete";
      try {
        const result = await operation();
        await update(key, { status: "complete", completedAt: Date.now(), caseId: result.caseId, error: null });
        return result;
      } catch (error) {
        if (!retained) await update(key, { status: "failed", completedAt: Date.now(), error: "The parsed upload could not be saved as a case. Review the upload response and retry with the same request key." });
        throw error;
      }
    },
  };
}
