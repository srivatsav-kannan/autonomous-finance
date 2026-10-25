// Tries to break the kernel's invariants. Run: npx tsx scripts/smoke-kernel.ts
import "../src/core/env";
import { AdminClient, SeatClient, api, hashToken, newToken } from "../src/core/kernel-client";

const admin = new AdminClient();
const runId = `smoke-${Date.now()}`;
const tokens = { ap: newToken(), pay: newToken(), ctl: newToken(), cfo: newToken() };

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && detail ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!cond) failures++;
}

const created = await admin.client.mutation(api.admin.createRun, {
  secret: admin.secret,
  runId,
  label: "kernel smoke",
  company: "sweetgreen",
  simDate: "2026-01-02",
  periods: ["2026-01"],
  seats: [
    { seatId: "ap-clerk-1", role: "ap_clerk", name: "AP Clerk 1", kind: "agent", tokenHash: hashToken(tokens.ap) },
    { seatId: "payments-1", role: "payments", name: "Payments", kind: "agent", tokenHash: hashToken(tokens.pay) },
    { seatId: "controller-1", role: "controller", name: "Controller", kind: "agent", tokenHash: hashToken(tokens.ctl) },
    { seatId: "human-cfo", role: "human_cfo", name: "Human CFO", kind: "human", tokenHash: hashToken(tokens.cfo) },
  ],
});
check("create run", created.ok === true, created);

const ap = new SeatClient(runId, "ap-clerk-1", tokens.ap);
const pay = new SeatClient(runId, "payments-1", tokens.pay);
const ctl = new SeatClient(runId, "controller-1", tokens.ctl);
const cfo = new SeatClient(runId, "human-cfo", tokens.cfo);

const goodLines = [
  { account: "5000", debit: 12345, credit: 0 },
  { account: "2000", debit: 0, credit: 12345 },
];
const post1 = await ap.client.mutation(api.ledger.postEntry, {
  ...ap.auth, idempotencyKey: "k1", date: "2026-01-02", memo: "produce", source: { kind: "adjustment" }, lines: goodLines,
});
check("balanced entry posts", post1.ok === true, post1);

const replay = await ap.client.mutation(api.ledger.postEntry, {
  ...ap.auth, idempotencyKey: "k1", date: "2026-01-02", memo: "produce", source: { kind: "adjustment" }, lines: goodLines,
});
check("same key + same payload replays (no double post)", replay.ok === true && "replayed" in replay, replay);

const conflict = await ap.client.mutation(api.ledger.postEntry, {
  ...ap.auth, idempotencyKey: "k1", date: "2026-01-02", memo: "produce", source: { kind: "adjustment" },
  lines: [{ account: "5000", debit: 99999, credit: 0 }, { account: "2000", debit: 0, credit: 99999 }],
});
check("same key + different payload is a conflict", conflict.ok === false && conflict.code === "idempotency_conflict", conflict);

const unbalanced = await ap.client.mutation(api.ledger.postEntry, {
  ...ap.auth, idempotencyKey: "k2", date: "2026-01-02", memo: "bad", source: { kind: "adjustment" },
  lines: [{ account: "5000", debit: 100, credit: 0 }, { account: "2000", debit: 0, credit: 99 }],
});
check("unbalanced entry rejected", unbalanced.ok === false && unbalanced.code === "invalid_entry", unbalanced);

const cash = await ap.client.mutation(api.ledger.postEntry, {
  ...ap.auth, idempotencyKey: "k3", date: "2026-01-02", memo: "sneaky", source: { kind: "adjustment" },
  lines: [{ account: "2000", debit: 100, credit: 0 }, { account: "1000", debit: 0, credit: 100 }],
});
check("AP clerk cannot touch cash", cash.ok === false, cash);

const badToken = await new SeatClient(runId, "ap-clerk-1", "wrong").client.mutation(api.ledger.postEntry, {
  runId, seatId: "ap-clerk-1", token: "wrong", idempotencyKey: "k4", date: "2026-01-02", memo: "x", source: { kind: "adjustment" }, lines: goodLines,
});
check("bad token rejected", badToken.ok === false && badToken.code === "bad_token", badToken);

// Bill -> payment -> approval rules. Bills must cite documents the company received.
async function receive(externalId: string) {
  const r = await admin.client.mutation(api.admin.ingestEvent, {
    secret: admin.secret, runId, type: "document.received", externalId, occurredOn: "2026-01-02",
    payload: { kind: "invoice", channel: "email", from: "ar@produce.example", subject: externalId, text: externalId },
  });
  if (!r.ok) throw new Error(`ingest ${externalId}: ${r.error}`);
  return String(r.eventId);
}
const doc1 = await receive("doc-1");
const doc2 = await receive("doc-2");
const bill = await ap.client.mutation(api.ap.recordBill, {
  ...ap.auth, idempotencyKey: "bill-1", vendor: "v-produce", invoiceNumber: "INV-0042", invoiceDate: "2026-01-02",
  dueDate: "2026-01-16", lines: [{ description: "Kale, case", quantity: 10, unitCents: 3150, amountCents: 31500 }],
  totalCents: 31500, documentEventId: doc1, decision: "approve", exceptions: [], expenseAccount: "5000",
});
check("clean small bill auto-approved with accrual", bill.ok === true && Boolean((bill as { entryId?: unknown }).entryId), bill);

const dup = await ap.client.mutation(api.ap.recordBill, {
  ...ap.auth, idempotencyKey: "bill-1b", vendor: "v-produce", invoiceNumber: "inv 42", invoiceDate: "2026-01-03",
  dueDate: "2026-01-17", lines: [{ description: "Kale, case", quantity: 10, unitCents: 3150, amountCents: 31500 }],
  totalCents: 31500, documentEventId: doc2, decision: "approve", exceptions: [], expenseAccount: "5000",
});
check("kernel blocks duplicate invoice (INV-0042 vs inv 42)", dup.ok === false && dup.code === "duplicate_invoice", dup);

const billId = (bill as { billId: string }).billId as never;
const duplicateIds = await pay.client.mutation(api.payments.requestPayment, {
  ...pay.auth, idempotencyKey: "pay-duplicate-ids", payee: "v-produce", amountCents: 63000, method: "ach",
  remitTo: { bank: "First Produce Bank", accountLast4: "4321", memorySha: "abc" }, billIds: [billId, billId], dueDate: "2026-01-16",
});
check("repeating a bill ID cannot multiply a payment", duplicateIds.ok === false && duplicateIds.code === "invalid_payment", duplicateIds);
// Keep the remaining checks independent if this regression is run against an older backend.
if (duplicateIds.ok) await pay.client.mutation(api.payments.voidPayment, { ...pay.auth, intentId: duplicateIds.intentId, reason: "smoke cleanup" });
const intent = await pay.client.mutation(api.payments.requestPayment, {
  ...pay.auth, idempotencyKey: "pay-1", payee: "v-produce", amountCents: 31500, method: "ach",
  remitTo: { bank: "First Produce Bank", accountLast4: "4321", memorySha: "abc" }, billIds: [billId], dueDate: "2026-01-16",
});
check("payments agent requests payment", intent.ok === true, intent);
const intentId = (intent as { intentId: string }).intentId as never;

const selfApprove = await pay.client.mutation(api.payments.approvePayment, { ...pay.auth, intentId });
check("requester cannot approve own payment", selfApprove.ok === false && selfApprove.code === "sod", selfApprove);

const doublePay = await pay.client.mutation(api.payments.requestPayment, {
  ...pay.auth, idempotencyKey: "pay-2", payee: "v-produce", amountCents: 31500, method: "ach",
  remitTo: { bank: "First Produce Bank", accountLast4: "4321", memorySha: "abc" }, billIds: [billId], dueDate: "2026-01-16",
});
check("same bill cannot be paid twice", doublePay.ok === false && doublePay.code === "double_payment", doublePay);

const approve = await ctl.client.mutation(api.payments.approvePayment, { ...ctl.auth, intentId });
check("controller approves", approve.ok === true && (approve as { status: string }).status === "approved", approve);

const changed = await pay.client.mutation(api.payments.executePayment, {
  ...pay.auth, intentId, currentRemitTo: { bank: "Other Bank", accountLast4: "9999", memorySha: "def" },
});
check("remit-to change after approval voids payment", changed.ok === false && changed.code === "remit_changed", changed);

// Re-request, approve, execute, settle: AP and cash move together.
const intent2 = await pay.client.mutation(api.payments.requestPayment, {
  ...pay.auth, idempotencyKey: "pay-3", payee: "v-produce", amountCents: 31500, method: "ach",
  remitTo: { bank: "First Produce Bank", accountLast4: "4321", memorySha: "abc" }, billIds: [billId], dueDate: "2026-01-16",
});
const intent2Id = (intent2 as { intentId: string }).intentId as never;
const repeatedVoid = await pay.client.mutation(api.payments.voidPayment, { ...pay.auth, intentId, reason: "replayed cancellation" });
check("voiding an already voided payment is a replay", repeatedVoid.ok && "replayed" in repeatedVoid, repeatedVoid);
const reservedBill = await pay.client.query(api.ap.bill, { runId, billId });
check("old cancellation preserves the replacement payment reservation", reservedBill?.paymentIntentId === intent2Id, reservedBill);
const thirdIntent = await pay.client.mutation(api.payments.requestPayment, {
  ...pay.auth, idempotencyKey: "pay-after-replayed-void", payee: "v-produce", amountCents: 31500, method: "ach",
  remitTo: { bank: "First Produce Bank", accountLast4: "4321", memorySha: "abc" }, billIds: [billId], dueDate: "2026-01-16",
});
check("replayed cancellation cannot enable a third payment", thirdIntent.ok === false && thirdIntent.code === "double_payment", thirdIntent);
if (thirdIntent.ok) await pay.client.mutation(api.payments.voidPayment, { ...pay.auth, intentId: thirdIntent.intentId, reason: "smoke cleanup" });
await ctl.client.mutation(api.payments.approvePayment, { ...ctl.auth, intentId: intent2Id });
const exec = await pay.client.mutation(api.payments.executePayment, {
  ...pay.auth, intentId: intent2Id, currentRemitTo: { bank: "First Produce Bank", accountLast4: "4321", memorySha: "abc" },
});
check("execute approved payment", exec.ok === true, exec);
const settle = await pay.client.mutation(api.payments.settlePayment, { ...pay.auth, intentId: intent2Id, bankRef: "ACH-1", settledOn: "2026-01-05" });
const settleAgain = await pay.client.mutation(api.payments.settlePayment, { ...pay.auth, intentId: intent2Id, bankRef: "ACH-1", settledOn: "2026-01-05" });
check("settle posts once (second settle is a replay)", settle.ok === true && settleAgain.ok === true && "replayed" in settleAgain, { settle, settleAgain });

// Close needs controller + human
const s1 = await ctl.client.mutation(api.ledger.signClose, { ...ctl.auth, period: "2026-01" });
check("controller signature alone does not close", s1.ok === true && (s1 as { status: string }).status === "open", s1);
const s2 = await cfo.client.mutation(api.ledger.signClose, { ...cfo.auth, period: "2026-01" });
check("controller + human closes period", s2.ok === true && (s2 as { status: string }).status === "closed", s2);
const late = await ap.client.mutation(api.ledger.postEntry, {
  ...ap.auth, idempotencyKey: "k9", date: "2026-01-20", memo: "late", source: { kind: "adjustment" }, lines: goodLines,
});
check("closed period rejects posts", late.ok === false && late.code === "period_closed", late);

const chain = await admin.client.query(api.ledger.verifyChain, { runId });
check("hash chain verifies", chain.ok === true, chain);
const tb = await admin.client.query(api.ledger.trialBalance, { runId });
const totalNet = tb.reduce((s, r) => s + r.net, 0);
check("trial balance nets to zero", totalNet === 0, tb);

console.log(failures === 0 ? `\nALL PASS (run ${runId})` : `\n${failures} FAILURE(S) (run ${runId})`);
process.exit(failures === 0 ? 0 : 1);
