import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  BankProviderError, BankResourceOutsideScope, buildIncreaseRequestBody, canonicalJson, commandRequestHash, sameBankScope,
  type BankCommand, type BankItemFailure, type BankScope, type BankTransaction, type BankingProvider,
  type BankingEvents, type BankPagination, type BankPage, type BankEvent, type TransferObservation,
} from "../contracts.js";
import type { PaymentRail, PossibleSendScan, RailRecoveryCapability, TransferLookup, UnsentPaymentScanner } from "../../payments/ports/payment-rail";

export const INCREASE_SANDBOX_ORIGIN = "https://sandbox.increase.com";
/** Parallel transfer lookups per transaction page; keeps a 100-row page well under rate limits. */
const LOOKUP_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(values: readonly T[], limit: number, fn: (value: T) => Promise<R>) {
  const results: ({ ok: true; value: R } | { ok: false; error: unknown })[] = new Array(values.length);
  let next = 0;
  const run = async () => {
    while (next < values.length) {
      const index = next++;
      try { results[index] = { ok: true, value: await fn(values[index]!) }; }
      catch (error) { results[index] = { ok: false, error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return results;
}
/** Normalized, credential-free failure for one listed row. */
function itemFailure(id: string, error: unknown): BankItemFailure {
  if (error instanceof BankProviderError) {
    return { id, errorClass: error.errorClass, error: error.message, ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) };
  }
  if (error instanceof BankResourceOutsideScope) return { id, errorClass: "validation", error: "Linked bank resource belongs to another account" };
  return { id, errorClass: "unknown", error: "Increase transaction could not be verified" };
}
const id = z.string().min(1);
const time = z.iso.datetime({ offset: true });
const transferSchema = z.object({
  id, type: z.literal("ach_transfer"), account_id: id, amount: z.number().int().refine(amount => amount !== 0),
  currency: z.literal("USD"), external_account_id: id.nullable(), idempotency_key: id.nullable(),
  statement_descriptor: z.string(), status: z.enum(["pending_submission", "pending_reviewing", "pending_approval", "submitted", "returned", "rejected", "canceled", "requires_attention"]),
  created_at: time, pending_transaction_id: id.nullable(), transaction_id: id.nullable(),
  settlement: z.object({ settled_at: time }).nullable(),
  return: z.object({ transaction_id: id, transfer_id: id, created_at: time }).nullable(),
}).passthrough();
const transactionSchema = z.object({
  id, type: z.literal("transaction"), account_id: id, amount: z.number().int(),
  currency: z.literal("USD"), created_at: time,
  source: z.object({ category: id }).passthrough(),
}).passthrough();
const eventSchema = z.object({
  id, type: z.literal("event"), associated_object_id: id, associated_object_type: id,
  category: id, created_at: time,
}).passthrough();
type Transfer = z.infer<typeof transferSchema>;
type Transaction = z.infer<typeof transactionSchema>;
type Event = z.infer<typeof eventSchema>;
export type IncreaseNotification = BankEvent & { bodyHash: string };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BankProviderError("unknown", "Increase response failed the pinned AP contract", true);
  return result.data;
}
function notification(event: Event, scope: BankScope): BankEvent {
  return {
    id: event.id, scope: { ...scope }, createdAt: event.created_at, resourceType: event.associated_object_type,
    ...(event.associated_object_type === "ach_transfer" ? { transferId: event.associated_object_id } : {}),
    ...(event.associated_object_type === "transaction" ? { transactionId: event.associated_object_id } : {}),
  };
}

/** Verifies the untouched body before parsing. The subscription secret binds the environment;
 * events have no account_id, so the worker MUST fetch the scoped resource before any effect. */
export function verifyIncreaseWebhook(options: {
  rawBody: Uint8Array; headers: Record<string, string>; scope: BankScope; signingSecret: string; now?: number;
}): IncreaseNotification {
  const { rawBody, scope, signingSecret } = options;
  if (scope.provider !== "increase" || scope.environment !== "sandbox" || !signingSecret) {
    throw new BankProviderError("configuration", "Increase sandbox subscription configuration is required");
  }
  const headers = Object.fromEntries(Object.entries(options.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const webhookId = headers["webhook-id"] ?? "";
  const timestamp = headers["webhook-timestamp"] ?? "";
  if (!/^(?:sandbox_)?event_[a-zA-Z0-9]+$/.test(webhookId) || !/^\d+$/.test(timestamp) ||
      Math.abs((options.now ?? Date.now()) / 1000 - Number(timestamp)) > 300 || rawBody.length > 256_000) {
    throw new BankProviderError("authentication", "Invalid or expired Increase webhook");
  }
  // Increase's documented manual algorithm uses the signing secret as the HMAC key.
  const digest = createHmac("sha256", signingSecret).update(`${webhookId}.${timestamp}.`).update(rawBody).digest();
  const valid = (headers["webhook-signature"] ?? "").split(" ").some(signature => {
    if (!/^v1,[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
    const candidate = Buffer.from(signature.slice(3), "base64");
    return candidate.length === digest.length && timingSafeEqual(candidate, digest);
  });
  if (!valid) throw new BankProviderError("authentication", "Invalid Increase webhook signature");
  let json: unknown;
  try { json = JSON.parse(Buffer.from(rawBody).toString("utf8")); }
  catch { throw new BankProviderError("validation", "Invalid Increase webhook JSON"); }
  const event = parse(eventSchema, json);
  if (event.id !== webhookId) throw new BankProviderError("authentication", "Increase webhook header and event identities differ");
  return { ...notification(event, scope), bodyHash: createHash("sha256").update(rawBody).digest("hex") };
}

/** Validate the saved request against immutable approved details, but transmit its ORIGINAL bytes.
 * Older rows without the saved payload require operator migration; never reconstruct during retry. */
export function increaseRequestBody(command: BankCommand): string {
  if (!command.providerRequest) throw new BankProviderError("configuration", "Saved Increase request is missing; operator migration required");
  let body: unknown;
  try { body = JSON.parse(command.providerRequest); }
  catch { throw new BankProviderError("validation", "Saved Increase request is not JSON"); }
  if (canonicalJson(body) !== canonicalJson(JSON.parse(buildIncreaseRequestBody(command)))) {
    throw new BankProviderError("idempotency_conflict", "Saved Increase request differs from approved payment details", true);
  }
  return command.providerRequest;
}

export type IncreaseOptions = {
  scope: BankScope;
  apiKey: string;
  signingSecret?: string;
  /** A read-only lookup of durable application commands, not a process-memory registry. */
  resolveCommand: (idempotencyKey: string) => Promise<BankCommand | null>;
  /** Dependency injection for contract tests. No agent-facing arbitrary host option exists. */
  fetch?: typeof fetch;
  now?: () => number;
};

/** Trusted server/dispatcher only. No simulator methods or credential-bearing public fields. */
export class IncreaseSandboxBank implements BankingProvider, BankingEvents, PaymentRail, UnsentPaymentScanner {
  readonly recovery: RailRecoveryCapability = Object.freeze({ lookup: "operation_key", sameKeyResend: Object.freeze({
    kind: "never", reason: "Provider retention not established for this recovery window",
  }) });
  readonly #scope: BankScope;
  readonly #apiKey: string;
  readonly #signingSecret?: string;
  readonly #resolveCommand: IncreaseOptions["resolveCommand"];
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  constructor(options: IncreaseOptions) {
    if (options.scope.provider !== "increase" || options.scope.environment !== "sandbox" ||
        !options.scope.organizationId || !options.scope.runId || !/^(?:sandbox_)?account_[a-zA-Z0-9]+$/.test(options.scope.accountId) || !options.apiKey) {
      throw new BankProviderError("configuration", "One explicit Increase sandbox account and credential are required");
    }
    this.#scope = Object.freeze({ ...options.scope });
    this.#apiKey = options.apiKey;
    this.#signingSecret = options.signingSecret;
    this.#resolveCommand = options.resolveCommand;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }
  #assertScope(scope: BankScope) {
    if (!sameBankScope(scope, this.#scope)) throw new BankProviderError("configuration", "Increase scope mismatch");
  }
  async #assertCommand(command: BankCommand) {
    this.#assertScope(command.scope);
    if (!Number.isSafeInteger(command.amountCents) || command.amountCents <= 0 || command.amountCents > 9_999_999_999 ||
        command.currency !== "USD" || !/^(?:sandbox_)?external_account_[a-zA-Z0-9]+$/.test(command.destination.externalAccountId) ||
        !/^[ -~]{1,200}$/.test(command.commandId) || !/^[\x21-\x7e]{1,200}$/.test(command.idempotencyKey) ||
        !command.destination.version || !command.approvalVersion || command.requestHash !== await commandRequestHash(command)) {
      throw new BankProviderError("validation", "Invalid immutable Increase ACH command");
    }
    increaseRequestBody(command);
  }
  async #request(path: string, body?: string, key?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${INCREASE_SANDBOX_ORIGIN}${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new BankProviderError("transport", "Increase request failed; retry the original saved request and key", body !== undefined);
    }
    if (!response.ok) {
      // Provider messages can contain sensitive request fields. Only persist normalized safe errors.
      const retry = response.headers.get("retry-after");
      const retryAfterMs = retry === null ? undefined : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - this.#now());
      if ([401, 403].includes(response.status)) throw new BankProviderError("authentication", "Increase authentication failed; operator action required");
      if (response.status === 429) throw new BankProviderError("rate_limit", "Increase rate limit", false, Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
      if (response.status === 409) throw new BankProviderError("idempotency_conflict", "Increase conflict; quarantine original request and key", true);
      if (response.status === 404) throw new BankProviderError("not_found", "Increase resource not found; this does not prove rejection", body !== undefined);
      if (response.status >= 500 || response.status === 408) throw new BankProviderError("unknown", "Increase outcome unknown", body !== undefined);
      throw new BankProviderError("validation", `Increase rejected request (HTTP ${response.status})`);
    }
    try { return await response.json(); }
    catch { throw new BankProviderError("unknown", "Increase returned malformed JSON", body !== undefined); }
  }
  #resourcePath(kind: "ach_transfers" | "transactions", resourceId: string): string {
    const prefix = kind === "ach_transfers" ? "ach_transfer" : "transaction";
    if (!new RegExp(`^(?:sandbox_)?${prefix}_[a-zA-Z0-9]+$`).test(resourceId)) throw new BankProviderError("validation", "Invalid Increase resource identifier");
    return `/${kind}/${resourceId}`;
  }
  async #rawTransfer(transferId: string): Promise<Transfer> {
    const transfer = parse(transferSchema, await this.#request(this.#resourcePath("ach_transfers", transferId)));
    if (transfer.id !== transferId) throw new BankProviderError("configuration", "Increase transfer identity mismatch");
    if (transfer.account_id !== this.#scope.accountId) throw new BankResourceOutsideScope("ach_transfer", transferId, transfer.account_id);
    return transfer;
  }
  async #rawTransaction(transactionId: string): Promise<Transaction> {
    const transaction = parse(transactionSchema, await this.#request(this.#resourcePath("transactions", transactionId)));
    if (transaction.id !== transactionId) throw new BankProviderError("configuration", "Increase transaction identity mismatch");
    if (transaction.account_id !== this.#scope.accountId) throw new BankResourceOutsideScope("transaction", transactionId, transaction.account_id);
    return transaction;
  }
  async #command(transfer: Transfer, supplied?: BankCommand): Promise<BankCommand | null> {
    const command = supplied ?? (transfer.idempotency_key ? await this.#resolveCommand(transfer.idempotency_key) : null);
    if (command === null) return null;
    await this.#assertCommand(command);
    if (command.idempotencyKey !== transfer.idempotency_key || command.scope.accountId !== transfer.account_id ||
        command.amountCents !== transfer.amount || command.destination.externalAccountId !== transfer.external_account_id ||
        command.commandId !== transfer.statement_descriptor) throw new BankProviderError("idempotency_conflict", "Increase facts differ from the saved approved command", true);
    return command;
  }
  #transactionLink(transaction: Transaction): { transferId: string; purpose: "debit" | "return" } | null {
    const category = transaction.source.category;
    if (category !== "ach_transfer_intention" && category !== "ach_transfer_return") return null;
    const source = transaction.source[category];
    const parsed = z.object({ transfer_id: id }).safeParse(source);
    if (!parsed.success) throw new BankProviderError("unknown", "Missing Increase transaction transfer linkage", true);
    return { transferId: parsed.data.transfer_id, purpose: category === "ach_transfer_return" ? "return" : "debit" };
  }
  #verifyEconomicTransaction(transaction: Transaction, transfer: Transfer, purpose: "debit" | "return") {
    const link = this.#transactionLink(transaction);
    const expectedId = purpose === "debit" ? transfer.transaction_id : transfer.return?.transaction_id;
    if (transaction.account_id !== transfer.account_id || !link || link.transferId !== transfer.id || link.purpose !== purpose ||
        transaction.id !== expectedId || transaction.amount !== (purpose === "debit" ? -transfer.amount : transfer.amount) ||
        !transfer.settlement?.settled_at || (purpose === "return" && transfer.return?.transfer_id !== transfer.id)) {
      throw new BankProviderError("unknown", "Increase transaction does not corroborate ACH settlement or return", true);
    }
  }
  async #observation(transfer: Transfer, supplied?: BankCommand): Promise<TransferObservation> {
    const command = await this.#command(transfer, supplied);
    if (!command) throw new BankProviderError("not_found", "No saved approved command for Increase transfer; retain as unmatched evidence");
    if (transfer.status === "requires_attention") throw new BankProviderError("configuration", "Increase transfer requires operator attention", true);
    let status: TransferObservation["status"] = "pending";
    if (transfer.status === "returned") {
      if (!transfer.transaction_id || !transfer.return || transfer.return.transaction_id === transfer.transaction_id) throw new BankProviderError("unknown", "Returned transfer lacks both distinct economic transactions", true);
      const original = await this.#rawTransaction(transfer.transaction_id);
      const returned = await this.#rawTransaction(transfer.return.transaction_id);
      this.#verifyEconomicTransaction(original, transfer, "debit");
      this.#verifyEconomicTransaction(returned, transfer, "return");
      status = "returned";
    } else if (transfer.settlement) {
      if (transfer.status !== "submitted" || !transfer.transaction_id) throw new BankProviderError("unknown", "Settlement lacks a posted Increase transaction", true);
      this.#verifyEconomicTransaction(await this.#rawTransaction(transfer.transaction_id), transfer, "debit");
      status = "settled";
    } else if (transfer.status === "rejected" || transfer.status === "canceled") {
      if (transfer.transaction_id || transfer.return) throw new BankProviderError("unknown", "Rejected transfer has unexplained economic activity", true);
      status = "rejected";
    }
    return {
      id: transfer.id, scope: { ...this.#scope }, commandId: command.commandId, requestHash: command.requestHash,
      idempotencyKey: command.idempotencyKey, amountCents: transfer.amount, currency: "USD", destination: { ...command.destination },
      status, createdAt: transfer.created_at, updatedAt: transfer.return?.created_at ?? transfer.settlement?.settled_at ?? transfer.created_at,
      ...(transfer.pending_transaction_id ? { pendingTransactionId: transfer.pending_transaction_id } : {}),
      ...(transfer.transaction_id ? { originalTransactionId: transfer.transaction_id } : {}),
      ...(transfer.return ? { returnTransactionId: transfer.return.transaction_id } : {}),
      ...(status === "rejected" ? { rejectionReason: `Provider status ${transfer.status}, no transaction` } : {}),
    };
  }
  async createTransfer(command: BankCommand): Promise<TransferObservation> {
    await this.#assertCommand(command);
    return this.#observation(parse(transferSchema, await this.#request("/ach_transfers", increaseRequestBody(command), command.idempotencyKey)), command);
  }
  /** Read-only scoped recovery. No POST, reconstructed request or process-memory registry.
   * https://www.increase.com/documentation/api/ach-transfers (account_id + idempotency_key).
   * https://www.increase.com/documentation/idempotency-keys (one matching object per key).
   * Retention is intentionally not inferred from these endpoint semantics. */
  async lookupTransfer(command: BankCommand, providerTransferId?: string): Promise<TransferLookup> {
    await this.#assertCommand(command);
    const identity = () => ({ scope: { ...this.#scope }, commandId: command.commandId,
      idempotencyKey: command.idempotencyKey, requestHash: command.requestHash, checkedAt: this.#now() });
    if (providerTransferId) {
      try {
        const observation = await this.#observation(await this.#rawTransfer(providerTransferId), command);
        return { ...identity(), kind: "found", observation };
      }
      catch (error) {
        if (error instanceof BankProviderError && error.errorClass === "not_found") {
          return { ...identity(), kind: "unknown", reason: "Previously accepted Increase transfer is missing; preserve its identity for review" };
        }
        throw this.#recoveryError(error);
      }
    }
    const query = new URLSearchParams({ account_id: this.#scope.accountId, idempotency_key: command.idempotencyKey, limit: "100" });
    const raw = await this.#request(`/ach_transfers?${query}`);
    const parsed = z.object({ data: z.array(transferSchema), next_cursor: id.nullable() }).safeParse(raw);
    if (!parsed.success) throw new BankProviderError("configuration", "Malformed Increase operation-key lookup response");
    const response = parsed.data;
    // The key filter promises zero or one result. Partial/unexpected results cannot prove absence.
    if (response.next_cursor || response.data.length > 1) return { ...identity(), kind: "unknown", reason: "Incomplete or ambiguous Increase operation-key lookup" };
    const transfer = response.data[0];
    if (!transfer) return { ...identity(), kind: "not_found", searchedBy: "operation_key" };
    if (transfer.account_id !== this.#scope.accountId || transfer.idempotency_key !== command.idempotencyKey) {
      throw new BankProviderError("configuration", "Increase lookup differs from the scoped operation key");
    }
    let observation: TransferObservation;
    try { observation = await this.#observation(transfer, command); }
    catch (error) { throw this.#recoveryError(error); }
    return { ...identity(), kind: "found", observation };
  }
  /** Operator release evidence. Any ACH transfer to the same beneficiary for the same amount
   * (or carrying this key), and any posted debit of the same amount, counts as a possible send.
   * Raw rows only: no per-row lookups, so one bad row cannot hide another. */
  async scanForPossibleSend(command: BankCommand, since: number): Promise<PossibleSendScan> {
    await this.#assertCommand(command);
    if (!Number.isSafeInteger(since) || since < 0) throw new BankProviderError("validation", "Invalid release scan start");
    const after = new Date(since).toISOString();
    const scan: PossibleSendScan = { complete: true, transfersScanned: 0, transactionsScanned: 0, matchingTransferIds: [], matchingTransactionIds: [] };
    const pages = async <T>(path: string, params: Record<string, string>, schema: z.ZodType<T>, visit: (row: T) => void) => {
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const query = new URLSearchParams({ ...params, limit: "100", ...(cursor ? { cursor } : {}) });
        const response = parse(z.object({ data: z.array(schema), next_cursor: id.nullable() }), await this.#request(`${path}?${query}`));
        response.data.forEach(visit);
        cursor = response.next_cursor;
        if (!cursor) return;
      }
      scan.complete = false;
    };
    await pages("/ach_transfers", { account_id: this.#scope.accountId, external_account_id: command.destination.externalAccountId, "created_at.on_or_after": after },
      transferSchema, transfer => {
        scan.transfersScanned++;
        if (transfer.account_id === this.#scope.accountId && (transfer.idempotency_key === command.idempotencyKey ||
            (transfer.amount === command.amountCents && transfer.external_account_id === command.destination.externalAccountId))) scan.matchingTransferIds.push(transfer.id);
      });
    await pages("/transactions", { account_id: this.#scope.accountId, "created_at.on_or_after": after }, transactionSchema, transaction => {
      scan.transactionsScanned++;
      if (transaction.account_id === this.#scope.accountId && transaction.amount === -command.amountCents) scan.matchingTransactionIds.push(transaction.id);
    });
    return scan;
  }
  #recoveryError(error: unknown): unknown {
    if (error instanceof BankProviderError && (["idempotency_conflict", "validation"].includes(error.errorClass) ||
        error.message === "Increase response failed the pinned AP contract")) {
      return new BankProviderError("configuration", "Increase recovery evidence conflicts with the frozen payment command");
    }
    return error;
  }
  async getTransfer(scope: BankScope, transferId: string): Promise<TransferObservation> {
    this.#assertScope(scope);
    return this.#observation(await this.#rawTransfer(transferId));
  }
  async #normalizeTransaction(transaction: Transaction): Promise<BankTransaction> {
    if (transaction.account_id !== this.#scope.accountId) throw new BankProviderError("configuration", "Increase transaction account mismatch");
    const link = this.#transactionLink(transaction);
    let commandId = "";
    let originalTransactionId: string | undefined;
    if (link) {
      const transfer = await this.#rawTransfer(link.transferId);
      const command = await this.#command(transfer);
      this.#verifyEconomicTransaction(transaction, transfer, link.purpose);
      commandId = command?.commandId ?? "";
      if (link.purpose === "return") originalTransactionId = transfer.transaction_id ?? undefined;
    }
    // Do not filter unrelated account activity: an empty command identity becomes a close blocker.
    return { id: transaction.id, scope: { ...this.#scope }, transferId: link?.transferId ?? "", commandId,
      amountCents: transaction.amount, currency: "USD", status: "posted", purpose: commandId && link ? link.purpose : "other",
      sourceCategory: transaction.source.category,
      createdAt: transaction.created_at, postedAt: transaction.created_at, ...(originalTransactionId ? { originalTransactionId } : {}) };
  }
  async getTransaction(scope: BankScope, transactionId: string): Promise<BankTransaction> {
    this.#assertScope(scope);
    return this.#normalizeTransaction(await this.#rawTransaction(transactionId));
  }
  async listTransactions(scope: BankScope, page: BankPagination = {}): Promise<BankPage<BankTransaction>> {
    this.#assertScope(scope);
    const query = new URLSearchParams({ account_id: scope.accountId, limit: String(this.#limit(page.limit)) });
    if (page.cursor) query.set("cursor", page.cursor);
    if (page.createdOnOrAfter !== undefined) {
      if (!Number.isFinite(Date.parse(page.createdOnOrAfter))) throw new BankProviderError("validation", "Invalid transaction activity boundary");
      query.set("created_at.on_or_after", page.createdOnOrAfter);
    }
    const response = parse(z.object({ data: z.array(transactionSchema), next_cursor: id.nullable() }), await this.#request(`/transactions?${query}`));
    // Each ACH-linked row needs a transfer GET. Bound concurrency, stop new lookups after a
    // rate limit, and return failed rows separately so one bad row cannot discard the page.
    let throttled: BankProviderError | undefined;
    const results = await mapWithConcurrency(response.data, LOOKUP_CONCURRENCY, async transaction => {
      if (throttled) throw throttled;
      try { return await this.#normalizeTransaction(transaction); }
      catch (error) {
        if (error instanceof BankProviderError && error.errorClass === "rate_limit") throttled = error;
        throw error;
      }
    });
    const items: BankTransaction[] = [];
    const failures: BankItemFailure[] = [];
    results.forEach((result, index) => {
      if (result.ok) items.push(result.value);
      else failures.push(itemFailure(response.data[index]!.id, result.error));
    });
    // Transactions are newest-first and have no tail cursor. At end, rescan the run's window next
    // poll; backend transaction-id deduplication makes this safe and catches activity beyond event retention.
    return { items, nextCursor: response.next_cursor, cursor: response.next_cursor, ...(failures.length ? { failures } : {}) };
  }
  async listEvents(scope: BankScope, page: BankPagination = {}): Promise<BankPage<BankEvent>> {
    this.#assertScope(scope);
    const query = new URLSearchParams({ "order_by.field": "created_at", "order_by.direction": "ascending", limit: String(this.#limit(page.limit)) });
    if (page.cursor) query.set("cursor", page.cursor);
    const response = parse(z.object({ data: z.array(eventSchema), next_cursor: id.nullable() }), await this.#request(`/events?${query}`));
    return { items: response.data.map(event => notification(event, this.#scope)), nextCursor: response.data.length ? response.next_cursor : null, cursor: response.next_cursor };
  }
  #limit(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BankProviderError("validation", "Page limit must be 1–100");
    return limit;
  }
  async verifyWebhook(rawBody: Uint8Array, headers: Record<string, string>): Promise<IncreaseNotification> {
    return verifyIncreaseWebhook({ rawBody, headers, scope: this.#scope, signingSecret: this.#signingSecret ?? "", now: this.#now() });
  }
  async getBalance(scope: BankScope) {
    this.#assertScope(scope);
    const balance = parse(z.object({ account_id: id, type: z.literal("balance_lookup"), current_balance: z.number().int(), available_balance: z.number().int() }),
      await this.#request(`/accounts/${scope.accountId}/balance`));
    if (balance.account_id !== scope.accountId) throw new BankProviderError("configuration", "Increase balance account mismatch");
    return { scope: { ...scope }, currency: "USD" as const, currentCents: balance.current_balance, availableCents: balance.available_balance, asOf: new Date(this.#now()).toISOString() };
  }
}
