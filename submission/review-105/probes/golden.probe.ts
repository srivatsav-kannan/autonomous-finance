import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { makeFunctionReference } from "convex/server";
const R = new URL("../../../", import.meta.url).pathname;
import { fixture as baseFixture, packet, refs } from "../../../tests/ap-system/accounting-fixture";
import { businessFixture } from "../../../tests/ap-system/business-fixture";
import { openFakeBank } from "../../../src/integrations/banking/fake";
import { ExecutePaymentEffect } from "../../../src/payments/application/execute-payment-effect";
import { ReconcilePaymentEvidence } from "../../../src/payments/application/reconcile-payment-evidence";
import { createConvexPaymentKernel } from "../../../src/payments/adapters/convex-payment-kernel";
import { createConvexPaymentEvidence } from "../../../src/payments/adapters/convex-payment-evidence";
import { intakeSchema, type APIntake } from "../../../src/ap-system/contracts";
import type { BusinessAcceptance } from "../../../src/ap-system/domain-contracts";

const requestPayment = makeFunctionReference<"mutation">("apCasePayments:request");
const authorizePayment = makeFunctionReference<"mutation">("apCasePayments:authorize");
const closeView = makeFunctionReference<"query">("apClose:view");
const start = Date.parse("2026-10-25T12:00:00Z");
const closers: (() => void)[] = [];
afterEach(() => { closers.splice(0).forEach((c) => c()); vi.useRealTimers(); vi.unstubAllEnvs(); });
const hash = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const sb = (d: APIntake["documents"][number]) => ({ sourceId: d.sourceId, revision: d.revision, sha256: d.sha256 });
const QTY = [5, 4, 3, 2];
// Copy of v2-independent originalPacket (real golden-state PDF bytes, transcribed facts)
function originalPacket(discrepancy = false): APIntake {
  const p = packet(discrepancy ? "INV-1001-QTY" : "INV-1001");
  const sourceTemplate = p.documents[0]!, fieldTemplate = p.candidate!.evidence[0]!;
  const names = [discrepancy ? "invoice-quantity-discrepancy" : "invoice", "purchase-order", "receipt", "contract"];
  const kinds = ["invoice", "purchase_order", "receipt", "contract"] as const;
  p.documents = names.map((name, i) => {
    const file = resolve(R, "fixtures/ap-system/golden-state-v1/input", name + ".pdf");
    const bytes = readFileSync(file);
    return { ...structuredClone(sourceTemplate), sourceId: "gs-" + name, deliveryId: "probe-" + name, name: name + ".pdf", kind: kinds[i]!, originalRef: file,
      originalBase64: bytes.toString("base64"), sha256: hash(bytes), byteLength: bytes.length, extractedText: "probe transcription",
      provenance: { kind: "synthetic", description: "probe", license: "probe", originalFilename: name + ".pdf" } };
  });
  const facts = [["KALE-24", "Organic Kale, 24ct case", discrepancy ? 6 : 5, 3850], ["ROM-CS", "Romaine Hearts, case", 4, 4275], ["AVO-48", "Hass Avocados, 48ct", 3, 6890], ["TOM-25", "Heirloom Tomatoes, 25lb", 2, 5420]] as const;
  const c = p.candidate!;
  c.invoiceNumber = discrepancy ? "INV-1001-QTY" : "INV-1001";
  c.sources = p.documents.map(sb);
  c.subtotalCents = c.totalCents = discrepancy ? 71710 : 67860;
  const fields: [string, string | number][] = [["extractedSupplierName", "Golden State Produce Co."], ["invoiceNumber", c.invoiceNumber], ["invoiceDate", "2026-10-19"], ["totalCents", c.totalCents]];
  c.lines = facts.map(([sku, description, qty, price], i) => {
    const lineId = `line-${i + 1}`, amount = qty * price;
    fields.push([`lines.${lineId}.sku`, sku], [`lines.${lineId}.description`, description], [`lines.${lineId}.quantity`, String(qty)], [`lines.${lineId}.unitPriceCents`, price], [`lines.${lineId}.amountCents`, amount]);
    return { ...structuredClone(c.lines[0]!), lineId, sku, description, quantity: { decimal: String(qty), unit: "case" }, unitPriceCents: price, amountCents: amount, evidenceIds: [], poLineId: "po-" + lineId, receiptLineIds: ["receipt-" + lineId], allocations: [{ ...c.lines[0]!.allocations[0]!, amountCents: amount }] };
  });
  c.evidence = fields.map(([path, value]) => ({ ...structuredClone(fieldTemplate), evidenceId: "p-" + path, fieldPath: path, rawValue: String(value), normalizedValue: value, quote: String(value), source: sb(p.documents[0]!) }));
  c.lines.forEach((l) => (l.evidenceIds = c.evidence.filter((e) => e.fieldPath.startsWith(`lines.${l.lineId}.`)).map((e) => e.evidenceId)));
  p.extraction.evidence = c.evidence;
  p.purchasingEvidence = [1, 2, 3].map((i) => ({
    supplierId: "golden-state-produce", source: sb(p.documents[i]!), kind: kinds[i] as "purchase_order" | "receipt" | "contract",
    reference: ["", "PO-GS-20261019-001", "DLV-sf-hayes-valley-20261019-GOL", "CONTRACT-GS-2026"][i]!,
    acceptedBy: i === 2 ? "Fixture Receiving Operator (simulated)" : null, acceptedAt: i === 2 ? "2026-10-19T10:00:00Z" : null,
    lines: c.lines.map((l, n) => ({ lineId: (i === 1 ? "po-" : i === 2 ? "receipt-" : "contract-") + l.lineId, sku: l.sku!, quantity: { decimal: String(QTY[n]), unit: "case" }, unitPriceCents: i === 2 ? null : l.unitPriceCents, invoiceLineId: l.lineId })),
  }));
  return intakeSchema.parse(p);
}
function bank(f: any) {
  const b = openFakeBank({ path: ":memory:", scope: f.scope, seed: "probe", startTime: new Date(start).toISOString() });
  closers.push(() => b.close());
  let n = 0;
  const worker = new ExecutePaymentEffect(createConvexPaymentKernel(f.t, f.scope, "test-dispatch"), b.provider, "probe-worker", { now: Date.now, newLeaseToken: () => `probe-independent-lease-${++n}`, startHeartbeat: () => () => {} });
  const rec = new ReconcilePaymentEvidence(createConvexPaymentEvidence(f.t, f.scope, "test-evidence"), b.provider, f.scope, Date.now);
  return { b, worker, rec };
}
const dump = async (f: any, label: string) => {
  const js = await f.t.run((ctx: any) => ctx.db.query("journalEntries").collect());
  for (const j of js) {
    const dr = j.lines.reduce((n: number, l: any) => n + l.debit, 0), cr = j.lines.reduce((n: number, l: any) => n + l.credit, 0);
    console.log(`PROBE ${label} journal ${j.date} ${j.source.kind} ${j.lines.map((l: any) => (l.debit ? `Dr${l.account}:${l.debit}` : `Cr${l.account}:${l.credit}`)).join(" ")} balanced=${dr === cr}`);
  }
  const ap = js.flatMap((j: any) => j.lines).filter((l: any) => l.account === "2000").reduce((n: number, l: any) => n + l.credit - l.debit, 0);
  const exp = js.flatMap((j: any) => j.lines).filter((l: any) => l.account === "5000").reduce((n: number, l: any) => n + l.debit - l.credit, 0);
  const cash = js.flatMap((j: any) => j.lines).filter((l: any) => l.account === "1000").reduce((n: number, l: any) => n + l.debit - l.credit, 0);
  console.log(`PROBE ${label} totals AP(2000 credit balance)=${ap} expense5000=${exp} cash1000=${cash}`);
  return js;
};
function multiAcceptance(input: APIntake, qty: number[]): BusinessAcceptance {
  const c = input.candidate!;
  const po = input.purchasingEvidence.find((p) => p.kind === "purchase_order")!, rc = input.purchasingEvidence.find((p) => p.kind === "receipt")!;
  return { lines: c.lines.map((l, i) => { const q = qty[i]!, net = q * l.unitPriceCents; return { lineId: l.lineId, quantity: String(q), netCents: net, taxCents: 0, taxCode: "NONE", allocations: [{ ...l.allocations[0]!, amountCents: net }], procurement: "po" as const, agreement: { source: po.source, lineId: po.lines[i]!.lineId }, receipts: q ? [{ source: rc.source, lineId: rc.lines[i]!.lineId, quantity: String(q) }] : [] }; }),
    freightCents: 0, freightAllocations: [], discountCents: 0, discountAllocations: [], reason: "probe partial", resolutions: [] };
}
const catalog = [{ sku: "KALE-24", unit: "case", unitPriceCents: 3850 }, { sku: "ROM-CS", unit: "case", unitPriceCents: 4275 }, { sku: "AVO-48", unit: "case", unitPriceCents: 6890 }, { sku: "TOM-25", unit: "case", unitPriceCents: 5420 }];

describe("PROBE golden state", () => {
  it("G1 INV-1001 first-wave full path with FakeBank", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = await baseFixture();
    const ing = await f.t.mutation(refs.ingest, { ...f.ap, input: originalPacket() });
    const d = await f.get(ing.caseId);
    await f.human.mutation(refs.review, { scope: f.scope, input: f.request(d, "rv") });
    await f.human.mutation(refs.approve, { scope: f.scope, input: { ...f.request(d, "ap"), acceptedCents: 67860 } });
    const { b, worker, rec } = bank(f);
    const p = await f.t.mutation(requestPayment, { scope: f.scope, seatId: "payments", token: "token-payments", caseId: d.caseId, expectedRevision: d.revision, snapshotHash: d.snapshotHash, idempotencyKey: "pay" });
    await f.human.mutation(authorizePayment, { scope: f.scope, caseId: d.caseId, expectedRevision: d.revision, snapshotHash: d.snapshotHash, versionId: p.versionId, paymentSnapshotHash: p.snapshotHash });
    await worker.tick();
    const tr = b.harness.inspect().transfers;
    console.log("PROBE G1 transfers", tr.map((t: any) => [t.amountCents, t.destination.externalAccountId]));
    b.harness.settle(tr[0]!.id); await rec.tick(); await rec.tick();
    await dump(f, "G1");
    const dd = await f.get(d.caseId);
    console.log("PROBE G1 amounts", JSON.stringify(dd.amounts), "states", JSON.stringify(dd.states));
    // replay reconciliation; must not post again
    await rec.tick(); const js = await f.t.run((ctx: any) => ctx.db.query("journalEntries").collect());
    console.log("PROBE G1 journals after replay", js.length);
  });
  it("G2 INV-1001-QTY is held (first wave) and cannot be approved", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = await baseFixture();
    const ing = await f.t.mutation(refs.ingest, { ...f.ap, input: originalPacket(true) });
    const d = await f.get(ing.caseId);
    console.log("PROBE G2 status", d.states.business, "exceptions", d.exceptions.map((e: any) => e.code).join(","));
    await f.human.mutation(refs.review, { scope: f.scope, input: f.request(d, "rv") });
    let o = "approved";
    try { await f.human.mutation(refs.approve, { scope: f.scope, input: { ...f.request(d, "ap"), acceptedCents: 71710 } }); } catch (e) { o = (e as Error).message.slice(0, 220); }
    console.log("PROBE G2 approve full 71710:", o);
    let o2 = "approved";
    try { await f.human.mutation(refs.approve, { scope: f.scope, input: { ...f.request(d, "ap2"), acceptedCents: 67860 } }); } catch (e) { o2 = (e as Error).message.slice(0, 220); }
    console.log("PROBE G2 approve short 67860:", o2);
    await dump(f, "G2");
  });
  it("G3 I2-style partial 2/2/1/1, cash 10000, then close view; then QTY original competing for same receipt", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const input = originalPacket();
    const f = await businessFixture({ input, onboard: false });
    await f.onboard({ ...f.supplier, catalog });
    const a = multiAcceptance(input, [2, 2, 1, 1]);
    const prop = await f.propose(f.detail, a, "i2");
    console.log("PROBE G3 proposal amount", prop.amountCents, "route", prop.route.map((s: any) => s.groupId).join(">"));
    let r = await f.vote(prop); if (r.status === "pending") r = await f.vote(prop, "finance");
    console.log("PROBE G3 recognition", r.status);
    const { b, worker, rec } = bank(f);
    const p = await f.t.mutation(requestPayment, { scope: f.scope, seatId: "payments", token: "token-payments", caseId: f.detail.caseId, expectedRevision: f.detail.revision, snapshotHash: f.detail.snapshotHash, idempotencyKey: "pay", amountCents: 10000 });
    await f.human.mutation(authorizePayment, { scope: f.scope, caseId: f.detail.caseId, expectedRevision: f.detail.revision, snapshotHash: f.detail.snapshotHash, versionId: p.versionId, paymentSnapshotHash: p.snapshotHash });
    await worker.tick(); const tr = b.harness.inspect().transfers; b.harness.settle(tr[0]!.id); await rec.tick(); await rec.tick();
    await dump(f, "G3");
    const dd = await f.get(f.detail.caseId);
    console.log("PROBE G3 amounts", JSON.stringify(dd.amounts));
    const view = await f.humans.finance!.query(closeView, { scope: f.scope, period: "2026-10" });
    console.log("PROBE G3 close ready", view.ready, "recon", JSON.stringify(view.reconciliation));
    console.log("PROBE G3 blockers", view.blockers.map((x: any) => `${x.code}@${x.reference}`).join(" | "));
    console.log("PROBE G3 unpaid", JSON.stringify(view.unpaidBills));
    // Now the separate QTY original for the same delivery
    const q = originalPacket(true); q.idempotencyKey = "qty"; q.documents.slice(1).forEach((d) => (d.deliveryId += "-qty"));
    const dq = await f.reviewed(q);
    let o = "accepted";
    try { const pq = await f.propose(dq, multiAcceptance(q, [5, 0, 0, 0]), "qty"); o = `proposal ok ${pq.amountCents}`; } catch (e) { o = (e as Error).message.slice(0, 220); }
    console.log("PROBE G3 QTY invoice accept 5 kale (3 kale left on receipt):", o);
    let o2 = "accepted";
    try { const pq = await f.propose(dq, multiAcceptance(q, [3, 2, 2, 1]), "qty2"); o2 = `proposal ok ${pq.amountCents}`; } catch (e) { o2 = (e as Error).message.slice(0, 220); }
    console.log("PROBE G3 QTY invoice accept remaining receipt units 3/2/2/1 of same delivery:", o2);
  });
  it("G4 duplicate deliveries of INV-1001", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = await baseFixture();
    const one = await f.t.mutation(refs.ingest, { ...f.ap, input: originalPacket() });
    const renamed = originalPacket(); renamed.idempotencyKey = "renamed"; renamed.documents.forEach((d) => { d.name = "COPY-" + d.name; d.deliveryId += "-2"; });
    const two = await f.t.mutation(refs.ingest, { ...f.ap, input: renamed });
    console.log("PROBE G4 renamed same bytes:", one.caseId === two.caseId, JSON.stringify(two));
    const resent = originalPacket(); resent.idempotencyKey = "resent";
    const inv = resent.documents[0]!; const bytes = Buffer.concat([Buffer.from(inv.originalBase64!, "base64"), Buffer.from("\n%resend\n")]);
    inv.originalBase64 = bytes.toString("base64"); inv.sha256 = hash(bytes); inv.byteLength = bytes.length; inv.sourceId = "gs-invoice-resend"; inv.deliveryId = "resend";
    resent.candidate!.sources = resent.documents.map(sb); resent.candidate!.evidence.forEach((e) => (e.source = sb(inv))); resent.extraction.evidence = resent.candidate!.evidence;
    let o = ""; try { const three = await f.t.mutation(refs.ingest, { ...f.ap, input: resent }); o = `same case=${three.caseId === one.caseId} dup=${three.duplicate}`; } catch (e) { o = (e as Error).message.slice(0, 200); }
    console.log("PROBE G4 different bytes, same facts:", o);
    const changed = structuredClone(resent); changed.idempotencyKey = "changed"; changed.candidate!.dueDate = "2026-11-30";
    let o2 = ""; try { await f.t.mutation(refs.ingest, { ...f.ap, input: changed }); o2 = "accepted"; } catch (e) { o2 = (e as Error).message.slice(0, 200); }
    console.log("PROBE G4 different bytes, same number, changed due date:", o2);
    const spaced = structuredClone(resent); spaced.idempotencyKey = "spaced"; spaced.candidate!.invoiceNumber = "INV 01001"; spaced.candidate!.evidence.find((e) => e.fieldPath === "invoiceNumber")!.normalizedValue = "INV 01001";
    let o3 = ""; try { const s = await f.t.mutation(refs.ingest, { ...f.ap, input: spaced }); o3 = `same case=${s.caseId === one.caseId} dup=${s.duplicate}`; } catch (e) { o3 = (e as Error).message.slice(0, 200); }
    console.log("PROBE G4 'INV 01001' spelling:", o3);
    const cases = await f.t.run((ctx: any) => ctx.db.query("apCaseRecords").collect());
    console.log("PROBE G4 case count", cases.length);
  });
});
