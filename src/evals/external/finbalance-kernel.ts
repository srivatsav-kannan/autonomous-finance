// Books a FinBalance answer through the real ledger kernel (convex/ledger.ts postEntry) and
// derives the balance sheet from the kernel's trial balance plus the record's public opening
// balances, so the reported balance sheet is computed by the kernel, not written by a model.
//
// The kernel's chart is the company's (src/core/accounts.ts), so each FinBalance account the
// entries touch is bound, for this isolated benchmark run only, to a distinct kernel account of
// the same type. Revenue and expense accounts may share a code: only their total reaches the
// balance sheet (as retained earnings). FinBalance has no bank feed, so its Cash is bound to a
// non-cash kernel account; the kernel's bank-evidence control is not exercised here.
import { api } from "../../core/kernel-client";
import type { SeatRuntime } from "../../agents/runtime";
import { emptySections, round2, type ParsedSubmission } from "./finbalance";
import type { FinBalancePosting, Sections } from "./types";

export interface KernelLine { account: string; debit: number; credit: number; memo?: string }
export interface KernelLedger {
  post(entry: { idempotencyKey: string; date: string; memo: string; source: { kind: string; ref?: string }; lines: KernelLine[] }): Promise<{ ok: boolean; code?: string; error?: string; sequence?: number; hash?: string }>;
  trialBalance(): Promise<{ code: string; net: number }[]>;
}
export interface PublicContext {
  record_id: string;
  period_end: string;
  opening_balance: Sections;
  account_types: Record<string, string>;
  inconsistency_codes: Record<string, string>;
}

/** The authenticated seat's own kernel handle; the kernel enforces what the seat may post. */
export function seatLedger(rt: SeatRuntime): KernelLedger {
  return {
    post: async (entry) => await rt.kernel.client.mutation(api.ledger.postEntry, { ...rt.kernel.auth, ...entry }),
    trialBalance: async () => (await rt.kernel.client.query(api.ledger.trialBalance, { runId: rt.runId })).map((r) => ({ code: r.code, net: r.net })),
  };
}

// Non-cash kernel accounts by type. Cash accounts (1000/1010/1020) need bank evidence.
const POOLS: Record<string, string[]> = {
  asset: ["1100", "1110", "1150", "1200", "1300", "1500", "1600", "6900"],
  liability: ["2000", "2010", "2100", "2200", "2300", "2400"],
  equity: ["3000"],
  revenue: ["4000", "4010", "4020", "4090"],
  expense: ["5000", "5100", "5200", "5300", "5400", "5410", "6000", "6100", "6200"],
};
const pool = (type: string) => POOLS[type === "contra_asset" ? "asset" : type];

export class KernelMappingError extends Error {}

export interface Booking {
  balanceSheet: Sections;
  mapping: Record<string, string>;
  posted: { index: number; sequence?: number; hash?: string }[];
  skipped: { index: number; reason: string }[];
}

export async function bookThroughKernel(ledger: KernelLedger, ctx: PublicContext, entries: FinBalancePosting[], key: string): Promise<Booking> {
  const types = ctx.account_types;
  const mapping: Record<string, string> = {}, used = new Map<string, string[]>();
  const bind = (account: string): string => {
    if (mapping[account]) return mapping[account]!;
    const type = types[account]!, codes = pool(type);
    if (!codes) throw new KernelMappingError(`No kernel account pool for FinBalance type ${type}`);
    const free = codes.find((c) => !used.has(c));
    let code = free;
    if (!code) {
      // Only income-statement totals matter downstream; balance-sheet accounts need their own code.
      if (type !== "revenue" && type !== "expense") throw new KernelMappingError(`Kernel chart has only ${codes.length} non-cash ${type} account(s); entries need more`);
      code = codes.at(-1)!;
    }
    used.set(code, [...(used.get(code) ?? []), account]);
    return (mapping[account] = code);
  };
  const posted: Booking["posted"] = [], skipped: Booking["skipped"] = [];
  for (const [index, e] of entries.entries()) {
    const unknown = [e.debit_account, e.credit_account].filter((a) => !(a in types));
    // FinBalance's own reconstruction drops entries that name unknown accounts.
    if (unknown.length) { skipped.push({ index, reason: `unknown account ${unknown.join(", ")}` }); continue; }
    if (!Number.isFinite(e.amount)) { skipped.push({ index, reason: "non-finite amount" }); continue; }
    let cents = Math.round(round2(e.amount) * 100), debit = e.debit_account, credit = e.credit_account;
    if (cents === 0) { skipped.push({ index, reason: "zero amount has no effect" }); continue; }
    // A negative posting has the same effect as the positive one with sides swapped.
    if (cents < 0) { cents = -cents; [debit, credit] = [credit, debit]; }
    const result = await ledger.post({
      idempotencyKey: `${key}:entry:${index + 1}`, date: ctx.period_end,
      memo: `FinBalance ${ctx.record_id} entry ${index + 1}: ${debit} / ${credit} [${e.doc_refs.join(", ")}]`.slice(0, 500),
      source: { kind: "adjustment", ref: `finbalance:${ctx.record_id}:${index + 1}` },
      lines: [{ account: bind(debit), debit: cents, credit: 0, memo: debit }, { account: bind(credit), debit: 0, credit: cents, memo: credit }],
    });
    if (result.ok) posted.push({ index, sequence: result.sequence, hash: result.hash });
    else skipped.push({ index, reason: `kernel refused: ${result.code ?? "error"} ${result.error ?? ""}`.trim() });
  }
  const nets = new Map((await ledger.trialBalance()).map((r) => [r.code, r.net]));
  for (const code of nets.keys()) if (!used.has(code) && nets.get(code) !== 0) throw new KernelMappingError(`Kernel run has unexpected activity on account ${code}`);
  // Opening balances in cents, then each bound account's kernel net (debits - credits).
  const balances = new Map<string, number>();
  for (const section of ["assets", "liabilities", "equity"] as const)
    for (const [account, value] of Object.entries(ctx.opening_balance[section] ?? {})) balances.set(account, Math.round(round2(Number(value)) * 100));
  let incomeCents = 0;
  for (const [code, accounts] of used) {
    const net = nets.get(code) ?? 0, type = types[accounts[0]!]!;
    if (type === "revenue") incomeCents -= net;
    else if (type === "expense") incomeCents -= net;
    else {
      const account = accounts[0]!;
      balances.set(account, (balances.get(account) ?? 0) + (type === "asset" ? net : -net));
    }
  }
  const sheet = emptySections();
  const section: Record<string, keyof Sections> = { asset: "assets", contra_asset: "assets", liability: "liabilities", equity: "equity" };
  for (const [account, cents] of balances) {
    const type = types[account];
    if (!type) throw new KernelMappingError(`Opening balance names unknown account ${account}`);
    if (type === "revenue" || type === "expense") { incomeCents += (type === "revenue" ? cents : -cents); continue; }
    const rendered = type === "contra_asset" ? -cents : cents;
    if (rendered !== 0) sheet[section[type]!][account] = rendered / 100;
  }
  if (incomeCents !== 0) sheet.equity["Retained Earnings"] = Math.round((sheet.equity["Retained Earnings"] ?? 0) * 100 + incomeCents) / 100;
  return { balanceSheet: sheet, mapping, posted, skipped };
}

/** The submitted answer with the kernel-computed balance sheet replacing the model's. */
export function bookedAnswer(parsed: ParsedSubmission, sheet: Sections): string {
  return JSON.stringify({ has_inconsistency: parsed.has_inconsistency, inconsistency_codes: parsed.inconsistency_codes, inconsistency_notes: parsed.inconsistency_notes, entries: parsed.entries, balance_sheet: sheet });
}
