import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { businessFixture, acceptance, binding, cr, policy, subject, syncPrimary } from "./business-fixture";
import { packet } from "./accounting-fixture";
import { resolveAPBusinessPaymentAuthority } from "../../convex/lib/apSystem/businessAuthority";
import type { APIntake } from "../../src/ap-system/contracts";
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
type Fixture = Awaited<ReturnType<typeof businessFixture>>;
async function alias(f: Fixture, from: string, seatName: string) {
  await f.t.run(async ctx => {
    const config = (await ctx.db.query("demoConfigs").collect())[0]!;
    await ctx.db.patch(config._id, {humanSubjects:config.humanSubjects.map(h => h.subject === subject(from) ? {...h,seatId:`human-${seatName}`} : h)});
  });
}
function copiedPacket(input: APIntake) {
  const next = packet("RENAMED-SUPPORT-SECOND-INVOICE");
  for (const i of [1,2]) {
    const doc = structuredClone(input.documents[i]!);
    doc.sourceId += "-copy"; doc.name = "renamed-original.pdf"; doc.deliveryId += "-delivery";
    next.documents[i] = doc;
    const support = structuredClone(input.purchasingEvidence[i-1]!);
    support.source = binding(doc); support.lines[0]!.lineId += "-new-parser-id";
    next.purchasingEvidence[i-1] = support;
  }
  next.candidate!.sources = next.documents.map(binding);
  next.candidate!.lines[0]!.poLineId = next.purchasingEvidence[0]!.lines[0]!.lineId;
  next.candidate!.lines[0]!.receiptLineIds = [next.purchasingEvidence[1]!.lines[0]!.lineId];
  return next;
}
async function verifiedChange(f: Fixture) {
  const result = await f.t.mutation(cr.proposeSupplier!, {...f.ap,idempotencyKey:"verified-change",proposal:{...f.supplier,expectedRevision:1,externalAccountId:"external-new"}});
  const row = (await f.t.run(ctx => ctx.db.get(result.revisionId as Id<"apSupplierRevisions">)))!;
  await f.humans.verifier!.mutation(cr.verifySupplier!, {scope:f.scope,revisionId:row._id,verification:{contactId:f.supplier.contactId,method:"callback_previously_held_contact",result:"confirmed",performedAt:row.createdAt,evidence:f.proof,mode:"simulated",reason:"Synthetic callback, no actual communication"}});
  return () => f.humans.governor!.mutation(cr.approveSupplier!, {scope:f.scope,revisionId:row._id,expectedHash:row.hash,reason:"Independent exact change approval"});
}
async function retire(f: Fixture, name: string) {
  await f.t.run(async ctx => { const seat = (await ctx.db.query("seats").collect()).find(s => s.seatId === `human-${name}`)!; await ctx.db.patch(seat._id,{status:"retired"}); });
}
async function activateChangedPolicy(f: Fixture) {
  const p = structuredClone(f.policy); p.version += "-new-verifier";
  p.groups.find(g => g.groupId === "verify")!.members = [subject("second")];
  const proposal = await f.t.mutation(cr.proposePolicy!, {...f.controller,idempotencyKey:"replace-verifier-policy",policy:p});
  const row = (await f.t.run(ctx => ctx.db.get(proposal.policyId as Id<"apBusinessPolicies">)))!;
  await f.humans.governor!.mutation(cr.activatePolicy!, {scope:f.scope,policyId:row._id,expectedHash:row.hash,reason:"Explicit verification group change"});
  return p;
}
describe("B3 verifier regressions: immutable capacity and independent humans", () => {
  it("cannot replenish original PO/receipt units by renaming source and parser IDs, but permits only the exact remaining units", async () => {
    const f = await businessFixture(); await f.recognize(f.detail,acceptance(f.input,"1"));
    const next = copiedPacket(f.input), d = await f.reviewed(next);
    await expect(f.propose(d,acceptance(next),"overdraw")).rejects.toThrow(/already_used/);
    await f.recognize(d,acceptance(next,"1"),"remaining");
    const bills = await f.t.run(ctx => ctx.db.query("demoBills").collect());
    expect(bills.map(b => b.approvedCents)).toEqual([3850,3850]);
    expect(await f.t.run(ctx => ctx.db.query("journalEntries").collect())).toHaveLength(2);
  });
  it.each(["sku","unit","quantity"])("holds a changed %s semantic interpretation of identical original bytes", async field => {
    const f = await businessFixture({onboard:false});
    await f.onboard({...f.supplier,catalog:[...f.supplier.catalog,{sku:"CHARD-24",unit:"case",unitPriceCents:3850}]});
    await f.recognize(f.detail,acceptance(f.input,"1"));
    if (field === "unit") await f.onboard({...f.supplier,expectedRevision:1,catalog:[{sku:"KALE-24",unit:"box",unitPriceCents:3850}]},"unit-revision");
    const next = copiedPacket(f.input);
    for (const p of next.purchasingEvidence) {
      if (field === "sku") p.lines[0]!.sku = "CHARD-24";
      if (field === "unit") p.lines[0]!.quantity.unit = "box";
      if (field === "quantity") p.lines[0]!.quantity.decimal = "3";
    }
    if (field === "sku") next.candidate!.lines[0]!.sku = "CHARD-24";
    if (field === "unit") next.candidate!.lines[0]!.quantity.unit = "box";
    syncPrimary(next);
    const d = await f.reviewed(next);
    await expect(f.propose(d,acceptance(next),"conflicting-semantics",field === "unit" ? 2 : 1)).rejects.toThrow(/consumption_source_conflict/);
    expect(await f.t.run(ctx => ctx.db.query("journalEntries").collect())).toHaveLength(1);
  });
  it.each(["retired","group_removed","binding_changed","approver_alias"])("denies supplier activation when retained verifier is %s", async mode => {
    const f = await businessFixture(), approve = await verifiedChange(f);
    if (mode === "retired") await retire(f,"verifier");
    if (mode === "group_removed") await activateChangedPolicy(f);
    if (mode === "binding_changed") await alias(f,"verifier","second");
    if (mode === "approver_alias") await alias(f,"governor","verifier");
    await expect(approve()).rejects.toThrow(/inactive|approval_group|segregation/);
    expect((await f.t.run(ctx => ctx.db.query("apSuppliers").collect()))[0]!.activeRevision).toBe(1);
  });
  it("blocks existing payment authority after verifier retirement and permits explicit new supplier verification plus business recertification without rebooking", async () => {
    const f = await businessFixture(), recognized = await f.recognize();
    await retire(f,"verifier");
    await expect(f.t.run(ctx => resolveAPBusinessPaymentAuthority(ctx,f.scope,[recognized.billId]))).rejects.toThrow(/inactive/);
    const newPolicy = await activateChangedPolicy(f);
    const result = await f.t.mutation(cr.proposeSupplier!, {...f.ap,idempotencyKey:"recert-supplier",proposal:{...f.supplier,expectedRevision:1}});
    const row = (await f.t.run(ctx => ctx.db.get(result.revisionId as Id<"apSupplierRevisions">)))!;
    await f.humans.second!.mutation(cr.verifySupplier!, {scope:f.scope,revisionId:row._id,verification:{contactId:f.supplier.contactId,method:"callback_previously_held_contact",result:"confirmed",performedAt:row.createdAt,evidence:f.proof,mode:"simulated",reason:"New independently authorized synthetic callback"}});
    await f.humans.governor!.mutation(cr.approveSupplier!, {scope:f.scope,revisionId:row._id,expectedHash:row.hash,reason:"New retained authority"});
    const detail = await f.get(f.detail.caseId);
    const { makeFunctionReference } = await import("convex/server");
    const prop = await f.t.mutation(makeFunctionReference<"mutation">("apBusiness:propose"), {...f.ap,input:{caseId:detail.caseId,expectedRevision:detail.revision,snapshotHash:detail.snapshotHash,idempotencyKey:"recert-bill",policyVersion:newPolicy.version,supplierRevision:2,acceptance:acceptance(f.input)}});
    await f.vote(prop); await f.vote(prop,"finance");
    expect(await f.t.run(ctx => resolveAPBusinessPaymentAuthority(ctx,f.scope,[recognized.billId]))).toMatchObject({beneficiary:{version:"golden-state-produce:r2"}});
    expect(await f.t.run(ctx => ctx.db.query("journalEntries").collect())).toHaveLength(1);
  });
  it("cannot count two subject aliases for one human seat toward a quorum", async () => {
    const p = policy(); p.bands[0]!.steps[0]!.quorum = 2; p.bands[0]!.steps[0]!.escalationGroupId = null;
    const f = await businessFixture({policy:p}); await alias(f,"second","owner");
    const proposal = await f.propose(f.detail,acceptance(f.input,"1"));
    expect((await f.vote(proposal)).status).toBe("pending");
    await expect(f.vote(proposal,"second")).rejects.toThrow(/segregation/);
    expect(await f.t.run(ctx => ctx.db.query("journalEntries").collect())).toHaveLength(0);
  });
  it("rejects one underlying person across sequential approval groups", async () => {
    const f = await businessFixture(), p = await f.propose(); await f.vote(p);
    await alias(f,"finance","owner");
    await expect(f.vote(p,"finance")).rejects.toThrow(/segregation/);
  });
  it("rejects rebinding a retained voter's subject before final recognition or payment", async () => {
    const f = await businessFixture(), p = await f.propose(); await f.vote(p);
    await alias(f,"owner","second");
    await expect(f.vote(p,"finance")).rejects.toThrow(/identity_changed/);
    const g = await businessFixture(), r = await g.recognize(); await alias(g,"owner","second");
    await expect(g.t.run(ctx => resolveAPBusinessPaymentAuthority(ctx,g.scope,[r.billId]))).rejects.toThrow(/identity_changed/);
  });
  it("cannot delegate to one's own subject alias or reuse a delegated principal's seat", async () => {
    const p = policy(); p.bands[0]!.steps[0]!.quorum = 2; p.bands[0]!.steps[0]!.escalationGroupId = null;
    const f = await businessFixture({policy:p}); await alias(f,"second","owner");
    const grant = {groupId:"owner",toSubject:subject("second"),maxCents:10000,validFrom:Date.now()-10,validUntil:Date.now()+60000,reason:"Scoped synthetic absence delegation"};
    await expect(f.humans.owner!.mutation(cr.delegate!,{scope:f.scope,idempotencyKey:"self-alias",delegation:grant})).rejects.toThrow(/invalid_delegation/);
    const d = await f.humans.second!.mutation(cr.delegate!,{scope:f.scope,idempotencyKey:"principal-alias",delegation:{...grant,toSubject:subject("delegate")}});
    const proposal = await f.propose(f.detail,acceptance(f.input,"1")); await f.vote(proposal);
    await expect(f.vote(proposal,"delegate","delegated-vote",{delegationId:d.delegationId})).rejects.toThrow(/segregation/);
  });
});
