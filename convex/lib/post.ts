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
const CASH_SOURCES = new Set(["payment_settlement", "bank_match", "payroll_funding"]);

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
  }
  if (debits !== credits) return `entry does not balance: debits ${debits} != credits ${credits}`;
  return null;
}

/** Append one balanced, hash-chained entry. Callers own idempotency. */
export async function appendEntry(
  ctx: MutationCtx,
  input: PostInput,
): Promise<Result<{ entryId: Id<"journalEntries">; sequence: number; hash: string }>> {
  const problem = validateLines(input.seat, input.source, input.lines);
  if (problem) return fail("invalid_entry", problem);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return fail("invalid_entry", `bad date ${input.date}`);

  const period = input.date.slice(0, 7);
  const periodDoc = await ctx.db
    .query("periods")
    .withIndex("by_run_period", (q) => q.eq("runId", input.runId).eq("period", period))
    .unique();
  if (!periodDoc) return fail("period_not_open", `period ${period} has not been opened`);
  if (periodDoc.status === "closed") return fail("period_closed", `period ${period} is closed; post a correction in an open period`);

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

  for (const line of input.lines) {
    const bal = await ctx.db
      .query("balances")
      .withIndex("by_run_account_period", (q) =>
        q.eq("runId", input.runId).eq("account", line.account).eq("period", period),
      )
      .unique();
    if (bal) {
      await ctx.db.patch(bal._id, { debits: bal.debits + line.debit, credits: bal.credits + line.credit });
    } else {
      await ctx.db.insert("balances", {
        runId: input.runId,
        account: line.account,
        period,
        debits: line.debit,
        credits: line.credit,
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
