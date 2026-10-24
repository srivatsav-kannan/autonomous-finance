import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ dir: "", bills: [] as any[], events: [] as any[], runs: [] as any[], tasks: {} as Record<string, any> }));
vi.mock("../core/kernel-client", () => ({
  api: { ap: { bills: "bills" }, payments: { intents: "intents" }, asks: { list: "asks" }, ledger: { trialBalance: "tb", verifyChain: "chain" }, observe: { violations: "violations", agentRuns: "runs" }, admin: { eventsOfType: "events" }, tasks: { get: "task" } },
  convex: () => ({ query: async (ref: string, args: any) => ref === "bills" ? state.bills : ref === "events" ? state.events : ref === "runs" ? state.runs : ref === "task" ? state.tasks[args.taskId] : ref === "chain" ? { ok: true } : [] }),
}));
vi.mock("../world/scenario", () => ({ runDir: () => state.dir, memoryDir: () => state.dir }));
vi.mock("../memory/store", () => ({ MemoryStore: class { async log() { return []; } async list() { return []; } } }));
import { scoreRun } from "./score";
import { generateWorld } from "../world/generate";

function bill(documentEventId: string, status: string, exceptions: string[] = []) {
  return { invoiceNumber: "1001", vendor: "v", documentEventId, status, exceptions, totalCents: 10000, lines: [{ amountCents: 10000 }] };
}
function answerKey(documentExternalId: string | undefined = "duplicate") {
  fs.writeFileSync(path.join(state.dir, "answer-key.json"), JSON.stringify({ errors: [{ id: "e-dup", type: "duplicate_exact", subject: { kind: "invoice", vendor: "v", ref: "INV-1001", documentExternalId }, amountAtRiskCents: 10000 }], decoys: [] }));
}

beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), "duplicate-score-"));
  state.bills = []; state.runs = []; state.tasks = {};
  state.events = [{ _id: "event-original", externalId: "original" }, { _id: "event-duplicate", externalId: "duplicate" }];
  answerKey();
  fs.writeFileSync(path.join(state.dir, "world.json"), "[]");
  fs.writeFileSync(path.join(state.dir, "truth.json"), JSON.stringify(generateWorld({ seed: 7, storeCount: 1, start: "2026-01-01", days: 1, plantErrors: false }).truth));
});
afterEach(() => fs.rmSync(state.dir, { recursive: true, force: true }));

describe("duplicate document scoring", () => {
  it("accepts the original approval and credits the duplicate rejection", async () => {
    state.bills = [bill("event-original", "approved"), bill("event-duplicate", "rejected", ["duplicate_invoice: same invoice"])];
    expect((await scoreRun("test")).errors[0]).toMatchObject({ caught: true, how: "rejected as duplicate" });
  });
  it("fails when the duplicate was approved even if the original was rejected", async () => {
    state.bills = [bill("event-original", "rejected", ["duplicate_invoice: wrong row"]), bill("event-duplicate", "approved")];
    expect((await scoreRun("test")).errors[0]).toMatchObject({ caught: false, how: "duplicate was approved" });
  });
  it("does not credit rejection of another document", async () => {
    state.bills = [bill("event-original", "rejected", ["duplicate_invoice: wrong row"])];
    expect((await scoreRun("test")).errors[0]).toMatchObject({ caught: false, how: "never processed" });
  });
  it("matches a kernel duplicate block to that document's task", async () => {
    state.bills = [bill("event-original", "paid")];
    state.runs = [{ taskId: "task-duplicate", outcome: "rejected", summary: "kernel blocked duplicate: v invoice INV-1001 duplicates a bill", costMicros: 0 }];
    state.tasks["task-duplicate"] = { payload: { eventId: "event-duplicate" } };
    expect((await scoreRun("test")).errors[0]?.caught).toBe(true);
    state.tasks["task-duplicate"] = { payload: { eventId: "event-original" } };
    expect((await scoreRun("test")).errors[0]?.caught).toBe(false);
  });
  it("scores old answer keys with a separate rejected duplicate row", async () => {
    answerKey(undefined);
    // The default parameter supplies a value; explicitly omit it for a legacy key.
    const file = path.join(state.dir, "answer-key.json");
    const key = JSON.parse(fs.readFileSync(file, "utf8"));
    delete key.errors[0].subject.documentExternalId;
    fs.writeFileSync(file, JSON.stringify(key));
    state.bills = [bill("event-original", "paid"), bill("event-duplicate", "rejected", ["duplicate_invoice: same invoice"])];
    expect((await scoreRun("test")).errors[0]?.caught).toBe(true);
    state.bills.push(bill("event-third", "approved"));
    expect((await scoreRun("test")).errors[0]?.caught).toBe(false);
  });
  it("plants an exact duplicate with the same normalized number and explicit document identity", () => {
    const w = generateWorld({ seed: 7, storeCount: 3, start: "2026-01-01", days: 14, plantErrors: true });
    const error = w.answerKey.errors.find((e) => e.type === "duplicate_exact")!;
    const subject = error.subject as typeof error.subject & { documentExternalId?: string };
    expect(subject.documentExternalId).toBeDefined();
    const resend = w.events.find((e) => e.externalId === subject.documentExternalId)!;
    expect(resend).toBeDefined();
    const original = w.events.find((e) => e.externalId === `doc-${subject.vendor}-${subject.ref.replace("NCD-", "NCD")}`);
    expect(original).toBeDefined();
  });
});
