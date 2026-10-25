import type { MutationCtx } from "../_generated/server";
import { appendEntry, type PostInput } from "./post";

export function validDemoDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp = Date.parse(date + "T00:00:00.000Z");
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}
function sum(a: number, b: number) {
  const result = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(result)) throw new Error("Unsafe cumulative accounting cents");
  return result;
}
/** Validate all cumulative amounts before the shared journal writer makes any changes. */
export async function appendDemoEntry(ctx: MutationCtx, input: PostInput) {
  if (!validDemoDate(input.date)) throw new Error("Invalid accounting calendar date");
  const grouped = new Map<string, {debit:number;credit:number}>();
  let totalDebit = 0, totalCredit = 0;
  for (const line of input.lines) {
    totalDebit = sum(totalDebit, line.debit); totalCredit = sum(totalCredit, line.credit);
    const row = grouped.get(line.account) ?? {debit:0,credit:0};
    row.debit = sum(row.debit, line.debit); row.credit = sum(row.credit, line.credit);
    grouped.set(line.account, row);
  }
  for (const [account, delta] of grouped) {
    const balances = await ctx.db.query("balances").withIndex("by_run_account_period", q => q.eq("runId", input.runId).eq("account", account)).collect();
    let debit = delta.debit, credit = delta.credit;
    for (const balance of balances) { debit = sum(debit, balance.debits); credit = sum(credit, balance.credits); }
  }
  const head = await ctx.db.query("ledgerHeads").withIndex("by_run", q => q.eq("runId", input.runId)).unique();
  sum(head?.sequence ?? 0, 1);
  return appendEntry(ctx, input);
}
