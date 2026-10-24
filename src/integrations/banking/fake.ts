import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  BankProviderError, canonicalCommand, canonicalJson, sameBankScope,
  type BankBalance, type BankCommand, type BankEvent, type BankingEvents,
  type BankingProvider, type BankPage, type BankPagination, type BankScope,
  type BankTransaction, type TransferObservation,
} from "../contracts.js";

export type FakeOperation = "createTransfer" | "getBalance" | "getTransfer" | "getTransaction" | "listTransactions" | "listEvents" | "deliverNotifications";
export type FakeFault = {
  operation: FakeOperation;
  /** One-based persisted invocation number, shared by every process using this bank. */
  call: number;
  kind: "rate_limit" | "authentication" | "disconnect" | "unavailable" | "accept_then_lost_response" | "delay" | "drop" | "duplicate" | "reorder";
  delayMs?: number;
  retryAfterMs?: number;
};
export type FakeBankOptions = {
  path: string;
  scope: BankScope;
  seed: number | string;
  startTime?: string;
  initialBalanceCents?: number;
  faults?: FakeFault[];
  /** Test ingress authentication only; keep this value in the harness/worker process. */
  webhookSecret?: string;
};
export type FakeDelivery = { rawBody: Uint8Array; headers: Record<string, string> };
export interface FakeBankHarness {
  advanceTime(milliseconds: number): string;
  settle(transferId: string): TransferObservation;
  reject(transferId: string, reason: string): TransferObservation;
  returnTransfer(transferId: string): TransferObservation;
  scheduleFault(fault: FakeFault): void;
  drainNotifications(options?: { drop?: boolean; duplicate?: boolean; reverse?: boolean }): FakeDelivery[];
  inspect(): { transfers: TransferObservation[]; transactions: BankTransaction[]; events: BankEvent[]; calls: Record<string, number> };
}

type Row = { value: string };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const decode = <T>(row: Row | undefined): T | undefined => row ? JSON.parse(row.value) as T : undefined;
const fail = (message: string): never => { throw new BankProviderError("validation", message); };

/** Independent SQLite bank. Only provider/events capabilities should enter application workers. */
export function openFakeBank(options: FakeBankOptions): {
  provider: BankingProvider;
  events: BankingEvents;
  harness: FakeBankHarness;
  close(): void;
} {
  if (options.scope.provider !== "fake" || options.scope.environment !== "local") fail("FakeBank requires fake/local scope");
  for (const value of Object.values(options.scope)) if (typeof value !== "string" || !value.trim()) fail("A complete bank scope is required");
  const db = new DatabaseSync(options.path);
  if (options.path !== ":memory:") chmodSync(options.path, 0o600);
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, idem TEXT NOT NULL UNIQUE, request TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transactions (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, posted INTEGER NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, delivered INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS counters (operation TEXT PRIMARY KEY, calls INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS faults (operation TEXT NOT NULL, call INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(operation,call));
  `);
  function atomic<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function getMeta<T>(key: string): T { return JSON.parse((db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as Row).value) as T; }
  function putMeta(key: string, value: unknown): void { db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)").run(key, JSON.stringify(value)); }
  function addFault(fault: FakeFault): void {
    if (!Number.isSafeInteger(fault.call) || fault.call < 1) fail("Fault invocation must be a positive integer");
    if ((fault.delayMs ?? 0) < 0 || (fault.retryAfterMs ?? 0) < 0) fail("Fault delays cannot be negative");
    if (fault.kind === "accept_then_lost_response" && fault.operation !== "createTransfer") fail("Lost acceptance response applies only to createTransfer");
    db.prepare("INSERT INTO faults(operation,call,value) VALUES (?,?,?)").run(fault.operation, fault.call, JSON.stringify(fault));
  }
  try {
    atomic(() => {
      const existing = db.prepare("SELECT value FROM metadata WHERE key = 'scope'").get() as Row | undefined;
      if (existing) {
        if (!sameBankScope(JSON.parse(existing.value) as BankScope, options.scope)) throw new BankProviderError("authentication", "Bank datastore is bound to another account scope");
        if (getMeta<string>("seed") !== String(options.seed)) fail("Seed cannot change for an existing bank datastore");
        if (options.webhookSecret !== undefined && getMeta<string>("webhookSecret") !== options.webhookSecret) fail("Webhook secret does not match existing bank");
      } else {
        const balance = options.initialBalanceCents ?? 1_000_000;
        const clock = Date.parse(options.startTime ?? "2026-01-01T00:00:00.000Z");
        if (!Number.isSafeInteger(balance) || balance < 0 || !Number.isFinite(clock)) fail("Invalid initial balance or clock");
        putMeta("scope", options.scope); putMeta("seed", String(options.seed)); putMeta("balance", balance);
        putMeta("clock", clock); putMeta("sequence", 0);
        putMeta("webhookSecret", options.webhookSecret ?? randomBytes(32).toString("hex"));
        for (const fault of options.faults ?? []) addFault(fault);
      }
    });
  } catch (error) { db.close(); throw error; }
  const scope = Object.freeze(getMeta<BankScope>("scope"));
  const seed = getMeta<string>("seed");
  const secret = getMeta<string>("webhookSecret");
  const now = () => new Date(getMeta<number>("clock")).toISOString();
  const assertScope = (candidate: BankScope) => {
    if (!sameBankScope(scope, candidate)) throw new BankProviderError("authentication", "Bank account scope does not match adapter binding");
  };
  const id = (prefix: string) => {
    const sequence = getMeta<number>("sequence") + 1;
    putMeta("sequence", sequence);
    return `${prefix}_${sha256(`${seed}:${canonicalJson(scope)}:${sequence}`).slice(0, 24)}`;
  };
  function readTransfer(transferId: string): TransferObservation {
    const transfer = decode<TransferObservation>(db.prepare("SELECT value FROM transfers WHERE id = ?").get(transferId) as Row | undefined);
    if (!transfer) throw new BankProviderError("not_found", "Transfer does not exist in this bank account");
    return transfer;
  }
  function saveTransfer(transfer: TransferObservation): void { db.prepare("UPDATE transfers SET value = ? WHERE id = ?").run(JSON.stringify(transfer), transfer.id); }
  function transaction(transfer: TransferObservation, purpose: "debit" | "return", posted: boolean): BankTransaction {
    const entry: BankTransaction = {
      id: id(posted ? "txn" : "pending"), scope, transferId: transfer.id, commandId: transfer.commandId,
      amountCents: transfer.amountCents * (purpose === "debit" ? -1 : 1), currency: "USD",
      status: posted ? "posted" : "pending", purpose, createdAt: now(),
      ...(posted ? { postedAt: now() } : {}),
      ...(purpose === "return" ? { originalTransactionId: transfer.originalTransactionId! } : {}),
    };
    db.prepare("INSERT INTO transactions(id,posted,value) VALUES (?,?,?)").run(entry.id, posted ? 1 : 0, JSON.stringify(entry));
    return entry;
  }
  function event(transferId: string): void {
    const notice: BankEvent = { id: id("evt"), scope, transferId, resourceType: "ach_transfer", createdAt: now() };
    db.prepare("INSERT INTO events(id,value) VALUES (?,?)").run(notice.id, JSON.stringify(notice));
  }
  function takeFault(operation: FakeOperation): FakeFault | undefined {
    return atomic(() => {
      db.prepare("INSERT INTO counters(operation,calls) VALUES (?,1) ON CONFLICT(operation) DO UPDATE SET calls = calls + 1").run(operation);
      const calls = (db.prepare("SELECT calls FROM counters WHERE operation = ?").get(operation) as { calls: number }).calls;
      return decode<FakeFault>(db.prepare("SELECT value FROM faults WHERE operation = ? AND call = ?").get(operation, calls) as Row | undefined);
    });
  }
  async function invoke<T>(operation: FakeOperation, action: () => T): Promise<T> {
    const fault = takeFault(operation);
    if (fault?.kind === "delay") await new Promise((resolve) => setTimeout(resolve, fault.delayMs ?? 1));
    if (fault?.kind === "authentication") throw new BankProviderError("authentication", "Scheduled authentication failure");
    if (fault?.kind === "rate_limit") throw new BankProviderError("rate_limit", "Scheduled rate limit", false, fault.retryAfterMs ?? 1000);
    if (fault?.kind === "disconnect") throw new BankProviderError("transport", "Scheduled connection loss", operation === "createTransfer");
    if (fault?.kind === "unavailable") throw new BankProviderError("unknown", "Scheduled provider unavailability", operation === "createTransfer");
    const result = action();
    if (fault?.kind === "accept_then_lost_response") throw new BankProviderError("transport", "Bank accepted transfer but response was lost", true);
    return result;
  }
  function balance(): BankBalance {
    const posted = (db.prepare("SELECT value FROM transactions WHERE posted = 1").all() as Row[]).map((row) => JSON.parse(row.value) as BankTransaction);
    const pending = (db.prepare("SELECT value FROM transfers").all() as Row[]).map((row) => JSON.parse(row.value) as TransferObservation).filter((t) => t.status === "pending");
    const currentCents = getMeta<number>("balance") + posted.reduce((sum, t) => sum + t.amountCents, 0);
    return { scope, currency: "USD", currentCents, availableCents: currentCents - pending.reduce((sum, t) => sum + t.amountCents, 0), asOf: now() };
  }
  function page<T>(table: "transactions" | "events", params: BankPagination = {}): BankPage<T> {
    const binding = sha256(canonicalJson(scope)).slice(0, 16);
    const prefix = `${table}:${binding}:`;
    let checkpoint = 0;
    if (params.cursor) {
      if (!params.cursor.startsWith(prefix) || !/^\d+$/.test(params.cursor.slice(prefix.length))) fail("Cursor belongs to a different resource or account");
      checkpoint = Number(params.cursor.slice(prefix.length));
      if (!Number.isSafeInteger(checkpoint)) fail("Invalid cursor");
    }
    const limit = params.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail("Page limit must be between 1 and 1000");
    const rows = db.prepare(`SELECT seq,value FROM ${table} WHERE seq > ? ${table === "transactions" ? "AND posted = 1" : ""} ORDER BY seq LIMIT ?`).all(checkpoint, limit + 1) as { seq: number; value: string }[];
    const selected = rows.slice(0, limit);
    const cursor = `${prefix}${selected.at(-1)?.seq ?? checkpoint}`;
    return { items: selected.map((row) => JSON.parse(row.value) as T), cursor, nextCursor: rows.length > limit ? cursor : null };
  }
  const provider: BankingProvider = Object.freeze({
    async getBalance(candidate: BankScope) { assertScope(candidate); return invoke("getBalance", () => atomic(balance)); },
    async createTransfer(command: BankCommand) {
      command = JSON.parse(canonicalJson(command)) as BankCommand;
      assertScope(command.scope);
      if (!Number.isSafeInteger(command.amountCents) || command.amountCents <= 0 || command.currency !== "USD") fail("Positive integer USD amount required");
      for (const value of [command.commandId, command.approvalVersion, command.idempotencyKey, command.destination?.externalAccountId, command.destination?.version]) {
        if (typeof value !== "string" || !value.trim()) fail("Complete approved command and destination required");
      }
      const request = canonicalCommand(command);
      if (command.requestHash !== sha256(request)) fail("Command request hash does not match immutable request");
      return invoke("createTransfer", () => atomic(() => {
        const original = db.prepare("SELECT request,value FROM transfers WHERE idem = ?").get(command.idempotencyKey) as { request: string; value: string } | undefined;
        if (original) {
          if (original.request !== request) throw new BankProviderError("idempotency_conflict", "Idempotency key was already used for a different request");
          return JSON.parse(original.value) as TransferObservation;
        }
        const transfer: TransferObservation = {
          id: id("transfer"), scope, commandId: command.commandId, requestHash: command.requestHash,
          idempotencyKey: command.idempotencyKey, amountCents: command.amountCents, currency: "USD",
          destination: { ...command.destination }, status: "pending", createdAt: now(), updatedAt: now(),
        };
        if (balance().availableCents < command.amountCents) {
          transfer.status = "rejected"; transfer.rejectionReason = "insufficient_funds";
        } else transfer.pendingTransactionId = transaction(transfer, "debit", false).id;
        db.prepare("INSERT INTO transfers(id,idem,request,value) VALUES (?,?,?,?)").run(transfer.id, command.idempotencyKey, request, JSON.stringify(transfer));
        event(transfer.id);
        return transfer;
      }));
    },
    async getTransfer(candidate: BankScope, transferId: string) { assertScope(candidate); return invoke("getTransfer", () => readTransfer(transferId)); },
    async getTransaction(candidate: BankScope, transactionId: string) {
      assertScope(candidate);
      return invoke("getTransaction", () => {
        const entry = decode<BankTransaction>(db.prepare("SELECT value FROM transactions WHERE id = ?").get(transactionId) as Row | undefined);
        if (!entry) throw new BankProviderError("not_found", "Transaction does not exist in this bank account");
        return entry;
      });
    },
    async listTransactions(candidate: BankScope, params?: BankPagination) { assertScope(candidate); return invoke("listTransactions", () => page<BankTransaction>("transactions", params)); },
  });
  const events: BankingEvents = Object.freeze({
    async listEvents(candidate: BankScope, params?: BankPagination) { assertScope(candidate); return invoke("listEvents", () => page<BankEvent>("events", params)); },
    async verifyWebhook(rawBody: Uint8Array, headers: Record<string, string>) {
      const signature = headers["x-fake-signature"];
      if (!signature || !/^[a-f0-9]{64}$/.test(signature)) throw new BankProviderError("authentication", "Missing or malformed bank signature");
      const expected = createHmac("sha256", secret).update(rawBody).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new BankProviderError("authentication", "Invalid bank signature");
      let notice: BankEvent;
      try { notice = JSON.parse(Buffer.from(rawBody).toString("utf8")) as BankEvent; }
      catch { throw new BankProviderError("validation", "Invalid bank notification"); }
      if (!notice.scope || !notice.id || !notice.transferId || !notice.createdAt) fail("Incomplete bank notification");
      assertScope(notice.scope);
      return notice;
    },
  });
  function transition(transferId: string, target: "settled" | "rejected" | "returned", reason?: string): TransferObservation {
    return atomic(() => {
      const transfer = readTransfer(transferId);
      if (transfer.status === target) return transfer;
      if (target === "settled" && transfer.status !== "pending") fail("Only pending transfers can settle");
      if (target === "rejected" && transfer.status !== "pending") fail("Only pending transfers can be rejected");
      if (target === "returned" && transfer.status !== "settled") fail("A return requires an original posted debit");
      if (target === "settled") transfer.originalTransactionId = transaction(transfer, "debit", true).id;
      if (target === "returned") transfer.returnTransactionId = transaction(transfer, "return", true).id;
      if (target === "rejected") transfer.rejectionReason = reason ?? "rejected_by_bank";
      transfer.status = target; transfer.updatedAt = now(); saveTransfer(transfer); event(transfer.id);
      return transfer;
    });
  }
  const harness: FakeBankHarness = Object.freeze({
    advanceTime(milliseconds: number) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) fail("Virtual time can only advance by nonnegative integer milliseconds");
      return atomic(() => { putMeta("clock", getMeta<number>("clock") + milliseconds); return now(); });
    },
    settle: (transferId: string) => transition(transferId, "settled"),
    reject: (transferId: string, reason: string) => transition(transferId, "rejected", reason),
    returnTransfer: (transferId: string) => transition(transferId, "returned"),
    scheduleFault: (fault: FakeFault) => atomic(() => addFault(fault)),
    drainNotifications(settings: { drop?: boolean; duplicate?: boolean; reverse?: boolean } = {}) {
      const fault = takeFault("deliverNotifications");
      return atomic(() => {
        const rows = db.prepare("SELECT value FROM events WHERE delivered = 0 ORDER BY seq").all() as Row[];
        db.prepare("UPDATE events SET delivered = 1 WHERE delivered = 0").run();
        if (settings.drop || fault?.kind === "drop") return [];
        const deliveries = rows.map((row): FakeDelivery => ({ rawBody: Buffer.from(row.value), headers: { "x-fake-signature": createHmac("sha256", secret).update(row.value).digest("hex") } }));
        if (settings.reverse || fault?.kind === "reorder") deliveries.reverse();
        return settings.duplicate || fault?.kind === "duplicate" ? deliveries.flatMap((delivery) => [delivery, delivery]) : deliveries;
      });
    },
    inspect() {
      return atomic(() => ({
        transfers: (db.prepare("SELECT value FROM transfers ORDER BY rowid").all() as Row[]).map((row) => JSON.parse(row.value) as TransferObservation),
        transactions: (db.prepare("SELECT value FROM transactions ORDER BY seq").all() as Row[]).map((row) => JSON.parse(row.value) as BankTransaction),
        events: (db.prepare("SELECT value FROM events ORDER BY seq").all() as Row[]).map((row) => JSON.parse(row.value) as BankEvent),
        calls: Object.fromEntries((db.prepare("SELECT operation,calls FROM counters").all() as { operation: string; calls: number }[]).map(({ operation, calls }) => [operation, calls])),
      }));
    },
  });
  return { provider, events, harness, close: () => db.close() };
}
