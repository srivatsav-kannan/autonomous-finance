// Control tests: each case performs an operation the finance controls must refuse, directly
// against the kernel and git memory, and records whether the control held.
// A failing case is a real finding, not a test bug. Run: npx tsx scripts/control-tests.ts
import fs from "node:fs";
import path from "node:path";
import "../src/core/env";
import type { Id } from "../convex/_generated/dataModel";
import { AdminClient, SeatClient, api, convex } from "../src/core/kernel-client";
import { ROLE_CAPABILITIES } from "../src/core/roles";
import { MemoryError, MemoryStore } from "../src/memory/store";
import type { Vendor } from "../src/memory/schemas";
import { createScenario } from "../src/world/scenario";

interface Case {
  id: string;
  control: string;
  held: boolean;
  detail: string;
  issue?: string;
}
const results: Case[] = [];
function record(id: string, control: string, held: boolean, detail: unknown, issue?: string) {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 220);
  results.push({ id, control, held, detail: text, issue });
  console.log(`${held ? "HELD  " : "BROKEN"} ${id.padEnd(28)} ${control}${held ? "" : `  -> ${text}`}`);
}

const runId = `controls-${Date.now().toString(36)}`;
const sc = await createScenario(runId, { seed: 3, storeCount: 1, start: "2026-01-01", days: 2, plantErrors: false }, "control tests");
const seat = (id: string) => new SeatClient(runId, id, sc.tokens[id]!);
const ap = seat("ap-clerk-1");
const pay = seat("payments");
const ctl = seat("controller");
const cfo = seat("cfo-agent");
const cash = seat("cash-app-1");
const admin = new AdminClient();
const mem = new MemoryStore(sc.memoryDir);
const gsp = (await mem.read<Vendor>("vendors/golden-state-produce.yaml"))!;
const remit = { bank: gsp.remitTo.bank, accountLast4: gsp.remitTo.accountLast4, memorySha: (await mem.blobSha("vendors/golden-state-produce.yaml"))! };
const line = (amount: number) => [{ description: "Produce", quantity: 1, unitCents: amount, amountCents: amount }];

// A real document event to reference where a case needs one.
const doc = await admin.client.mutation(api.admin.ingestEvent, {
  secret: admin.secret, runId, type: "document.received", externalId: "ctl-doc-1", occurredOn: "2026-01-02",
  payload: { kind: "invoice", channel: "email", from: "ar@gsproduce.example", subject: "Invoice CTL-1", text: "INVOICE CTL-1 total $120.00" },
});
const docId = doc.ok ? String(doc.eventId) : "missing";
async function newDoc(id: string, from = "ar@gsproduce.example") {
  const d = await admin.client.mutation(api.admin.ingestEvent, {
    secret: admin.secret, runId, type: "document.received", externalId: id, occurredOn: "2026-01-02",
    payload: { kind: "invoice", channel: "email", from, subject: id, text: `INVOICE ${id}` },
  });
  return d.ok ? String(d.eventId) : "missing";
}

// 1. A bill must be backed by a document the company actually received.
{
  const r = await ap.client.mutation(api.ap.recordBill, {
    ...ap.auth, idempotencyKey: "c1", vendor: "golden-state-produce", invoiceNumber: "NO-SUCH-DOC", invoiceDate: "2026-01-02",
    dueDate: "2026-01-16", lines: line(4_900_00), totalCents: 4_900_00, documentEventId: "never-received",
    decision: "approve", exceptions: [], expenseAccount: "5000",
  });
  record("bill-without-document", "bill must reference a received document", !r.ok, r.ok ? "bill recorded and approved with no source document" : (r as { error: string }).error);
}

// 2. One document can back at most one bill.
{
  const a = await ap.client.mutation(api.ap.recordBill, {
    ...ap.auth, idempotencyKey: "c2a", vendor: "golden-state-produce", invoiceNumber: "CTL-1", invoiceDate: "2026-01-02",
    dueDate: "2026-01-16", lines: line(120_00), totalCents: 120_00, documentEventId: docId, decision: "approve", exceptions: [], expenseAccount: "5000",
  });
  const b = await ap.client.mutation(api.ap.recordBill, {
    ...ap.auth, idempotencyKey: "c2b", vendor: "golden-state-produce", invoiceNumber: "CTL-1-B", invoiceDate: "2026-01-02",
    dueDate: "2026-01-16", lines: line(120_00), totalCents: 120_00, documentEventId: docId, decision: "approve", exceptions: [], expenseAccount: "5000",
  });
  record("one-document-two-bills", "a document backs at most one bill", a.ok && !b.ok, b.ok ? "second bill from the same document was approved" : "second bill refused");
}

// 3. Cash moves only with real bank evidence, whatever label the caller puts on the entry.
{
  const r = await cash.client.mutation(api.ledger.postEntry, {
    ...cash.auth, idempotencyKey: "c3", date: "2026-01-02", memo: "reconciling item", source: { kind: "bank_match", ref: "no-such-bank-txn" },
    lines: [{ account: "6900", debit: 5_000_00, credit: 0 }, { account: "1000", debit: 0, credit: 5_000_00 }],
  });
  record("cash-without-bank-evidence", "cash entries require a matching bank transaction", !r.ok, r.ok ? "posted $5,000 out of operating cash citing a bank transaction that doesn't exist" : (r as { error: string }).error, "#4");
}

// 4. AP clerks can't touch cash at all.
{
  const r = await ap.client.mutation(api.ledger.postEntry, {
    ...ap.auth, idempotencyKey: "c4", date: "2026-01-02", memo: "x", source: { kind: "bank_match", ref: "x" },
    lines: [{ account: "2000", debit: 100_00, credit: 0 }, { account: "1000", debit: 0, credit: 100_00 }],
  });
  record("ap-clerk-cash", "AP clerk has no cash posting rights", !r.ok, r.ok ? "AP clerk posted to cash" : (r as { error: string }).error);
}

// 5-7. Payment approval separation and thresholds.
const bills = await convex().query(api.ap.bills, { runId, status: "approved" });
const billId = bills[0]?._id;
if (billId) {
  const req = await pay.client.mutation(api.payments.requestPayment, {
    ...pay.auth, idempotencyKey: "c5", payee: "golden-state-produce", amountCents: bills[0]!.totalCents, method: "ach", remitTo: remit, billIds: [billId], dueDate: "2026-01-16",
  });
  const intentId = (req as { intentId?: Id<"paymentIntents"> }).intentId;
  if (intentId) {
    const self = await pay.client.mutation(api.payments.approvePayment, { ...pay.auth, intentId });
    record("self-approval", "requester cannot approve own payment", !self.ok, self.ok ? "requester approved its own payment" : (self as { error: string }).error);
    const twice = await pay.client.mutation(api.payments.requestPayment, {
      ...pay.auth, idempotencyKey: "c6", payee: "golden-state-produce", amountCents: bills[0]!.totalCents, method: "ach", remitTo: remit, billIds: [billId], dueDate: "2026-01-16",
    });
    record("bill-paid-twice", "a bill can be in only one live payment", !twice.ok, twice.ok ? "second payment created for the same bill" : (twice as { error: string }).error);
  } else {
    record("self-approval", "requester cannot approve own payment", false, `setup failed: ${JSON.stringify(req)}`);
  }
}

// 8. Payments at or above the human threshold need a human, even with two agent approvals.
{
  const big = await ctl.client.mutation(api.ap.recordBill, {
    ...ctl.auth, idempotencyKey: "c8b", vendor: "golden-state-produce", invoiceNumber: "BIG-1", invoiceDate: "2026-01-02", dueDate: "2026-01-16",
    lines: line(60_000_00), totalCents: 60_000_00, documentEventId: await newDoc("ctl-doc-big"), decision: "approve", exceptions: [], expenseAccount: "5000",
  });
  const bigBill = (big as { billId?: Id<"bills"> }).billId;
  if (bigBill) {
    const req = await pay.client.mutation(api.payments.requestPayment, {
      ...pay.auth, idempotencyKey: "c8", payee: "golden-state-produce", amountCents: 60_000_00, method: "ach",
      remitTo: remit, billIds: [bigBill], dueDate: "2026-01-16",
    });
    const intentId = (req as { intentId: Id<"paymentIntents"> }).intentId;
    await ctl.client.mutation(api.payments.approvePayment, { ...ctl.auth, intentId });
    await cfo.client.mutation(api.payments.approvePayment, { ...cfo.auth, intentId });
    const state = await convex().query(api.payments.intent, { runId, intentId });
    record("human-threshold", "≥ $50k needs a human approval", state?.status === "pending_approval", `status after two agent approvals: ${state?.status}`);
  } else {
    record("human-threshold", "≥ $50k needs a human approval", false, `setup failed: ${JSON.stringify(big)}`);
  }
}

// 9. Agents can't staff control roles.
{
  const r = await cfo.client.mutation(api.seats.spawnSeat, {
    ...cfo.auth, newSeatId: "controller-2", role: "controller", name: "Controller 2", tokenHash: "x".repeat(64), reason: "test",
  });
  record("agent-staffs-controller", "an agent can't hire a control-role seat", !r.ok, r.ok ? "CFO agent hired a second controller" : (r as { error: string }).error);
}

// 10. Close needs controller + human.
{
  const r = await ctl.client.mutation(api.ledger.signClose, { ...ctl.auth, period: "2026-01" });
  const p = (r as { status?: string }).status;
  record("close-without-human", "period close needs a human signature", p === "open", `status after controller-only signature: ${p}`);
}

// 11. History is append-only: corrections are reversals, never edits.
{
  const before = await convex().query(api.ledger.verifyChain, { runId });
  record("ledger-chain", "ledger hash chain verifies", before.ok, before);
}

// 12-14. Memory controls: bank details need a proposal merged by a different, authorized seat.
{
  const hijack: Vendor = { ...gsp, remitTo: { ...gsp.remitTo, bank: "Coastline Digital Bank", accountLast4: "7766" } };
  let held = false;
  let detail = "direct write accepted";
  try {
    await mem.write({ changes: [{ path: "vendors/golden-state-produce.yaml", data: hijack }], author: { seatId: "payments", name: "Payments Agent" }, message: "update bank" });
  } catch (e) {
    held = e instanceof MemoryError && e.code === "controlled";
    detail = e instanceof Error ? e.message : String(e);
  }
  record("memory-direct-bank-change", "bank details can't be changed directly", held, detail);

  await mem.propose({ id: "ctl-remit", changes: [{ path: "vendors/golden-state-produce.yaml", data: hijack }], author: { seatId: "payments", name: "Payments Agent" }, message: "proposal" });
  let selfMerge = "merged";
  try {
    await mem.merge({ id: "ctl-remit", approver: { seatId: "payments", name: "Payments Agent" }, caps: ROLE_CAPABILITIES.payments, note: "self" });
  } catch (e) {
    selfMerge = e instanceof MemoryError ? e.code : String(e);
  }
  record("memory-self-merge", "proposer can't merge own change", selfMerge === "sod", selfMerge);
  let apMerge = "merged";
  try {
    await mem.merge({ id: "ctl-remit", approver: { seatId: "ap-clerk-1", name: "AP Clerk 1" }, caps: ROLE_CAPABILITIES.ap_clerk, note: "x" });
  } catch (e) {
    apMerge = e instanceof MemoryError ? e.code : String(e);
  }
  record("memory-unauthorized-merge", "only authorized seats merge bank changes", apMerge === "forbidden", apMerge);
}

// 17-19. Cash with real evidence: books once, can't be booked twice, and can be corrected by reversal.
{
  await admin.client.mutation(api.admin.ingestEvent, {
    secret: admin.secret, runId, type: "bank.transaction", externalId: "ctl-bank-1", occurredOn: "2026-01-02",
    payload: { account: "deposits", txnId: "ctl-bank-1", date: "2026-01-02", amountCents: 1_234_00, description: "ADYEN SETTLEMENT TEST" },
  });
  const lines = [{ account: "1020", debit: 1_234_00, credit: 0 }, { account: "1100", debit: 0, credit: 1_234_00 }];
  const first = await cash.client.mutation(api.ledger.postEntry, { ...cash.auth, idempotencyKey: "c17a", date: "2026-01-02", memo: "settlement", source: { kind: "bank_match", ref: "ctl-bank-1" }, lines });
  record("cash-with-evidence", "a real bank transaction can be booked", first.ok, first.ok ? "booked" : (first as { error: string }).error);
  const again = await cash.client.mutation(api.ledger.postEntry, { ...cash.auth, idempotencyKey: "c17b", date: "2026-01-02", memo: "settlement again", source: { kind: "bank_match", ref: "ctl-bank-1" }, lines });
  record("bank-txn-booked-twice", "a bank transaction is booked once", !again.ok, again.ok ? "same bank transaction booked twice" : (again as { error: string }).error);
  const wrongAmount = await cash.client.mutation(api.ledger.postEntry, {
    ...cash.auth, idempotencyKey: "c17c", date: "2026-01-02", memo: "inflated", source: { kind: "bank_match", ref: "ctl-bank-1" },
    lines: [{ account: "1020", debit: 9_999_00, credit: 0 }, { account: "1100", debit: 0, credit: 9_999_00 }],
  });
  record("cash-amount-mismatch", "cash amount must equal the bank transaction", !wrongAmount.ok, wrongAmount.ok ? "booked an amount different from the bank" : (wrongAmount as { error: string }).error);
  const entryId = (first as { entryId?: Id<"journalEntries"> }).entryId;
  const rev = entryId ? await ctl.client.mutation(api.ledger.reverseEntry, { ...ctl.auth, idempotencyKey: "c17d", entryId, date: "2026-01-02", reason: "matched to wrong store" }) : { ok: false, error: "no entry" };
  record("cash-correction-by-reversal", "cash entries can be corrected by reversal (#5)", rev.ok, rev.ok ? "reversed" : (rev as { error: string }).error, "#5");
  const reserved = await pay.client.mutation(api.ledger.postEntry, {
    ...pay.auth, idempotencyKey: "c17e", date: "2026-01-02", memo: "fake settlement", source: { kind: "payment_settlement", ref: "x" },
    lines: [{ account: "2000", debit: 100_00, credit: 0 }, { account: "1000", debit: 0, credit: 100_00 }],
  });
  // A reversal releases the bank transaction; reversing that reversal books it again.
  const rebook = await cash.client.mutation(api.ledger.postEntry, { ...cash.auth, idempotencyKey: "c17f", date: "2026-01-02", memo: "rematched", source: { kind: "bank_match", ref: "ctl-bank-1" }, lines });
  const rebookId = (rebook as { entryId?: Id<"journalEntries"> }).entryId;
  const rev1 = rebookId ? await ctl.client.mutation(api.ledger.reverseEntry, { ...ctl.auth, idempotencyKey: "c17g", entryId: rebookId, date: "2026-01-02", reason: "undo" }) : { ok: false };
  const rev1Id = (rev1 as { entryId?: Id<"journalEntries"> }).entryId;
  const rev2 = rev1Id ? await ctl.client.mutation(api.ledger.reverseEntry, { ...ctl.auth, idempotencyKey: "c17h", entryId: rev1Id, date: "2026-01-02", reason: "undo the undo" }) : { ok: false };
  const chained = await cash.client.mutation(api.ledger.postEntry, { ...cash.auth, idempotencyKey: "c17i", date: "2026-01-02", memo: "booked a third time", source: { kind: "bank_match", ref: "ctl-bank-1" }, lines });
  record("bank-txn-reversal-chain", "a re-reversed bank match still counts as booked", rebook.ok && rev2.ok && !chained.ok,
    !rebook.ok ? `setup: rebook after reversal refused: ${(rebook as { error: string }).error}` : !rev2.ok ? "setup: reversal chain failed" : chained.ok ? "booked the bank transaction again after a double reversal" : (chained as { error: string }).error);
  record("reserved-source-label", "kernel-only entry labels can't be posted directly", !reserved.ok, reserved.ok ? "posted a settlement-labelled entry directly" : (reserved as { error: string }).error);
}

// 20-21. Kernel-created entries (bill accruals, payment settlements) can't be undone by a mirror
// entry: that would move AP or cash and leave the bill and payment state stale (audit P1-3).
{
  const bill = await ctl.client.mutation(api.ap.recordBill, {
    ...ctl.auth, idempotencyKey: "c20a", vendor: "golden-state-produce", invoiceNumber: "SETTLE-1", invoiceDate: "2026-01-02", dueDate: "2026-01-16",
    lines: line(50_00), totalCents: 50_00, documentEventId: await newDoc("ctl-doc-settle"), decision: "approve", exceptions: [], expenseAccount: "5000",
  });
  const settleBill = (bill as { billId?: Id<"bills"> }).billId;
  const accrual = settleBill ? (await convex().query(api.ledger.entries, { runId, limit: 200 })).find((e) => e.source.kind === "bill" && e.source.ref === settleBill) : undefined;
  const revBill = accrual ? await ctl.client.mutation(api.ledger.reverseEntry, { ...ctl.auth, idempotencyKey: "c20b", entryId: accrual._id, date: "2026-01-02", reason: "undo accrual" }) : undefined;
  record("bill-accrual-reversal", "a bill accrual can't be reversed outside the bill flow", revBill !== undefined && !revBill.ok,
    !revBill ? `setup failed: ${JSON.stringify(bill)}` : revBill.ok ? "reversed a bill accrual; the bill stays approved with no liability" : (revBill as { error: string }).error);

  const req = settleBill ? await pay.client.mutation(api.payments.requestPayment, {
    ...pay.auth, idempotencyKey: "c21a", payee: "golden-state-produce", amountCents: 50_00, method: "ach", remitTo: remit, billIds: [settleBill], dueDate: "2026-01-16",
  }) : undefined;
  const intentId = (req as { intentId?: Id<"paymentIntents"> } | undefined)?.intentId;
  let settled: { ok: boolean; entryId?: Id<"journalEntries"> } | undefined;
  if (intentId) {
    await ctl.client.mutation(api.payments.approvePayment, { ...ctl.auth, intentId });
    await pay.client.mutation(api.payments.executePayment, { ...pay.auth, intentId, currentRemitTo: remit });
    settled = await pay.client.mutation(api.payments.settlePayment, { ...pay.auth, intentId, bankRef: "CTL-ACH-1", settledOn: "2026-01-02" });
  }
  const revSettle = settled?.entryId ? await pay.client.mutation(api.ledger.reverseEntry, { ...pay.auth, idempotencyKey: "c21b", entryId: settled.entryId, date: "2026-01-02", reason: "looks wrong" }) : undefined;
  const after = intentId ? await convex().query(api.payments.intent, { runId, intentId }) : undefined;
  record("settlement-reversal", "a payment settlement can't be reversed without bank evidence", revSettle !== undefined && !revSettle.ok && after?.status === "settled",
    !revSettle ? `setup failed: ${JSON.stringify(settled ?? req)}` : revSettle.ok ? "reversed a settlement: cash back up with no bank transaction, intent still settled" : (revSettle as { error: string }).error);
}

// 16. Asks: a seat can't answer its own question.
{
  const ask = await ap.client.mutation(api.asks.createAsk, {
    ...ap.auth, to: "ap_clerk", severity: "decision", title: "self", body: "x", evidence: [], options: [{ id: "yes", label: "Yes" }],
  });
  const askId = (ask as { askId?: Id<"asks"> }).askId;
  const r = askId ? await ap.client.mutation(api.asks.answerAsk, { ...ap.auth, askId, optionId: "yes" }) : { ok: false, error: "no ask" };
  record("answer-own-ask", "a seat can't answer its own ask", !r.ok, r.ok ? "seat answered its own ask" : (r as { error: string }).error);
}

const held = results.filter((r) => r.held).length;
console.log(`\n${held}/${results.length} controls held (run ${runId})`);
// --out DIR keeps a run's results out of the committed docs/evals (used by npm run evals).
const outIndex = process.argv.indexOf("--out");
const outDir = outIndex >= 0 ? process.argv[outIndex + 1]! : path.join("docs", "evals");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "control-tests.json"), JSON.stringify({ runId, at: new Date().toISOString(), held, total: results.length, results }, null, 2));
