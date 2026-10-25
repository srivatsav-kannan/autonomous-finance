/** The operating bank boundary. Provider and simulator credentials never enter this API. */
export type BankScope = {
  organizationId: string;
  runId: string;
  provider: "fake" | "increase";
  environment: "local" | "sandbox";
  accountId: string;
};

export type BankDestination = { externalAccountId: string; version: string };

/** Persist this complete object before the first attempt; every retry reuses it verbatim. */
export type BankCommand = {
  commandId: string;
  scope: BankScope;
  amountCents: number;
  currency: "USD";
  destination: BankDestination;
  approvalVersion: string;
  idempotencyKey: string;
  requestHash: string;
  /** Exact saved HTTP body, mandatory for Increase; included in requestHash. */
  providerRequest?: string;
};

/** Pure T2 builder: freeze these bytes before hashing/queuing the command. */
export function buildIncreaseRequestBody(command: Pick<BankCommand, "scope" | "amountCents" | "destination" | "commandId">): string {
  return JSON.stringify({ account_id: command.scope.accountId, amount: command.amountCents,
    external_account_id: command.destination.externalAccountId,
    statement_descriptor: command.commandId, require_approval: false });
}

export type TransferObservation = {
  id: string;
  scope: BankScope;
  commandId: string;
  requestHash: string;
  idempotencyKey: string;
  amountCents: number;
  currency: "USD";
  destination: BankDestination;
  status: "pending" | "settled" | "rejected" | "returned";
  createdAt: string;
  updatedAt: string;
  pendingTransactionId?: string;
  originalTransactionId?: string;
  returnTransactionId?: string;
  rejectionReason?: string;
};

/**
 * Independent provider evidence. Cash may be posted only from status=posted.
 * A pending hold becomes complete once its transfer settles or is rejected, as Increase does.
 */
export type BankTransaction = {
  id: string;
  scope: BankScope;
  transferId: string;
  commandId: string;
  amountCents: number;
  currency: "USD";
  status: "pending" | "complete" | "posted";
  purpose: "debit" | "return" | "other";
  /** Provider source category, retained for explicitly reviewed non-AP activity. */
  sourceCategory?: string;
  createdAt: string;
  postedAt?: string;
  completedAt?: string;
  originalTransactionId?: string;
};

export type BankBalance = {
  scope: BankScope;
  currency: "USD";
  currentCents: number;
  availableCents: number;
  asOf: string;
};
export type BankPage<T> = { items: T[]; nextCursor: string | null; cursor: string | null };
export type BankPagination = { cursor?: string | null; limit?: number };
export type BankEvent = { id: string; scope: BankScope; transferId?: string; transactionId?: string; resourceType?: string; createdAt: string };

/** Only the trusted dispatcher receives createTransfer; agents receive no bank capability. */
export interface BankingProvider {
  getBalance(scope: BankScope): Promise<BankBalance>;
  createTransfer(command: BankCommand): Promise<TransferObservation>;
  getTransfer(scope: BankScope, transferId: string): Promise<TransferObservation>;
  getTransaction(scope: BankScope, transactionId: string): Promise<BankTransaction>;
  /** A cursor is an ingestion checkpoint and remains usable when the current page is empty. */
  listTransactions(scope: BankScope, page?: BankPagination): Promise<BankPage<BankTransaction>>;
}

/** Optional trusted ingress capabilities; events are hints, never cash-posting evidence. */
export interface BankingEvents {
  verifyWebhook(rawBody: Uint8Array, headers: Record<string, string>): Promise<BankEvent>;
  listEvents(scope: BankScope, page?: BankPagination): Promise<BankPage<BankEvent>>;
}

export type BankErrorClass =
  | "validation" | "authentication" | "configuration" | "rate_limit"
  | "transport" | "unknown" | "idempotency_conflict" | "not_found";
export class BankProviderError extends Error {
  readonly name = "BankProviderError";
  constructor(
    readonly errorClass: BankErrorClass,
    message: string,
    readonly outcomeUnknown = false,
    readonly retryAfterMs?: number,
  ) { super(message); }
}

/** Only emitted after fetching the exact requested resource and verifying its account. */
export class BankResourceOutsideScope extends BankProviderError {
  constructor(readonly resourceType: "ach_transfer" | "transaction", readonly resourceId: string, readonly accountId: string) {
    super("configuration", "Verified bank resource belongs to another account");
  }
}

/** Stable JSON shared by approvals, command validation, and both provider adapters. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Canonical JSON does not permit undefined");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
export function canonicalCommand(command: Omit<BankCommand, "requestHash"> | BankCommand): string {
  const { requestHash: _ignored, ...request } = command as BankCommand;
  return canonicalJson(request);
}
export async function commandRequestHash(command: Omit<BankCommand, "requestHash"> | BankCommand): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalCommand(command)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function sameBankScope(a: BankScope, b: BankScope): boolean {
  return a.organizationId === b.organizationId && a.runId === b.runId &&
    a.provider === b.provider && a.environment === b.environment && a.accountId === b.accountId;
}
