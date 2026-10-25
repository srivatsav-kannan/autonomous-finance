import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { account, isKnownAccount } from "../../src/core/accounts";
import { canPost } from "../../src/core/roles";
import { canonical, fail, sha256Hex, type Result, type Seat } from "./kernel";

export interface LineInput {
  account: string;
  debit: number;
  credit: number;
  memo?: string;
  dims?: { store?: string; vendor?: string; channel?: string; employee?: string };
}

export interface PostInput {
  runId: string;
  seat: Seat;
  date: string; // YYYY-MM-DD
  memo: string;
  source: { kind: string; ref?: string };
  lines: LineInput[];
  idempotencyKey: string;
  taskId?: string;
  decisionPath?: string;
  memorySha?: string;
  reversalOf?: Id<"journalEntries">;
}

// Cash moves only when real money moved: a settled payment or a bank match.
// "reversal" is only produced by ledger.reverseEntry (postEntry refuses it), which allows cash
// lines only when undoing a bank match chain; kernel-created entries cannot be reversed at all.
const CASH_SOURCES = new Set(["payment_settlement", "bank_match", "payroll_funding", "reversal"]);

export function validateLines(seat: Seat, source: { kind: string }, lines: LineInput[]): string | null {
  if (lines.length < 2) return "an entry needs at least two lines";
  let debits = 0;
  let credits = 0;
  for (const [i, line] of lines.entries()) {
    if (!isKnownAccount(line.account)) return `line ${i}: unknown account ${line.account}`;
    if (!Number.isSafeInteger(line.debit) || !Number.isSafeInteger(line.credit)) {
      return `line ${i}: amounts must be integer cents`;
    }
    if (line.debit < 0 || line.credit < 0) return `line ${i}: negative amounts are not allowed; swap sides`;
    if ((line.debit > 0) === (line.credit > 0)) return `line ${i}: exactly one of debit or credit must be positive`;
    if (!canPost(seat.caps, line.account)) {
      return `seat ${seat.seatId} (${seat.role}) may not post to ${line.account} ${account(line.account).name}`;
    }
    if (account(line.account).cash && !CASH_SOURCES.has(source.kind)) {
      return `cash account ${line.account} can only move through a payment settlement or bank match (source was ${source.kind})`;
    }
    debits += line.debit;
    credits += line.credit;
    if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits)) {
      return "entry totals must be safe integer cents";
    }
  }
  if (debits !== credits) return `entry does not balance: debits ${debits} != credits ${credits}`;
  return null;
}

/** Append one balanced, hash-chained entry. Returned failures never write; callers own idempotency. */
export async function appendEntry(
  ctx: MutationCtx,
  input: PostInput,
): Promise<Result<{ entryId: Id<"journalEntries">; sequence: number; hash: string }>> {
  const problem = validateLines(input.seat, input.source, input.lines);
  if (problem) return fail("invalid_entry", problem);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return fail("invalid_entry", `bad date ${input.date}`);
  const parsedDate = new Date(`${input.date}T00:00:00.000Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== input.date) {
    return fail("invalid_entry", `bad date ${input.date}`);
  }

  const period = input.date.slice(0, 7);
  const periodDoc = await ctx.db
    .query("periods")
    .withIndex("by_run_period", (q) => q.eq("runId", input.runId).eq("period", period))
    .unique();
  if (!periodDoc) return fail("period_not_open", `period ${period} has not been opened`);
  if (periodDoc.status === "closed") return fail("period_closed", `period ${period} is closed; post a correction in an open period`);

  // Preflight every resulting balance before writing any journal or ledger state.
  // Group repeated accounts so several individually safe lines cannot overflow a balance.
  const changes = new Map<string, { debits: number; credits: number }>();
  for (const line of input.lines) {
    const change = changes.get(line.account) ?? { debits: 0, credits: 0 };
    change.debits += line.debit;
    change.credits += line.credit;
    changes.set(line.account, change);
  }
  const balances: { id?: Id<"balances">; account: string; debits: number; credits: number }[] = [];
  for (const [accountCode, change] of changes) {
    const bal = await ctx.db
      .query("balances")
      .withIndex("by_run_account_period", (q) =>
        q.eq("runId", input.runId).eq("account", accountCode).eq("period", period),
      )
      .unique();
    const debits = (bal?.debits ?? 0) + change.debits;
    const credits = (bal?.credits ?? 0) + change.credits;
    if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits)) {
      return fail("invalid_entry", `balance for account ${accountCode} would exceed safe integer cents`);
    }
    balances.push({ id: bal?._id, account: accountCode, debits, credits });
  }

  const head = await ctx.db
    .query("ledgerHeads")
    .withIndex("by_run", (q) => q.eq("runId", input.runId))
    .unique();
  const prevHash = head?.hash ?? "genesis";
  const sequence = (head?.sequence ?? 0) + 1;
  const totalCents = input.lines.reduce((s, l) => s + l.debit, 0);

  const body = {
    sequence,
    date: input.date,
    memo: input.memo,
    source: input.source,
    lines: input.lines,
    postedBy: input.seat.seatId,
    decisionPath: input.decisionPath,
    memorySha: input.memorySha,
  };
  const hash = await sha256Hex(prevHash + canonical(body));

  const entryId = await ctx.db.insert("journalEntries", {
    runId: input.runId,
    sequence,
    date: input.date,
    period,
    memo: input.memo,
    source: input.source,
    lines: input.lines,
    totalCents,
    postedBy: input.seat.seatId,
    taskId: input.taskId,
    decisionPath: input.decisionPath,
    memorySha: input.memorySha,
    idempotencyKey: input.idempotencyKey,
    status: "posted",
    reversalOf: input.reversalOf,
    prevHash,
    hash,
    postedAt: Date.now(),
  });

  if (head) await ctx.db.patch(head._id, { hash, sequence });
  else await ctx.db.insert("ledgerHeads", { runId: input.runId, hash, sequence });

  for (const bal of balances) {
    if (bal.id) {
      await ctx.db.patch(bal.id, { debits: bal.debits, credits: bal.credits });
    } else {
      await ctx.db.insert("balances", {
        runId: input.runId,
        account: bal.account,
        period,
        debits: bal.debits,
        credits: bal.credits,
      });
    }
  }

  await ctx.db.insert("activity", {
    runId: input.runId,
    seatId: input.seat.seatId,
    kind: "posted",
    text: `#${sequence} ${input.memo} (${(totalCents / 100).toFixed(2)})`,
    refs: { entryId, decisionPath: input.decisionPath },
    at: Date.now(),
  });

  return { ok: true, entryId, sequence, hash };
}
