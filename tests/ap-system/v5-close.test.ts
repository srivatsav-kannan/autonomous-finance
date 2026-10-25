import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import { businessFixture, acceptance, binding, br } from "./business-fixture";
import type { CloseAction, Accrual, PeriodView } from "../../src/ap-system/close-contracts";
import type { SourceDocument } from "../../src/ap-system/contracts";
const refs = Object.fromEntries(["retainEvidence", "proposeStatement", "reviewStatement", "propose", "vote"].map(n => [n, makeFunctionReference<"mutation">(`apClose:${n}`)]));
const viewRef = makeFunctionReference<"query">("apClose:view"), exportRef = makeFunctionReference<"query">("apClose:accountingExport");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-31T20:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function setup(recognize = true) {
  const f = await businessFixture(), recognized = recognize ? await f.recognize() : null;
  let n = 0;
  async function retain(text: string, kind: SourceDocument["kind"] = "other") {
    const source = structuredClone(f.input.documents[0]!);
    Object.assign(source, { sourceId: `v5-close-${++n}`, deliveryId: `v5-delivery-${n}`, name: `v5-${n}.txt`, kind, mimeType: "text/plain", extractedText: text, originalBase64: Buffer.from(text).toString("base64"), byteLength: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") });
    return f.t.mutation(refs.retainEvidence!, { ...f.controller, source });
  }
  const proof = await retain("V5 independent synthetic opening: cash accounts 1000,1010,1020 zero; AP and accrued zero");
  const view = () => f.humans.finance!.query(viewRef, { scope: f.scope, period: "2026-10" }) as Promise<PeriodView>;
  const propose = (action: CloseAction) => f.t.mutation(refs.propose!, { ...f.controller, input: { action, idempotencyKey: `v5-propose-${++n}` } });
  const vote = (p: any, name: string) => f.humans[name]!.mutation(refs.vote!, { scope: f.scope, input: { actionId: p.actionId, actionHash: p.actionHash, idempotencyKey: `v5-vote-${p.actionId}-${name}`, outcome: "approved", reason: "Independent exact synthetic source and amount review" } });
  async function approve(action: CloseAction) {
    const p = await propose(action); let result: any;
    for (const s of p.route) result = await vote(p, s.groupId === "govern" ? "governor" : s.groupId === "owner" ? "owner" : "finance");
    return { p, result };
  }
  async function reviewStatement() {
    const source = await retain("V5 supplier statement: original GS-1042 outstanding 7700 cents");
    const p = await f.t.mutation(refs.proposeStatement!, { ...f.controller, idempotencyKey: `v5-statement-${++n}`, statement: { supplierId: f.supplier.supplierId, period: "2026-10", source, openingCents: 0, closingCents: 7700, lines: [{ lineId: "s1", date: "2026-10-19", reference: "GS-1042", amountCents: 7700, match: { kind: "bill", id: recognized!.billId } }] } });
    await f.humans.finance!.mutation(refs.reviewStatement!, { scope: f.scope, input: { ...p, snapshotHash: (await view()).reconciliationHash, idempotencyKey: `v5-statement-review-${++n}`, reason: "All original statement movements agree", resolutions: [] } });
  }
  async function close() {
    const v = await view();
    return approve({ kind: "close", period: v.period, snapshotHash: v.snapshotHash, opening: { ...v.opening, evidence: [proof], reason: "Compared retained bank and ledger opening" }, reason: "Close only fully accounted source evidence" });
  }
  const accrual = (): Accrual => ({ supplierId: f.supplier.supplierId, source: binding(f.input.documents[2]!), lineId: "receipt-line-1", sku: "KALE-24", unit: "case", description: "Two cases received", quantity: "2", capacityQuantity: "2", unitPriceCents: 3850, allocations: structuredClone(f.input.candidate!.lines[0]!.allocations), date: "2026-10-31", expectedInvoiceCaseId: f.detail.caseId, quote: f.input.documents[2]!.extractedText, reason: "Retain exact received obligation" });
  const exported = (input: any) => f.humans.finance!.query(exportRef, { scope: f.scope, input });
  return { ...f, recognized, proof, retain, view, proposeClose: propose, voteClose: vote, approveClose: approve, reviewStatement, close, accrual, exported };
}
describe("V5 independent close accounting", () => {
  it.each(["partial", "fully_reversed"] as const)("does not close a standalone two-unit receipt after %s accrual without accounting for remaining units", async mode => {
    const f = await setup();
    const quote = "V5 standalone receipt: supplier Golden State delivered 2 KALE-24 case at 3850 cents each on October 30; neither unit invoiced";
    const source = await f.retain(quote, "receipt");
    const accrual = { ...f.accrual(), source, lineId: "standalone-line", expectedInvoiceCaseId: null, quote, quantity: mode === "partial" ? "1" : "2" };
    accrual.allocations[0]!.amountCents = mode === "partial" ? 3850 : 7700;
    const a = await f.approveClose({ kind: "accrual", accrual });
    if (mode === "fully_reversed") await f.approveClose({ kind: "reverse_accrual", accrualId: a.result.accrualId, quantity: "2", date: "2026-10-31", evidence: [source], reason: "Explicit reversal does not itself declare original received units a non-obligation" });
    await f.reviewStatement();
    // Attempt the actual close, not merely an asserted UI blocker.
    await expect(f.close()).rejects.toThrow(/close_not_ready|received_not_invoiced/);
    expect((await f.view()).status).toBe("open");
  });
  it("rejects a close whose reviewed snapshot is changed by a new standalone original before final approval", async () => {
    const f = await setup(); await f.reviewStatement(); const v = await f.view();
    const p = await f.proposeClose({ kind: "close", period: v.period, snapshotHash: v.snapshotHash, opening: { ...v.opening, evidence: [f.proof], reason: "Verified opening" }, reason: "Proposed close" });
    await f.retain("New received service requires disposition", "receipt");
    await expect(f.voteClose(p, "governor")).rejects.toThrow(/close_not_ready/);
    expect((await f.view()).status).toBe("open");
    expect(await f.t.run(ctx => ctx.db.query("journalEntries").collect())).toHaveLength(1);
  });
  it("revalidates competing reclassification capacity and exports only the approved exact noncash change", async () => {
    const f = await setup();
    const action: CloseAction = { kind: "adjustment", originalEntryId: f.recognized!.entryId, date: "2026-10-31", fromAccount: "5000", toAccount: "1200", amountCents: 5000, store: "sf-hayes-valley", evidence: [f.proof], reason: "Correct original expense to inventory" };
    const [a,b] = [await f.proposeClose(action), await f.proposeClose(action)];
    await f.voteClose(a, "owner"); await f.voteClose(b, "owner");
    await f.voteClose(a, "finance");
    await expect(f.voteClose(b, "finance")).rejects.toThrow(/adjustment_exceeds_original|stale_close_action/);
    const e = await f.exported({ actionId: a.actionId });
    expect(e.accounting).toMatchObject({ kind: "cost_reclassification", amountCents: 5000, originalEntryId: f.recognized!.entryId, billId: f.recognized!.billId, journal: { lines: [{ account: "1200", debit: 5000, credit: 0 }, { account: "5000", debit: 0, credit: 5000 }] } });
    await expect(f.exported({ actionId: b.actionId })).rejects.toThrow(/export_approval/);
    await expect(f.proposeClose({ ...action, fromAccount: "1000" })).rejects.toThrow(/adjustment_original|adjustment_account/);
    expect(await f.t.run(ctx => ctx.db.query("journalEntries").collect())).toHaveLength(2);
    expect((await f.view()).reconciliation).toMatchObject({ apGLCents: 7700, apSubledgerCents: 7700, differenceCents: 0 });
  });
  it("rejects a second pending reversal after the first consumes its quantity and preserves exact remaining allocation cents", async () => {
    const f = await setup(false), accrual = f.accrual();
    accrual.allocations = [{ ...accrual.allocations[0]!, amountCents: 3851 }, { ...accrual.allocations[0]!, account: "1200", treatment: "inventory", amountCents: 3849 }];
    const a = await f.approveClose({ kind: "accrual", accrual });
    const action: CloseAction = { kind: "reverse_accrual", accrualId: a.result.accrualId, quantity: "1", date: "2026-10-31", evidence: [f.proof], reason: "Half original accrued units" };
    const first = await f.proposeClose(action), stale = await f.proposeClose(action);
    await f.voteClose(first, "owner"); await f.voteClose(stale, "owner");
    await f.voteClose(first, "finance");
    await expect(f.voteClose(stale, "finance")).rejects.toThrow(/stale_close_action/);
    await f.approveClose(action);
    const apps = await f.t.run(ctx => ctx.db.query("apAccrualApplications").collect());
    expect(apps.map(a => a.amountCents)).toEqual([3850,3850]);
    expect(apps.map(a => a.allocations.map((x: any) => x.amountCents))).toEqual([[1926,1924],[1925,1925]]);
    for (const app of apps) expect((await f.exported({ accrualApplicationId: app._id })).accounting).toMatchObject({ kind: "accrual_reversal", amountCents: 3850, originalEntryId: a.result.entryId });
    await expect(f.proposeClose(action)).rejects.toThrow(/reversal_excess/);
    expect(await f.t.run(ctx => ctx.db.query("journalEntries").collect())).toHaveLength(3);
  });
  it("atomically reverses only the residual accrued unit when the two-unit invoice is recognized and prevents reaccrual", async () => {
    const f = await setup(false), a = await f.approveClose({ kind: "accrual", accrual: f.accrual() });
    await f.approveClose({ kind: "reverse_accrual", accrualId: a.result.accrualId, quantity: "1", date: "2026-10-31", evidence: [f.proof], reason: "Prior explicit one-unit reversal" });
    const propose = (quantity: string, key: string) => f.t.mutation(br.propose!, { ...f.ap, input: { caseId: f.detail.caseId, expectedRevision: f.detail.revision, snapshotHash: f.detail.snapshotHash, idempotencyKey: key, policyVersion: f.policy.version, supplierRevision: 1, accountingDate: "2026-10-31", acceptance: acceptance(f.input), accrualApplications: [{ accrualId: a.result.accrualId, quantity }] } });
    await expect(propose("2", "overreverse")).rejects.toThrow(/reversal_excess/);
    const p = await propose("1", "remaining"); await f.vote(p); const bill = await f.vote(p,"finance");
    const apps = await f.t.run(ctx => ctx.db.query("apAccrualApplications").collect());
    expect(apps.map(a => a.amountCents)).toEqual([3850,3850]);
    const app = apps.find(x => x.caseId === f.detail.caseId)!;
    expect((await f.exported({ accrualApplicationId: app._id })).accounting).toMatchObject({ billId: bill.billId, amountCents: 3850, approval: { id: p.proposalId, kind: "business" } });
    await expect(f.proposeClose({ kind: "accrual", accrual: { ...f.accrual(), expectedInvoiceCaseId: null } })).rejects.toThrow(/already_invoiced/);
    expect(await f.t.run(ctx => ctx.db.query("journalEntries").collect())).toHaveLength(4);
    expect((await f.view()).reconciliation).toMatchObject({ apGLCents: 7700, apSubledgerCents: 7700, accruedGLCents: 0, accruedSubledgerCents: 0 });
  });
});
