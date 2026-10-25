import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateWorld } from "../world/generate";

const state = vi.hoisted(() => ({ dir: "", bills: [] as any[], events: [] as any[], runs: [] as any[], tb: [] as any[] }));
vi.mock("../core/kernel-client", () => ({
  api: { ap: { bills: "bills" }, payments: { intents: "intents" }, asks: { list: "asks" }, ledger: { trialBalance: "tb", verifyChain: "chain" }, observe: { violations: "violations", agentRuns: "runs" }, admin: { eventsOfType: "events" }, tasks: { get: "task" } },
  convex: () => ({ query: async (ref: string) => ref === "bills" ? state.bills : ref === "events" ? state.events : ref === "runs" ? state.runs : ref === "tb" ? state.tb : ref === "chain" ? { ok: true } : [] }),
}));
vi.mock("../world/scenario", () => ({ runDir: () => state.dir, memoryDir: () => state.dir }));
vi.mock("../memory/store", () => ({ MemoryStore: class { async log() { return []; } async list() { return []; } } }));
import { formatReport, scoreRun } from "./score";

beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), "books-score-"));
  const world = generateWorld({ seed: 1, storeCount: 3, start: "2026-01-01", days: 14, plantErrors: false });
  state.events = world.events.filter((e) => e.type === "document.received").map((e) => ({ ...e, _id: `event-${e.externalId}` }));
  state.bills = world.truth.accounting!.obligations.map((o) => ({
    _id: `bill-${o.documentExternalId}`, documentEventId: `event-${o.documentExternalId}`,
    vendor: o.vendor, invoiceNumber: o.invoiceNumber, totalCents: o.amountCents,
    lines: [{ amountCents: o.amountCents }], entryId: `entry-${o.documentExternalId}`, status: "approved", exceptions: [],
  }));
  state.tb = Object.entries(world.truth.accounting!.netByAccount).map(([code, net]) => ({ code, net }));
  state.runs = [];
  fs.writeFileSync(path.join(state.dir, "truth.json"), JSON.stringify(world.truth));
  fs.writeFileSync(path.join(state.dir, "world.json"), JSON.stringify(world.events));
  fs.writeFileSync(path.join(state.dir, "answer-key.json"), JSON.stringify(world.answerKey));
});
afterEach(() => fs.rmSync(state.dir, { recursive: true, force: true }));

describe("scoreRun accounting report", () => {
  it("reports missing invoices as failed even when all seven original book metrics are correct", async () => {
    const truth = JSON.parse(fs.readFileSync(path.join(state.dir, "truth.json"), "utf8"));
    const omitted = truth.accounting.obligations.filter((o: any) => o.expenseAccount !== "5200").slice(0, 21);
    for (const o of omitted) {
      state.bills = state.bills.filter((b) => b.documentEventId !== `event-${o.documentExternalId}`);
      state.tb.find((a) => a.code === o.expenseAccount)!.net -= o.amountCents;
      state.tb.find((a) => a.code === "2000")!.net += o.amountCents;
      state.runs.push({ outcome: "unreadable", costMicros: 0 });
    }
    for (const code of ["4000", "4010", "4020", "2300", "2200", "5100", "5200"]) {
      expect(state.tb.find((a) => a.code === code)!.net).toBe(truth.accounting.netByAccount[code]);
    }
    expect(state.tb.reduce((sum, a) => sum + a.net, 0)).toBe(0);
    const report = await scoreRun("test");
    expect(report.coverage).toMatchObject({ invoiceDocuments: 63, billsRecorded: 42, unreadable: 21, unresolvedDocuments: 21 });
    expect(report.booksStatus.status).toBe("failed");
    expect(report.books.some((b) => b.metric.startsWith("2000") && b.diff !== 0)).toBe(true);
    expect(formatReport(report)).toContain("Book correctness: FAILED");
  });
  it("passes complete accruals without requiring payment before its due date", async () => {
    const report = await scoreRun("test");
    expect(report.booksStatus).toEqual({ status: "passed", reasons: [] });
    expect(report.coverage.unresolvedDocuments).toBe(0);
  });
  it("never claims complete books for an old truth file or a corrupted bank file", async () => {
    fs.writeFileSync(path.join(state.dir, "bank-outbox.json"), "broken JSON");
    expect((await scoreRun("test")).booksStatus.status).toBe("incomplete");
    fs.rmSync(path.join(state.dir, "bank-outbox.json"));
    const truthPath = path.join(state.dir, "truth.json");
    const truth = JSON.parse(fs.readFileSync(truthPath, "utf8")); delete truth.accounting;
    fs.writeFileSync(truthPath, JSON.stringify(truth));
    const report = await scoreRun("test");
    expect(report.books).toHaveLength(7);
    expect(report.books.every((b) => b.diff === 0)).toBe(true);
    expect(report.booksStatus.status).toBe("incomplete");
    expect(formatReport(report)).toContain("Book correctness: INCOMPLETE");
  });
});
