import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { commandRequestHash, type BankCommand, type BankScope } from "../contracts.js";
import { openFakeBank, type FakeBankOptions } from "./fake.js";

const scope: BankScope = { organizationId: "org-demo", runId: "run-7", provider: "fake", environment: "local", accountId: "operating-usd" };
const folders: string[] = [];
const closers = new Set<() => void>();
function options(overrides: Partial<FakeBankOptions> = {}): FakeBankOptions {
  const folder = mkdtempSync(join(tmpdir(), "fake-bank-test-")); folders.push(folder);
  return { path: join(folder, "bank.sqlite"), scope, seed: 7, ...overrides };
}
function open(config: FakeBankOptions) {
  const bank = openFakeBank(config); const close = bank.close;
  bank.close = () => { if (closers.delete(close)) close(); }; closers.add(close); return bank;
}
async function command(overrides: Partial<BankCommand> = {}): Promise<BankCommand> {
  const draft = { commandId: "command-1", scope, amountCents: 12_500, currency: "USD" as const, destination: { externalAccountId: "vendor-1", version: "beneficiary-v2" }, approvalVersion: "approved-v3", idempotencyKey: "ap-command-1", ...overrides };
  return { ...draft, requestHash: await commandRequestHash(draft) };
}
function child(path: string, cmd: BankCommand, mode = "submit"): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--import", "tsx", fileURLToPath(new URL("./__fixtures__/fake-bank-process.ts", import.meta.url)), path, Buffer.from(JSON.stringify(cmd)).toString("base64"), mode], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    process.stdout.on("data", (data) => { stdout += String(data); }); process.stderr.on("data", (data) => { stderr += String(data); });
    process.once("error", reject); process.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
afterEach(() => { for (const close of closers) close(); closers.clear(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe("persistent FakeBank", () => {
  it("keeps exactly one transfer under concurrent requests from independent processes", async () => {
    const config = options(); const bank = open(config); const cmd = await command();
    const results = await Promise.all(Array.from({ length: 8 }, () => child(config.path, cmd)));
    expect(results.map((result) => [result.code, result.code === 0 ? "" : result.stderr])).toEqual(Array(8).fill([0, ""]));
    expect(new Set(results.map((result) => JSON.parse(result.stdout).transferId)).size).toBe(1);
    expect(bank.harness.inspect().transfers).toHaveLength(1);
    expect(bank.harness.inspect().transactions).toHaveLength(1);
    expect(bank.harness.inspect().events).toHaveLength(1);
  }, 15_000);

  it("rejects changed amount, destination or approved version under an existing key", async () => {
    const bank = open(options()); const first = await bank.provider.createTransfer(await command());
    for (const overrides of [{ amountCents: 99 }, { destination: { externalAccountId: "attacker", version: "v2" } }, { approvalVersion: "new-version" }]) {
      await expect(bank.provider.createTransfer(await command(overrides))).rejects.toMatchObject({ errorClass: "idempotency_conflict" });
    }
    expect(await bank.provider.getTransfer(scope, first.id)).toEqual(first);
    expect(bank.harness.inspect().transfers).toHaveLength(1);
  });

  it("persists acceptance through lost response and an actual worker exit", async () => {
    const config = options({ faults: [{ operation: "createTransfer", call: 1, kind: "accept_then_lost_response" }] });
    let bank = open(config); const cmd = await command(); bank.close();
    const crashed = await child(config.path, cmd, "crash"); expect(crashed.code).toBe(23);
    bank = open(config); const prior = bank.harness.inspect().transfers[0]!;
    expect(prior).toBeDefined();
    expect(await bank.provider.createTransfer(cmd)).toEqual(prior);
    expect(bank.harness.inspect().transfers).toHaveLength(1);
    expect(bank.harness.inspect().calls.createTransfer).toBe(2);
  });

  it("reproduces IDs, clock, faults, lifecycle and signed events from the same seed", async () => {
    const snapshots = [];
    for (let run = 0; run < 2; run++) {
      const config = options({ webhookSecret: "deterministic-test-only-secret", faults: [{ operation: "createTransfer", call: 1, kind: "rate_limit", retryAfterMs: 3456 }] });
      let bank = open(config); const cmd = await command();
      await expect(bank.provider.createTransfer(cmd)).rejects.toMatchObject({ errorClass: "rate_limit", retryAfterMs: 3456, outcomeUnknown: false });
      bank.close(); bank = open(config);
      const transfer = await bank.provider.createTransfer(cmd); bank.harness.advanceTime(86_400_000);
      bank.harness.settle(transfer.id); bank.harness.advanceTime(86_400_000); bank.harness.returnTransfer(transfer.id);
      snapshots.push({ state: bank.harness.inspect(), deliveries: bank.harness.drainNotifications() });
    }
    expect(snapshots[0]).toEqual(snapshots[1]);
  });

  it("isolates scope on every read, write, notification and persisted datastore", async () => {
    const config = options({ webhookSecret: "private-test-secret" }); const bank = open(config);
    const transfer = await bank.provider.createTransfer(await command()); const other = { ...scope, accountId: "another-account" };
    await expect(bank.provider.getBalance(other)).rejects.toMatchObject({ errorClass: "authentication" });
    await expect(bank.provider.getTransfer(other, transfer.id)).rejects.toMatchObject({ errorClass: "authentication" });
    await expect(bank.provider.getTransaction(other, transfer.pendingTransactionId!)).rejects.toMatchObject({ errorClass: "authentication" });
    await expect(bank.provider.listTransactions(other)).rejects.toMatchObject({ errorClass: "authentication" });
    await expect(bank.events.listEvents(other)).rejects.toMatchObject({ errorClass: "authentication" });
    await expect(bank.provider.createTransfer(await command({ scope: other }))).rejects.toMatchObject({ errorClass: "authentication" });
    expect(() => openFakeBank({ ...config, scope: other })).toThrow("another account scope");
    const otherBank = open(options({ scope: other, webhookSecret: "private-test-secret" }));
    const delivery = bank.harness.drainNotifications()[0]!;
    await expect(otherBank.events.verifyWebhook(delivery.rawBody, delivery.headers)).rejects.toMatchObject({ errorClass: "authentication" });
    expect(bank.harness.inspect().calls.createTransfer).toBe(1);
  });

  it("returns immutable scope and snapshots a request before simulated latency", async () => {
    const bank = open(options({ faults: [{ operation: "createTransfer", call: 1, kind: "delay", delayMs: 30 }] }));
    const cmd = await command(); const response = bank.provider.createTransfer(cmd);
    cmd.amountCents = 1; cmd.destination.externalAccountId = "changed";
    const accepted = await response;
    expect(accepted.amountCents).toBe(12_500); expect(accepted.destination.externalAccountId).toBe("vendor-1");
    expect(() => { accepted.scope.accountId = "changed"; }).toThrow();
    expect((await bank.provider.getBalance(scope)).scope.accountId).toBe("operating-usd");
  });

  it("separates pending from posted debits and distinct return evidence", async () => {
    const bank = open(options()); const transfer = await bank.provider.createTransfer(await command());
    expect(await bank.provider.getBalance(scope)).toMatchObject({ currentCents: 1_000_000, availableCents: 987_500 });
    expect((await bank.provider.listTransactions(scope)).items).toHaveLength(0);
    expect(await bank.provider.getTransaction(scope, transfer.pendingTransactionId!)).toMatchObject({ status: "pending", amountCents: -12_500 });
    const settled = bank.harness.settle(transfer.id); expect(bank.harness.settle(transfer.id)).toEqual(settled);
    const debit = await bank.provider.getTransaction(scope, settled.originalTransactionId!);
    expect(debit).toMatchObject({ status: "posted", purpose: "debit", amountCents: -12_500 });
    expect(debit.id).not.toBe(transfer.pendingTransactionId);
    const returned = bank.harness.returnTransfer(transfer.id); expect(bank.harness.returnTransfer(transfer.id)).toEqual(returned);
    expect(await bank.provider.getTransaction(scope, returned.returnTransactionId!)).toMatchObject({ status: "posted", purpose: "return", amountCents: 12_500, originalTransactionId: debit.id });
    expect((await bank.provider.listTransactions(scope)).items).toHaveLength(2);
    expect(await bank.provider.getBalance(scope)).toMatchObject({ currentCents: 1_000_000, availableCents: 1_000_000 });
  });

  it("provides stable incremental checkpoints even when notification delivery is lost", async () => {
    const config = options(); let bank = open(config);
    const initial = await bank.provider.listTransactions(scope); expect(initial.items).toEqual([]); expect(initial.cursor).toBeTruthy();
    const transfer = await bank.provider.createTransfer(await command()); bank.harness.settle(transfer.id);
    expect(bank.harness.drainNotifications({ drop: true })).toEqual([]); bank.close(); bank = open(config);
    const first = await bank.provider.listTransactions(scope, { cursor: initial.cursor }); expect(first.items).toHaveLength(1);
    expect((await bank.provider.listTransactions(scope, { cursor: initial.cursor })).items).toEqual(first.items);
    expect(await bank.provider.listTransactions(scope, { cursor: first.cursor })).toMatchObject({ items: [], cursor: first.cursor, nextCursor: null });
    bank.harness.returnTransfer(transfer.id);
    const returned = await bank.provider.listTransactions(scope, { cursor: first.cursor }); expect(returned.items.map((t) => t.purpose)).toEqual(["return"]);
    const all = await bank.provider.listTransactions(scope, { limit: 1 }); expect(all.nextCursor).toBe(all.cursor);
    expect((await bank.provider.listTransactions(scope, { cursor: all.nextCursor, limit: 1 })).items).toEqual(returned.items);
    const noticePage = await bank.events.listEvents(scope);
    await expect(bank.provider.listTransactions(scope, { cursor: noticePage.cursor })).rejects.toMatchObject({ errorClass: "validation" });
  });

  it("duplicates and reorders authenticated hints while retaining complete event history", async () => {
    const bank = open(options()); const transfer = await bank.provider.createTransfer(await command());
    bank.harness.settle(transfer.id); bank.harness.returnTransfer(transfer.id);
    const deliveries = bank.harness.drainNotifications({ duplicate: true, reverse: true }); expect(deliveries).toHaveLength(6);
    const verified = await Promise.all(deliveries.map((delivery) => bank.events.verifyWebhook(delivery.rawBody, delivery.headers)));
    expect(new Set(verified.map((notice) => notice.id)).size).toBe(3);
    expect(verified[0]?.id).toBe(bank.harness.inspect().events[2]?.id);
    expect(bank.harness.drainNotifications()).toEqual([]);
    expect((await bank.events.listEvents(scope)).items).toHaveLength(3);
    const first = deliveries[0]!;
    await expect(bank.events.verifyWebhook(Buffer.from("{}"), first.headers)).rejects.toMatchObject({ errorClass: "authentication" });
    await expect(bank.events.verifyWebhook(first.rawBody, {})).rejects.toMatchObject({ errorClass: "authentication" });
  });

  it("preserves persisted fault progress and distinguishes rejection from ambiguous errors", async () => {
    const config = options({ faults: [{ operation: "createTransfer", call: 1, kind: "authentication" }, { operation: "createTransfer", call: 2, kind: "disconnect" }, { operation: "createTransfer", call: 3, kind: "unavailable" }] });
    let bank = open(config); const cmd = await command();
    await expect(bank.provider.createTransfer(cmd)).rejects.toMatchObject({ errorClass: "authentication", outcomeUnknown: false });
    bank.close(); bank = open(config);
    await expect(bank.provider.createTransfer(cmd)).rejects.toMatchObject({ errorClass: "transport", outcomeUnknown: true });
    await expect(bank.provider.createTransfer(cmd)).rejects.toMatchObject({ errorClass: "unknown", outcomeUnknown: true });
    const transfer = await bank.provider.createTransfer(cmd); const rejected = bank.harness.reject(transfer.id, "invalid_destination");
    expect(rejected.status).toBe("rejected"); expect(rejected.originalTransactionId).toBeUndefined();
    expect((await bank.provider.listTransactions(scope)).items).toEqual([]);
    expect(await bank.provider.getBalance(scope)).toMatchObject({ currentCents: 1_000_000, availableCents: 1_000_000 });
    expect(() => bank.harness.settle(transfer.id)).toThrow(); expect(() => bank.harness.returnTransfer(transfer.id)).toThrow();
  });

  it("rejects invalid commands and overdraws without inventing cash movement", async () => {
    const bank = open(options({ initialBalanceCents: 100 }));
    for (const overrides of [{ amountCents: 0 }, { amountCents: 0.5 }, { amountCents: -1 }]) await expect(bank.provider.createTransfer(await command(overrides))).rejects.toMatchObject({ errorClass: "validation" });
    const badHash = await command(); badHash.amountCents += 1;
    await expect(bank.provider.createTransfer(badHash)).rejects.toMatchObject({ errorClass: "validation" });
    expect(bank.harness.inspect().transfers).toHaveLength(0);
    const rejected = await bank.provider.createTransfer(await command());
    expect(rejected).toMatchObject({ status: "rejected", rejectionReason: "insufficient_funds" });
    expect(bank.harness.inspect().transactions).toHaveLength(0);
  });

  it("exposes no harness, database, credentials or truth through provider capabilities", async () => {
    const bank = open(options());
    expect(Object.keys(bank.provider).sort()).toEqual(["createTransfer", "getBalance", "getTransaction", "getTransfer", "listTransactions"]);
    expect(Object.keys(bank.events).sort()).toEqual(["listEvents", "verifyWebhook"]);
    expect(JSON.stringify(bank.provider)).toBe("{}");
  });
});
