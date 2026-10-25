import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api";
import { businessFixture, acceptance, syncPrimary } from "../../../tests/ap-system/business-fixture";
import { fixture, packet, refs } from "../../../tests/ap-system/accounting-fixture";

const request = makeFunctionReference<"mutation">("apCasePayments:request");
const authorize = makeFunctionReference<"mutation">("apCasePayments:authorize");
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const journals = (f: any) => f.t.run((ctx: any) => ctx.db.query("journalEntries").collect());

describe("PROBE segregation of duties", () => {
  it("P1 recognition approver (owner) can also authorize the payment of the same bill", async () => {
    const f = await businessFixture();
    const r = await f.recognize(f.detail, acceptance(f.input, "1"));
    expect(r.status).toBe("approved");
    const proposal = (await f.t.run((ctx: any) => ctx.db.get(r.proposal.proposalId))) as any;
    console.log("PROBE P1 recognition voters:", proposal.votes.map((v: any) => v.subjectSeatId));
    const p = await f.t.mutation(request, { scope: f.scope, seatId: "payments", token: "token-payments", caseId: f.detail.caseId, expectedRevision: f.detail.revision, snapshotHash: f.detail.snapshotHash, idempotencyKey: "pay" });
    let outcome = "authorized";
    try {
      await f.humans.owner!.mutation(authorize, { scope: f.scope, caseId: f.detail.caseId, expectedRevision: f.detail.revision, snapshotHash: f.detail.snapshotHash, versionId: p.versionId, paymentSnapshotHash: p.snapshotHash });
    } catch (e) { outcome = `denied: ${(e as Error).message.slice(0, 160)}`; }
    console.log("PROBE P1 owner authorizes payment of bill owner approved:", outcome);
    const cmds = await f.t.run((ctx: any) => ctx.db.query("demoCommands").collect());
    console.log("PROBE P1 commands queued:", cmds.length, cmds.map((c: any) => c.command.amountCents));
  });
  it("P2 supplier destination approver (governor) can authorize payment to the destination they approved", async () => {
    const f = await businessFixture();
    await f.recognize(f.detail, acceptance(f.input, "1"));
    const p = await f.t.mutation(request, { scope: f.scope, seatId: "payments", token: "token-payments", caseId: f.detail.caseId, expectedRevision: f.detail.revision, snapshotHash: f.detail.snapshotHash, idempotencyKey: "pay" });
    let outcome = "authorized";
    try {
      await f.humans.governor!.mutation(authorize, { scope: f.scope, caseId: f.detail.caseId, expectedRevision: f.detail.revision, snapshotHash: f.detail.snapshotHash, versionId: p.versionId, paymentSnapshotHash: p.snapshotHash });
    } catch (e) { outcome = `denied: ${(e as Error).message.slice(0, 160)}`; }
    console.log("PROBE P2 governor (approved supplier bank destination) authorizes payment:", outcome);
    let v = "authorized";
    const f2 = await businessFixture();
    await f2.recognize(f2.detail, acceptance(f2.input, "1"));
    const p2 = await f2.t.mutation(request, { scope: f2.scope, seatId: "payments", token: "token-payments", caseId: f2.detail.caseId, expectedRevision: f2.detail.revision, snapshotHash: f2.detail.snapshotHash, idempotencyKey: "pay" });
    try { await f2.humans.verifier!.mutation(authorize, { scope: f2.scope, caseId: f2.detail.caseId, expectedRevision: f2.detail.revision, snapshotHash: f2.detail.snapshotHash, versionId: p2.versionId, paymentSnapshotHash: p2.snapshotHash }); } catch (e) { v = `denied: ${(e as Error).message.slice(0, 160)}`; }
    console.log("PROBE P2b verifier (callback verifier) authorizes payment:", v);
  });
  it("P3 field reviewer can also cast the recognition approval vote", async () => {
    const f = await businessFixture();
    const input = packet("GS-REVIEWER");
    const ing = await f.t.mutation(refs.ingest, { ...f.ap, input });
    const d0 = await f.get(ing.caseId);
    await f.humans.owner!.mutation(refs.review, { scope: f.scope, input: f.request(d0, "owner-review") });
    const d = await f.get(ing.caseId);
    const prop = await f.propose(d, acceptance(input, "1"), "rev-prop");
    let outcome = "accepted";
    try { const r = await f.vote(prop, "owner"); outcome = `accepted: ${r.status}`; } catch (e) { outcome = `denied: ${(e as Error).message.slice(0, 160)}`; }
    console.log("PROBE P3 owner reviewed fields then votes on recognition:", outcome);
  });
  it("P4 first-wave path: one human reviews fields, approves the bill and authorizes its payment", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-10-25T12:00:00Z"));
    const f = await fixture();
    const ing = await f.t.mutation(refs.ingest, { ...f.ap, input: packet("FW-1") });
    const d = await f.get(ing.caseId);
    await f.human.mutation(refs.review, { scope: f.scope, input: f.request(d, "review") });
    await f.human.mutation(refs.approve, { scope: f.scope, input: { ...f.request(d, "approve"), acceptedCents: 7700 } });
    const p = await f.t.mutation(request, { scope: f.scope, seatId: "payments", token: "token-payments", caseId: d.caseId, expectedRevision: d.revision, snapshotHash: d.snapshotHash, idempotencyKey: "pay" });
    let outcome = "authorized";
    try { await f.human.mutation(authorize, { scope: f.scope, caseId: d.caseId, expectedRevision: d.revision, snapshotHash: d.snapshotHash, versionId: p.versionId, paymentSnapshotHash: p.snapshotHash }); } catch (e) { outcome = `denied: ${(e as Error).message.slice(0, 160)}`; }
    const js = await journals(f);
    console.log("PROBE P4 single human field review + bill approval + payment authorization:", outcome, "journals:", js.length);
  });
  it("P5 first-wave legacy credit: one human records a credit with free-text evidence and no original link", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-10-25T12:00:00Z"));
    const f = await fixture();
    let outcome = "recorded";
    try { await f.human.mutation(api.demoPayments.recordCredit, { scope: f.scope, reference: "ANY-CREDIT", amountCents: 50000, evidence: "x", date: "2026-10-25", expenseAccount: "6200" }); } catch (e) { outcome = `denied: ${(e as Error).message.slice(0, 160)}`; }
    const js = await journals(f);
    console.log("PROBE P5 credit with evidence 'x', no bill, account 6200:", outcome, JSON.stringify(js.map((j: any) => j.lines.map((l: any) => [l.account, l.debit, l.credit]))));
  });
});

describe("PROBE disputed remainder", () => {
  it("P6 after partial acceptance, a later supported acceptance of the remainder cannot become AP", async () => {
    const f = await businessFixture();
    const r = await f.recognize(f.detail, acceptance(f.input, "1"));
    expect(r.status).toBe("approved");
    const d = await f.get(f.detail.caseId);
    let outcome = "accepted";
    try { await f.propose(d, acceptance(f.input, "2"), "accept-remainder"); } catch (e) { outcome = `denied: ${(e as Error).message.slice(0, 200)}`; }
    console.log("PROBE P6 same case, propose full 2 units after 1 recognized:", outcome);
    // explicit revision of the same invoice with identical facts
    const rev = structuredClone(f.input); rev.idempotencyKey = "rev2"; rev.explicitRevisionOf = d.caseId; rev.candidate!.revision = 2; rev.candidate!.candidateId = "rev2";
    let o2 = "ingested";
    try { const ing = await f.t.mutation(refs.ingest, { ...f.ap, input: rev }); const d2 = await f.get(ing.caseId); await f.human.mutation(refs.review, { scope: f.scope, input: f.request(d2, "rev2-review") }); const d3 = await f.get(ing.caseId); try { await f.propose(d3, acceptance(rev, "2"), "rev2-prop", 1); o2 = "proposal accepted"; } catch (e) { o2 = `revision ingested, proposal denied: ${(e as Error).message.slice(0, 200)}`; } } catch (e) { o2 = `denied: ${(e as Error).message.slice(0, 200)}`; }
    console.log("PROBE P6b explicit revision then full acceptance:", o2);
    const bills = await f.t.run((ctx: any) => ctx.db.query("demoBills").collect());
    console.log("PROBE P6 bills:", JSON.stringify(bills.map((b: any) => ({ originalCents: b.originalCents, approvedCents: b.approvedCents, flags: b.flags }))));
  });
});
