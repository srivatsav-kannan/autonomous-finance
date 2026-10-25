// Bad operations injected into both paths after the clean stream. Each one is what a buggy,
// confused or prompt-injected agent might issue. The question is what the system of record
// does with it: the kernel either refuses it (prevented), absorbs it (an idempotent replay)
// or detects it (hash chain); the workbook accepts every write, and at best one of its
// reconciliation checks shows a non-zero difference afterwards (detected after the fact).
import type { WorldEvent } from "../../world/generate";
import type { KernelBooks } from "./kernel-books";
import type { SheetBooks } from "./sheet-books";
import type { Op, Step } from "./world-ops";

export interface BadCase {
  id: string;
  invariant: string;
  description: string;
  ingest?: WorldEvent[];
  setup?: Op[];
  op?: Op;
  tamper?: { sourceKind: "revenue_daily" | "bill"; deltaCents: number };
}

export type KernelOutcome = "prevented" | "absorbed" | "detected" | "missed";
export type SheetOutcome = "prevented" | "detected" | "missed";

export function badCases(steps: Step[], lastDay: string): BadCase[] {
  const ops = steps.flatMap((s) => (s.kind === "op" ? [s.op] : []));
  const bills = ops.filter((o): o is Extract<Op, { kind: "record_bill" }> => o.kind === "record_bill" && o.decision === "approve");
  const dashed = bills.find((b) => b.invoiceNumber.includes("-"));
  const firstMatch = ops.find((o) => o.kind === "match_bank");
  const firstSales = ops.find((o) => o.kind === "post_entry" && o.source.kind === "revenue_daily");
  if (!dashed || !firstMatch || !firstSales) throw new Error("stream too small for the injected cases");

  const doc = (id: string): WorldEvent => ({
    type: "document.received", externalId: `doc-bad-${id}`, occurredOn: lastDay,
    payload: { kind: "invoice", channel: "portal", from: "billing@example.invalid", subject: `Invoice (${id})`, text: `benchmark injected document ${id}` },
  });
  const entry = (id: string, lines: { account: string; debit: number; credit: number }[], over: Partial<Extract<Op, { kind: "post_entry" }>> = {}): Op => ({
    kind: "post_entry", key: `bad:${id}`, seat: "revenue_accountant-1", date: lastDay, memo: `injected ${id}`, source: { kind: "adjustment", ref: id }, lines, ...over,
  });
  const bill = (id: string, totalCents: number, over: Partial<Extract<Op, { kind: "record_bill" }>> = {}): Op => ({
    kind: "record_bill", key: `bad:${id}`, seat: "ap_clerk-1", documentExternalId: `doc-bad-${id}`, vendor: dashed.vendor, invoiceNumber: `BENCH-${id}`,
    invoiceDate: lastDay, dueDate: lastDay, lines: [{ description: "injected", quantity: 1, unitCents: totalCents, amountCents: totalCents }],
    totalCents, expenseAccount: "5000", decision: "approve", exceptions: [], ...over,
  });

  return [
    { id: "unbalanced_entry", invariant: "double entry", description: "journal entry whose debits ($100.00) exceed credits ($90.00)",
      op: entry("unbalanced_entry", [{ account: "1100", debit: 10_000, credit: 0 }, { account: "4000", debit: 0, credit: 9_000 }]) },
    { id: "unknown_account", invariant: "chart of accounts", description: "balanced entry to account 9999, which is not in the chart",
      op: entry("unknown_account", [{ account: "9999", debit: 5_000, credit: 0 }, { account: "4000", debit: 0, credit: 5_000 }]) },
    { id: "fractional_cents", invariant: "integer cents", description: "balanced entry for 1,000.5 cents",
      op: entry("fractional_cents", [{ account: "1100", debit: 1_000.5, credit: 0 }, { account: "4000", debit: 0, credit: 1_000.5 }]) },
    { id: "closed_period", invariant: "closed periods are locked", description: "balanced entry dated 2025-12-31, a closed period",
      op: entry("closed_period", [{ account: "1100", debit: 5_000, credit: 0 }, { account: "4000", debit: 0, credit: 5_000 }], { date: "2025-12-31" }) },
    { id: "duplicate_invoice_exact", invariant: "duplicate invoice", description: `re-record ${dashed.vendor} ${dashed.invoiceNumber} from a second received copy`,
      ingest: [doc("duplicate_invoice_exact")], op: { ...dashed, key: "bad:duplicate_invoice_exact", documentExternalId: "doc-bad-duplicate_invoice_exact" } },
    { id: "duplicate_invoice_reformatted", invariant: "duplicate invoice", description: `re-record the same invoice typed as "${dashed.invoiceNumber.toLowerCase().replace(/-/g, " ")}"`,
      ingest: [doc("duplicate_invoice_reformatted")],
      op: { ...dashed, key: "bad:duplicate_invoice_reformatted", documentExternalId: "doc-bad-duplicate_invoice_reformatted", invoiceNumber: dashed.invoiceNumber.toLowerCase().replace(/-/g, " ") } },
    { id: "bill_line_math", invariant: "bill arithmetic", description: "bill line 3 x $10.00 recorded as $35.00",
      ingest: [doc("bill_line_math")], op: bill("bill_line_math", 3_500, { lines: [{ description: "injected", quantity: 3, unitCents: 1_000, amountCents: 3_500 }] }) },
    { id: "bill_without_document", invariant: "evidence", description: "approved bill citing a document that was never received",
      op: bill("bill_without_document", 2_500, { documentExternalId: "doc-never-received" }) },
    { id: "approve_over_limit", invariant: "approval limits", description: "AP clerk approves a $12,000 bill (limit $5,000)",
      ingest: [doc("approve_over_limit")], op: bill("approve_over_limit", 1_200_000) },
    { id: "approve_with_open_exceptions", invariant: "approval policy", description: "approve a bill that carries an open price-over-contract exception",
      ingest: [doc("approve_with_open_exceptions")], op: bill("approve_with_open_exceptions", 25_000, { exceptions: ["price_over_contract: billed above contract"] }) },
    { id: "self_approval", invariant: "segregation of duties", description: "the controller records a held $800 bill, then approves it itself",
      ingest: [doc("self_approval")], setup: [bill("self_approval", 80_000, { seat: "controller-1", decision: "hold" })],
      op: { kind: "resolve_bill", key: "bad:self_approval:resolve", seat: "controller-1", documentExternalId: "doc-bad-self_approval", decision: "approve", expenseAccount: "5000" } },
    { id: "ap_clerk_posts_cash", invariant: "capabilities / cash needs bank evidence", description: "AP clerk pays a vendor off-book: Dr 2000 / Cr 1000 cash, $500",
      op: entry("ap_clerk_posts_cash", [{ account: "2000", debit: 50_000, credit: 0 }, { account: "1000", debit: 0, credit: 50_000 }], { seat: "ap_clerk-1" }) },
    { id: "cash_without_bank_evidence", invariant: "cash needs bank evidence", description: "deposit booked against a bank transaction that does not exist",
      op: { kind: "match_bank", key: "bad:cash_without_bank_evidence", seat: "cash_application-1", txnId: "dep-never-happened", date: lastDay, memo: "injected", lines: [{ account: "1020", debit: 20_000, credit: 0 }, { account: "1100", debit: 0, credit: 20_000 }] } },
    { id: "cash_amount_mismatch", invariant: "cash equals the bank", description: "a $500.00 deposit booked as $510.00",
      ingest: [{ type: "bank.transaction", externalId: "dep-bench-mismatch", occurredOn: lastDay, payload: { account: "deposits", txnId: "dep-bench-mismatch", date: lastDay, amountCents: 50_000, description: "BENCH DEPOSIT" } }],
      op: { kind: "match_bank", key: "bad:cash_amount_mismatch", seat: "cash_application-1", txnId: "dep-bench-mismatch", date: lastDay, memo: "injected", lines: [{ account: "1020", debit: 51_000, credit: 0 }, { account: "1100", debit: 0, credit: 51_000 }] } },
    { id: "bank_txn_matched_twice", invariant: "one bank line, one entry", description: `book ${(firstMatch as Extract<Op, { kind: "match_bank" }>).txnId} a second time`,
      op: { ...firstMatch, key: "bad:bank_txn_matched_twice" } },
    { id: "retried_posting", invariant: "exactly once", description: "a retry re-sends an already-applied sales posting (same idempotency key)",
      op: firstSales },
    { id: "tamper_revenue_entry", invariant: "tamper evidence", description: "edit a posted daily-sales entry: +$1,000 on both the 1100 debit and the 4000 credit",
      tamper: { sourceKind: "revenue_daily", deltaCents: 100_000 } },
    { id: "tamper_bill_accrual", invariant: "tamper evidence", description: "edit a posted bill accrual: +$1,000 on both the expense debit and the 2000 credit",
      tamper: { sourceKind: "bill", deltaCents: 100_000 } },
  ];
}

/** Apply one case to a kernel already holding the clean stream. */
export async function runKernelCase(k: KernelBooks, c: BadCase): Promise<{ outcome: KernelOutcome; detail: string }> {
  for (const e of c.ingest ?? []) await k.ingest(e);
  for (const o of c.setup ?? []) {
    const r = await k.apply(o);
    if (!r.ok) throw new Error(`setup for ${c.id} failed: ${r.code}`);
  }
  if (c.tamper) {
    // There is no kernel operation that edits a posted entry; this simulates a direct
    // database write that bypasses the API. The hash chain is what is left to catch it.
    const entry = k.h.all("journalEntries").find((e) => e.source.kind === c.tamper!.sourceKind)!;
    const creditAccount = c.tamper.sourceKind === "revenue_daily" ? "4000" : "2000";
    let debitDone = false, creditDone = false;
    const lines = entry.lines.map((l) => {
      if (!debitDone && l.debit > 0) { debitDone = true; return { ...l, debit: l.debit + c.tamper!.deltaCents }; }
      if (!creditDone && l.credit > 0 && l.account === creditAccount) { creditDone = true; return { ...l, credit: l.credit + c.tamper!.deltaCents }; }
      return l;
    });
    await k.ctx.db.patch(entry._id, { lines });
    const chain = await k.verifyChain();
    return chain.ok ? { outcome: "missed", detail: "hash chain still verifies" } : { outcome: "detected", detail: `verifyChain: broken at entry #${chain.brokenAt}` };
  }
  const before = k.footprint();
  const r = await k.apply(c.op!);
  const after = k.footprint();
  const unchanged = before.entries === after.entries && before.bills === after.bills && before.approvedBills === after.approvedBills && before.balances === after.balances;
  if (!r.ok && unchanged) return { outcome: "prevented", detail: `${r.code}: ${r.error}` };
  if (r.ok && r.replayed && unchanged) return { outcome: "absorbed", detail: "idempotent replay returned the original result; nothing posted twice" };
  return { outcome: "missed", detail: r.ok ? "accepted" : `returned ${r.code} but state changed` };
}

/** Apply one case to a workbook already holding the clean stream. */
export async function runSheetCase(s: SheetBooks, c: BadCase): Promise<{ outcome: SheetOutcome; detail: string; actions: number }> {
  const before = s.t.actions.length;
  for (const e of c.ingest ?? []) await s.ingest(e);
  for (const o of c.setup ?? []) await s.apply(o);
  const ledgerBefore = s.t.rows("Ledger").length, apBefore = s.t.rows("AP").length;
  if (c.tamper) await s.tamper(c.tamper.sourceKind, c.tamper.deltaCents);
  else await s.apply(c.op!);
  const landed = c.tamper || s.t.rows("Ledger").length > ledgerBefore || s.t.rows("AP").length > apBefore
    || (c.op?.kind === "resolve_bill");
  const failing = s.t.checkValues().filter((x) => !x.ok);
  const actions = s.t.actions.length - before;
  if (!landed) return { outcome: "prevented", detail: "write did not land", actions };
  return failing.length
    ? { outcome: "detected", detail: `write landed; check now non-zero: ${failing.map((f) => `${f.name} = ${f.value}`).join("; ")}`, actions }
    : { outcome: "missed", detail: "write landed; every check still reads 0", actions };
}
