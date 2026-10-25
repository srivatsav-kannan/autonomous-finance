import type { Doc } from "../../convex/_generated/dataModel";

export const BANK_ACCOUNTS = [
  { key: "operating", code: "1000", name: "Operating", bank: "Bank A" },
  { key: "payroll", code: "1010", name: "Payroll", bank: "Bank A" },
  { key: "deposits", code: "1020", name: "Store deposits", bank: "Bank B" },
] as const;

export type BankAccountKey = typeof BANK_ACCOUNTS[number]["key"];
export type BankTransactionStatus = "processing" | "reconciled" | "recorded" | "needs_review" | "unmatched";

type BankRun = Pick<Doc<"runs">, "runId" | "label" | "simDate">;
type BankBalance = Pick<Doc<"balances">, "runId" | "account" | "debits" | "credits">;
type BankEntry = Pick<Doc<"journalEntries">, "_id" | "runId" | "sequence" | "date" | "memo" | "source" | "lines" | "status" | "reversalOf" | "decisionPath">;
type BankEvent = Pick<Doc<"events">, "_id" | "runId" | "type" | "payload" | "recordedAt">;
type BankTask = Pick<Doc<"tasks">, "_id" | "runId" | "type" | "payload" | "status" | "result" | "updatedAt">;
type BankPayment = Pick<Doc<"paymentIntents">, "_id" | "runId" | "bankRef" | "payee" | "amountCents" | "status">;
type BankAsk = Pick<Doc<"asks">, "_id" | "runId" | "taskId" | "title" | "status" | "severity" | "to">;

export interface BankWorkspaceInput {
  run: BankRun | null;
  balances: BankBalance[];
  entries: BankEntry[];
  events: BankEvent[];
  tasks: BankTask[];
  payments: BankPayment[];
  asks: BankAsk[];
}

interface BankPayload {
  account: BankAccountKey;
  txnId: string;
  date: string;
  amountCents: number;
  description: string;
  bankRef: string | null;
}

export interface BankTransaction {
  id: string;
  txnId: string;
  date: string;
  accountKey: BankAccountKey;
  accountCode: string;
  description: string;
  amountCents: number;
  bankRef: string | null;
  status: BankTransactionStatus;
  taskId: string | null;
  taskOutcome: string | null;
  summary: string | null;
  entries: {
    id: string;
    sequence: number;
    date: string;
    memo: string;
    status: "posted" | "reversed";
    decisionPath: string | null;
  }[];
  payment: { id: string; payee: string; status: BankPayment["status"] } | null;
  asks: { id: string; title: string; status: BankAsk["status"]; severity: BankAsk["severity"]; to: string }[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function dateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

/** External event payloads use v.any(); malformed rows must not become zero-dollar transactions. */
function bankPayload(value: unknown): BankPayload | null {
  const row = object(value);
  if (!row || !BANK_ACCOUNTS.some((account) => account.key === row.account) ||
      !nonempty(row.txnId) || !dateOnly(row.date) || !nonempty(row.description) ||
      typeof row.amountCents !== "number" || !Number.isSafeInteger(row.amountCents) ||
      (row.bankRef !== undefined && !nonempty(row.bankRef))) return null;
  return {
    account: row.account as BankAccountKey,
    txnId: row.txnId,
    date: row.date,
    amountCents: row.amountCents,
    description: row.description,
    bankRef: typeof row.bankRef === "string" ? row.bankRef : null,
  };
}

function groupBy<T>(rows: T[], key: (row: T) => string | undefined) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    if (id === undefined) continue;
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

function accountAmounts() {
  return { operating: 0, payroll: 0, deposits: 0 };
}

/**
 * Read model for one simulation run. Balances are ledger book balances, never
 * bank-confirmed available funds. All journal cash movements are included;
 * a reversed original remains in history and its mirror cancels it out.
 */
export function buildBankWorkspace(runId: string, input: BankWorkspaceInput) {
  const run = input.run?.runId === runId ? input.run : null;
  const scoped = <T extends { runId: string }>(rows: T[]) => run ? rows.filter((row) => row.runId === runId) : [];
  const balances = scoped(input.balances);
  const entries = scoped(input.entries);
  const events = scoped(input.events).filter((event) => event.type === "bank.transaction");
  const tasks = scoped(input.tasks).filter((task) => task.type === "cash.match_bank_txn");
  const payments = scoped(input.payments);
  const asks = scoped(input.asks);

  const accounts = BANK_ACCOUNTS.map((account) => ({
    ...account,
    bookBalanceCents: balances.filter((balance) => balance.account === account.code)
      .reduce((total, balance) => total + balance.debits - balance.credits, 0),
    openingBalanceCents: 0,
    inflowCents: 0,
    outflowCents: 0,
    transactionCount: 0,
    needsReviewCount: 0,
  }));
  const accountsByCode = new Map(accounts.map((account) => [account.code as string, account]));
  const daily = new Map<string, { inflowCents: number; outflowCents: number; movement: ReturnType<typeof accountAmounts> }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const account = accountsByCode.get(line.account);
      if (!account) continue;
      account.inflowCents += line.debit;
      account.outflowCents += line.credit;
      let day = daily.get(entry.date);
      if (!day) daily.set(entry.date, day = { inflowCents: 0, outflowCents: 0, movement: accountAmounts() });
      day.inflowCents += line.debit;
      day.outflowCents += line.credit;
      day.movement[account.key] += line.debit - line.credit;
    }
  }
  for (const account of accounts) {
    // A derived starting amount reconciles the complete journal series to the
    // authoritative balance table, including any balance initialized separately.
    account.openingBalanceCents = account.bookBalanceCents - account.inflowCents + account.outflowCents;
  }
  const running = accountAmounts();
  for (const account of accounts) running[account.key] = account.openingBalanceCents;
  const series = [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => {
    for (const account of accounts) running[account.key] += day.movement[account.key];
    return {
      date,
      balanceCents: running.operating + running.payroll + running.deposits,
      inflowCents: day.inflowCents,
      outflowCents: day.outflowCents,
      accountBalances: { ...running },
    };
  });

  const tasksByEvent = groupBy(tasks, (task) => {
    const eventId = object(task.payload)?.eventId;
    return typeof eventId === "string" ? eventId : undefined;
  });
  const asksByTask = groupBy(asks, (ask) => ask.taskId);
  const bankEntries = groupBy(entries.filter((entry) => entry.source.kind === "bank_match"), (entry) => entry.source.ref);
  const paymentEntries = groupBy(entries.filter((entry) => entry.source.kind === "payment_settlement"), (entry) => entry.source.ref);
  const reversals = groupBy(entries, (entry) => entry.reversalOf);
  const paymentsByRef = groupBy(payments, (payment) => payment.bankRef);

  let invalidTransactionCount = 0;
  const transactions: BankTransaction[] = [];
  for (const event of [...events].sort((a, b) => b.recordedAt - a.recordedAt || a._id.localeCompare(b._id))) {
    const payload = bankPayload(event.payload);
    if (!payload) {
      invalidTransactionCount += 1;
      continue;
    }
    const account = accounts.find((candidate) => candidate.key === payload.account)!;
    const eventTasks = [...(tasksByEvent.get(event._id) ?? [])].sort((a, b) => b.updatedAt - a.updatedAt || a._id.localeCompare(b._id));
    const task = eventTasks[0];
    const result = object(task?.result);
    const outcome = typeof result?.outcome === "string" ? result.outcome : null;
    const relatedAsks = eventTasks.flatMap((relatedTask) => asksByTask.get(relatedTask._id) ?? []);
    const refPayments = payload.bankRef ? paymentsByRef.get(payload.bankRef) ?? [] : [];
    const payment = refPayments.find((candidate) => candidate.status === "settled" && candidate.amountCents === -payload.amountCents) ?? refPayments[0];
    const directEntries = [
      ...(bankEntries.get(payload.txnId) ?? []),
      ...(payment ? paymentEntries.get(payment._id) ?? [] : []),
    ];
    const linkedEntries = [...new Map(directEntries.flatMap((entry) => [entry, ...(reversals.get(entry._id) ?? [])])
      .map((entry) => [entry._id, entry])).values()].sort((a, b) => a.sequence - b.sequence);
    const linkedMovement = linkedEntries.reduce((total, entry) => total + entry.lines
      .filter((line) => line.account === account.code).reduce((sum, line) => sum + line.debit - line.credit, 0), 0);
    const recorded = linkedEntries.some((entry) => entry.lines.some((line) => line.account === account.code)) &&
      linkedMovement === payload.amountCents;
    let status: BankTransactionStatus;
    if (relatedAsks.some((ask) => ask.status === "open") || task?.status === "failed" || task?.status === "waiting" ||
        ["flagged", "posted_flagged", "mismatch", "disputed"].includes(outcome ?? "") ||
        linkedEntries.some((entry) => entry.status === "reversed")) {
      status = "needs_review";
    } else if (task?.status === "queued" || task?.status === "leased") {
      status = "processing";
    } else if (task?.status === "done" && outcome === "reconciled") {
      // A completed task alone cannot establish a match if its payment or
      // accounting evidence has since changed or no longer agrees with the feed.
      status = payload.account === "operating" && payment?.status === "settled" &&
        payment.amountCents === -payload.amountCents && recorded ? "reconciled" : "needs_review";
    } else if (recorded) {
      status = "recorded";
    } else {
      status = "unmatched";
    }
    account.transactionCount += 1;
    if (status === "needs_review") account.needsReviewCount += 1;
    transactions.push({
      id: event._id,
      txnId: payload.txnId,
      date: payload.date,
      accountKey: payload.account,
      accountCode: account.code,
      description: payload.description,
      amountCents: payload.amountCents,
      bankRef: payload.bankRef,
      status,
      taskId: task?._id ?? null,
      taskOutcome: outcome,
      summary: typeof result?.summary === "string" ? result.summary : null,
      entries: linkedEntries.map((entry) => ({
        id: entry._id, sequence: entry.sequence, date: entry.date, memo: entry.memo,
        status: entry.status, decisionPath: entry.decisionPath ?? null,
      })),
      payment: payment ? { id: payment._id, payee: payment.payee, status: payment.status } : null,
      asks: relatedAsks.map((ask) => ({ id: ask._id, title: ask.title, status: ask.status, severity: ask.severity, to: ask.to })),
    });
  }
  transactions.sort((a, b) => b.date.localeCompare(a.date));
  const count = (status: BankTransactionStatus) => transactions.filter((transaction) => transaction.status === status).length;
  return {
    run: run ? { runId: run.runId, label: run.label, simDate: run.simDate } : null,
    accounts,
    totals: {
      bookBalanceCents: accounts.reduce((sum, account) => sum + account.bookBalanceCents, 0),
      openingBalanceCents: accounts.reduce((sum, account) => sum + account.openingBalanceCents, 0),
      inflowCents: accounts.reduce((sum, account) => sum + account.inflowCents, 0),
      outflowCents: accounts.reduce((sum, account) => sum + account.outflowCents, 0),
      transactionCount: transactions.length,
      needsReviewCount: count("needs_review"),
      reconciledCount: count("reconciled"),
      recordedCount: count("recorded"),
      processingCount: count("processing"),
      unmatchedCount: count("unmatched"),
    },
    series,
    transactions,
    dataBasis: {
      label: "Simulation · book balances",
      description: "Balances come from the ledger, not a live bank connection. Cash movements include all journal debits and credits, including reversals. Opening balances are derived from book balances less those movements. Recorded transactions have accounting entries; reconciled transactions also have a confirmed payment match.",
      firstDate: series[0]?.date ?? null,
      lastDate: series.at(-1)?.date ?? null,
      latestTransactionDate: transactions[0]?.date ?? null,
      invalidTransactionCount,
    },
  };
}

export type BankWorkspace = ReturnType<typeof buildBankWorkspace>;
