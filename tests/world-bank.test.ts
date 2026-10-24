import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorldBank, type OutgoingPayment } from "../src/world/bank";

const location = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/world/scenario", () => ({ runDir: (runId: string) => `${location.root}/${runId}` }));

type Request = Omit<OutgoingPayment, "bankRef">;
const request: Request = {
  intentId: "intent-1", payee: "vendor-1", amountCents: 5000,
  bank: "Bank One", accountLast4: "1234", sentOn: "2026-01-14",
};
const require = createRequire(import.meta.url);
const loader = require.resolve("tsx");
const bankSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/world/bank.ts");
let temporary: string;
let worker: string;
const children = new Set<ChildProcess>();

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "world-bank-test-"));
  location.root = path.join(temporary, "var", "runs");
  worker = path.join(temporary, "worker.mjs");
  fs.writeFileSync(worker, `
    import fs from "node:fs";
    import { WorldBank } from ${JSON.stringify(pathToFileURL(bankSource).href)};
    const input = JSON.parse(process.argv[2]);
    process.stdout.write("READY\\n");
    if (input.gate) while (!fs.existsSync(input.gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    const link = fs.linkSync;
    const write = fs.writeFileSync;
    if (input.mode === "crash-during-write") fs.writeFileSync = (fd) => { write(fd, "{"); process.kill(process.pid, "SIGKILL"); };
    if (input.mode === "crash-before-link") fs.linkSync = () => process.kill(process.pid, "SIGKILL");
    if (input.mode === "crash-after-link") fs.linkSync = (...args) => { link(...args); process.kill(process.pid, "SIGKILL"); };
    const bank = new WorldBank("run");
    try {
      const value = input.mode === "lookup" ? bank.get(input.intentId) : input.payments.map(p => bank.send(p));
      process.stdout.write(JSON.stringify({ ok: true, value }) + "\\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + "\\n");
      process.exitCode = 2;
    }
  `);
});

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function receiptFile(intentId = request.intentId): string {
  const key = createHash("sha256").update(intentId).digest("hex");
  return path.join(location.root, "run", "bank-outbox", `${key}.json`);
}

function runWorker(input: unknown) {
  return spawnSync(process.execPath, ["--import", loader, worker, JSON.stringify(input)], {
    cwd: temporary, encoding: "utf8", timeout: 15_000,
  });
}

function concurrentWorker(input: unknown) {
  const child = spawn(process.execPath, ["--import", loader, worker, JSON.stringify(input)], { cwd: temporary });
  children.add(child);
  let stdout = "";
  let stderr = "";
  let markReady!: () => void;
  let failReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
  const finished = new Promise<{ code: number | null; output: { ok: boolean; value?: OutgoingPayment[]; error?: string } }>((resolve, reject) => {
    child.stdout!.on("data", (data) => {
      stdout += data;
      if (stdout.includes("READY\n")) markReady();
    });
    child.stderr!.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { failReady(error); reject(error); });
    child.on("close", (code) => {
      children.delete(child);
      if (!stdout.includes("READY\n")) failReady(new Error(stderr || "worker failed before ready"));
      try {
        resolve({ code, output: JSON.parse(stdout.trim().split("\n").at(-1)!) });
      } catch {
        reject(new Error(`worker failed (${code}): ${stderr || stdout}`));
      }
    });
  });
  return { ready, finished };
}

describe("WorldBank durable receipts", () => {
  it("replays an accepted command across instances and processes and returns only next-day debits", () => {
    const receipt = new WorldBank("run").send(request);
    expect(receipt.bankRef).toMatch(/^ACH-/);
    expect(new WorldBank("run").get(request.intentId)).toEqual(receipt);
    expect(new WorldBank("run").send(request)).toEqual(receipt);
    expect(new WorldBank("run").debitsFor("2026-01-14")).toEqual([]);
    expect(new WorldBank("run").debitsFor("2026-01-15")).toEqual([receipt]);
    const restarted = runWorker({ mode: "lookup", intentId: request.intentId });
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(JSON.parse(restarted.stdout.trim().split("\n").at(-1)!)).toEqual({ ok: true, value: receipt });
    expect(new WorldBank("run").all()).toEqual([receipt]);
  });

  it.each([
    ["payee", "other-vendor"], ["amountCents", 5001], ["bank", "Other Bank"],
    ["accountLast4", "5678"], ["sentOn", "2026-01-15"],
  ])("rejects replay when %s changes without changing the original receipt", (field, value) => {
    const bank = new WorldBank("run");
    const receipt = bank.send(request);
    expect(() => bank.send({ ...request, [field]: value })).toThrow(/idempotency conflict/);
    expect(bank.get(request.intentId)).toEqual(receipt);
    expect(bank.all()).toEqual([receipt]);
  });

  it("reads legacy outbox data without rewriting it and deduplicates matching old/new records", () => {
    const dir = path.join(location.root, "run");
    fs.mkdirSync(dir, { recursive: true });
    const legacy = { ...request, bankRef: "ACH-20260114-0001" };
    const text = JSON.stringify([legacy], null, 4);
    fs.writeFileSync(path.join(dir, "bank-outbox.json"), text);
    const bank = new WorldBank("run");
    expect(bank.send(request)).toEqual(legacy);
    expect(() => bank.send({ ...request, amountCents: 1 })).toThrow(/idempotency conflict/);
    const second = bank.send({ ...request, intentId: "new-intent" });
    fs.writeFileSync(receiptFile(), JSON.stringify(legacy));
    expect(bank.get(request.intentId)).toEqual(legacy);
    expect(bank.all()).toEqual([legacy, second]);
    expect(bank.debitsFor("2026-01-15")).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, "bank-outbox.json"), "utf8")).toBe(text);
  });

  it("fails closed on corrupt legacy data and conflicting legacy/new receipts", () => {
    const bank = new WorldBank("run");
    const receipt = bank.send(request);
    const legacyFile = path.join(location.root, "run", "bank-outbox.json");
    fs.writeFileSync(legacyFile, "{incomplete");
    expect(() => bank.send({ ...request, intentId: "another" })).toThrow();
    expect(fs.readFileSync(legacyFile, "utf8")).toBe("{incomplete");
    fs.writeFileSync(legacyFile, JSON.stringify([{ ...receipt, amountCents: 1 }]));
    expect(() => bank.get(request.intentId)).toThrow(/idempotency conflict/);
    expect(() => bank.all()).toThrow(/idempotency conflict/);
    expect(fs.readFileSync(receiptFile(), "utf8")).toContain('"amountCents": 5000');
  });

  it("rejects a receipt whose stored intent does not match its filename", () => {
    const bank = new WorldBank("run");
    const receipt = bank.send(request);
    fs.writeFileSync(receiptFile(), JSON.stringify({ ...receipt, intentId: "wrong-intent" }));
    expect(() => bank.get(request.intentId)).toThrow(/does not match its intent key/);
    expect(() => bank.all()).toThrow(/does not match its intent key/);
  });

  it.each(["crash-before-link", "crash-after-link"])("recovers after a process is killed at %s", (mode) => {
    const killed = runWorker({ mode, payments: [request] });
    expect(killed.error).toBeUndefined();
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    const bank = new WorldBank("run");
    expect(bank.all()).toHaveLength(mode === "crash-after-link" ? 1 : 0);
    expect(fs.readdirSync(path.dirname(receiptFile())).some((f) => f.endsWith(".tmp"))).toBe(true);
    const receipt = bank.send(request);
    expect(bank.all()).toEqual([receipt]);
    expect(bank.get(request.intentId)).toEqual(receipt);
    expect(bank.send(request)).toEqual(receipt);
  });

  it("keeps prior receipts intact when killed during a different receipt's write", () => {
    const bank = new WorldBank("run");
    const prior = bank.send(request);
    const next = { ...request, intentId: "interrupted-intent" };
    const killed = runWorker({ mode: "crash-during-write", payments: [next] });
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    expect(bank.all()).toEqual([prior]);
    expect(bank.get(next.intentId)).toBeUndefined();
    const recovered = bank.send(next);
    expect(bank.all()).toEqual(expect.arrayContaining([prior, recovered]));
    expect(bank.all()).toHaveLength(2);
  });

  it("does not lose distinct sends or duplicate a shared intent under concurrent processes", async () => {
    const gate = path.join(temporary, "go");
    const workers = Array.from({ length: 6 }, (_, i) => concurrentWorker({
      gate, payments: [request, { ...request, intentId: `independent-${i}` }],
    }));
    await Promise.all(workers.map((w) => w.ready));
    fs.writeFileSync(gate, "go");
    const results = await Promise.all(workers.map((w) => w.finished));
    expect(results.every((r) => r.code === 0 && r.output.ok)).toBe(true);
    const bank = new WorldBank("run");
    const all = bank.all();
    expect(all).toHaveLength(7);
    expect(new Set(all.map((p) => p.bankRef)).size).toBe(7);
    expect(all.filter((p) => p.intentId === request.intentId)).toHaveLength(1);
    expect(new Set(results.map((r) => r.output.value![0]!.bankRef)).size).toBe(1);
    expect(bank.debitsFor("2026-01-15")).toHaveLength(7);
  }, 20_000);

  it("allows only one command to win when concurrent processes reuse an intent with different amounts", async () => {
    const gate = path.join(temporary, "go");
    const workers = [5000, 6000].map((amountCents) => concurrentWorker({
      gate, payments: [{ ...request, amountCents }],
    }));
    await Promise.all(workers.map((w) => w.ready));
    fs.writeFileSync(gate, "go");
    const results = await Promise.all(workers.map((w) => w.finished));
    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    expect(results.filter((r) => r.code === 2 && /idempotency conflict/.test(r.output.error!))).toHaveLength(1);
    const all = new WorldBank("run").all();
    expect(all).toHaveLength(1);
    expect([5000, 6000]).toContain(all[0]!.amountCents);
  }, 20_000);
});
