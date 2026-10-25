// Evidence-only observer: call the original convexTest and retain final DB state.
// It changes no application function, fixture, assertion or database write.
import { afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import schema from "../../../convex/schema";
const registry = vi.hoisted(() => ({ instances: [] }));
vi.mock("convex-test", async importOriginal => {
  const original = await importOriginal();
  return { ...original, convexTest: (...args) => {
    const instance = original.convexTest(...args);
    registry.instances.push(instance);
    return instance;
  } };
});
const output = process.env.AP_REVIEW_CAPTURE_DIR;
const selections = JSON.parse(readFileSync(new URL("selection.json", import.meta.url), "utf8"));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const tables = Object.keys(schema.tables).filter(t => t.startsWith("ap") || [
  "journalEntries", "balances", "periods", "demoBills", "demoCredits", "demoVersions",
  "demoCommands", "demoTransactions", "demoObservations", "demoReconciliationProposals",
].includes(t));
beforeEach(() => { registry.instances.length = 0; });
afterEach(async context => {
  const file = relative(process.cwd(), context.task.file.filepath);
  const chosen = selections.find(s => s.file === file && context.task.name.includes(s.titleContains));
  if (!chosen) return;
  if (!registry.instances.length) throw new Error("Selected test created no observable Convex instance");
  const key = `${chosen.caseId}-${hash(file + ":" + context.task.name).slice(0, 12)}`;
  const snapshots = [];
  for (const instance of registry.instances) {
    snapshots.push(await instance.run(async ctx => {
      const data = {};
      for (const table of tables) data[table] = await ctx.db.query(table).collect();
      return data;
    }));
  }
  mkdirSync(output, { recursive: true });
  const record = {
    format: "ap97-component-db-observation-v1", caseId: chosen.caseId,
    sourceRevision: revision, testFile: file, testFileSha256: hash(readFileSync(resolve(file))),
    testName: context.task.name,
    classification: "Actual local in-memory Convex DB after an existing component scenario; simulated identities and test-owned fixtures. Not an independent reviewer, real PDF/parser run, real provider or latest live workflow.",
    warnings: ["Some scenarios deliberately seed or mutate rows; inspect original test source to distinguish from public operations.",
      "Names may describe expected behavior; names/test status do not prove the recorded economics.",
      "Table snapshot is final state; retained journal/action/decision rows preserve available sequence, not every intermediate read.",
      "Provider scope may say Increase after a fixture promotion; no real Increase/QBO call is asserted."],
    capturedTables: tables, snapshots,
  };
  writeFileSync(resolve(output, `${key}.json`), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
});
