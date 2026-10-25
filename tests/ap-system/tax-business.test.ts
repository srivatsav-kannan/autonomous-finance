import { makeFunctionReference } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import { readCostState } from "../../convex/lib/apSystem/costState";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAPBusinessPaymentAuthority } from "../../convex/lib/apSystem/businessAuthority";
import { taxBusinessFixture } from "./tax-business-fixture";
import { cr } from "./business-fixture";
import { loadRecognizedBusinessExport } from "../../convex/lib/apSystem/businessExport";
afterEach(() => vi.unstubAllEnvs());

describe("E01 governed recoverable tax", () => {
  it.each(["exclusive", "inclusive"] as const)("requires an independent tax stage for %s amounts and posts cost/tax/AP once", async basis => {
    const f = await taxBusinessFixture({ basis }); const p = await f.propose(f.detail, f.a);
    expect(p.route.map((s: any) => s.groupId)).toEqual(["owner", "finance", "tax-review"]);
    await f.vote(p); await f.vote(p, "finance"); expect((await f.state()).journals).toHaveLength(0);
    const result = await f.vote(p, "second"); expect(await f.vote(p, "second")).toEqual(result);
    const state = await f.state(); expect(state.journals).toHaveLength(1); expect(state.commands).toHaveLength(0);
    expect(state.journals[0]!.lines.map(l => [l.account, l.debit, l.credit])).toEqual([["5000", 7700, 0], ["1180", 770, 0], ["2000", 0, 8470]]);
    const exported = await f.t.run(ctx => loadRecognizedBusinessExport(ctx, f.scope, f.detail.caseId));
    expect(exported.allocations.map(a => [a.account, a.amountCents])).toEqual([["5000",7700],["1180",770]]);
    await f.t.run(async ctx => { const seat = (await ctx.db.query("seats").collect()).find(s => s.seatId === "human-second")!; await ctx.db.patch(seat._id, { status: "retired" }); });
    await expect(f.t.run(ctx => resolveAPBusinessPaymentAuthority(ctx, f.scope, [result.billId]))).rejects.toThrow(/inactive_approver/);
  });
  it("allows stated tax without inventing a rate, with exact partial recovery", async () => {
    const f = await taxBusinessFixture({ recoveryBps: 5000, stated: true });
    const p = await f.propose(f.detail, f.a); await f.approve(p);
    expect((await f.state()).journals[0]!.lines.map(l => [l.account,l.debit,l.credit])).toEqual([["5000",8085,0],["1180",385,0],["2000",0,8470]]);
  });
  it.each(["missing_claim", "missing_policy", "wrong_account", "inflated_recovery", "stale_source", "future_tax_point"])("holds %s before journal creation", async kind => {
    const f = await taxBusinessFixture(); const a = structuredClone(f.a);
    if (kind === "missing_claim") delete a.lines[0]!.tax;
    if (kind === "missing_policy") a.lines[0]!.taxCode = "COST";
    if (kind === "wrong_account") a.lines[0]!.allocations[1]!.account = "1200";
    if (kind === "inflated_recovery") a.lines[0]!.tax!.recoverableCents++;
    if (kind === "stale_source") a.lines[0]!.tax!.facts.tax.source.revision++;
    if (kind === "future_tax_point") a.lines[0]!.tax!.taxPointDate = "2026-12-01";
    await expect(f.propose(f.detail, a)).rejects.toThrow(); expect((await f.state()).journals).toHaveLength(0);
  });
  it("reverses tax-only and then net return amounts from their separate original pools", async () => {
    const f = await taxBusinessFixture(); const original = await f.propose(f.detail, f.a); await f.approve(original);
    const tax = await f.credit(original.proposalId, "TAX-ONLY", 0, 770, "tax_adjustment"); await f.approve(await tax.propose());
    const first = await f.credit(original.proposalId, "RETURN-1", 3850, 0); await f.approve(await first.propose());
    const second = await f.credit(original.proposalId, "RETURN-2", 3850, 0); await f.approve(await second.propose());
    const state = await f.state(); expect(state.credits[0]!.allocations.map((a: any) => [a.account,a.amountCents])).toEqual([["1180",770]]);
    const net = (account: string) => state.journals.flatMap(j => j.lines).filter(l => l.account === account).reduce((n,l) => n+l.debit-l.credit,0);
    expect([net("5000"),net("1180"),net("2000")]).toEqual([0,0,0]);
    const extra = await f.credit(original.proposalId, "EXTRA-TAX", 0, 1, "tax_adjustment"); await expect(extra.propose()).rejects.toThrow(/credit_exceeds_original/);
  });
  it("conserves partial-recovery rounding across two returns", async () => {
    const f = await taxBusinessFixture({ recoveryBps: 5000 }); const p = await f.propose(f.detail, f.a); await f.approve(p);
    for (const n of [1,2]) { const credit = await f.credit(p.proposalId, `PARTIAL-${n}`, 3850, 385); await f.approve(await credit.propose()); }
    const rows = (await f.state()).credits;
    expect(rows.map(r => r.allocations.filter((a: any) => a.treatment === "tax").reduce((n: number,a: any) => n+a.amountCents,0))).toEqual([193,192]);
  });
  it("rejects cost reclassification into or out of the original tax receivable", async () => {
    const f = await taxBusinessFixture(); const p = await f.propose(f.detail, f.a); await f.approve(p); const entryId = (await f.state()).journals[0]!._id;
    for (const [fromAccount,toAccount] of [["1180","5000"],["5000","1180"]]) await expect(f.t.mutation(f.close,{...f.controller,input:{idempotencyKey:`reclass-${fromAccount}`,action:{kind:"adjustment",originalEntryId:entryId,fromAccount,toAccount,amountCents:100,store:"sf-hayes-valley",date:"2026-10-19",evidence:f.proof,reason:"Cannot convert a tax entitlement into cost"}}})).rejects.toThrow(/tax_correction_required/);
    expect((await f.state()).journals).toHaveLength(1);
  });
  it("rechecks cumulative tax capacity at competing final votes", async () => {
    const f = await taxBusinessFixture(); const original = await f.propose(f.detail,f.a); await f.approve(original);
    const a = await (await f.credit(original.proposalId,"RACE-A",0,500,"tax_adjustment")).propose();
    const b = await (await f.credit(original.proposalId,"RACE-B",0,500,"tax_adjustment")).propose();
    for (const p of [a,b]) { await f.vote(p); await f.vote(p,"finance"); }
    const results = await Promise.allSettled([f.vote(a,"second"),f.vote(b,"second")]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1); expect((await f.state()).credits).toHaveLength(1);
  });
  it("preserves tax shares through a reviewed cost correction and a later tax-only credit", async () => {
    const f = await taxBusinessFixture(); const original = await f.propose(f.detail,f.a); await f.approve(original);
    const firstJournal = (await f.state()).journals[0]!;
    const adjustment = await f.t.mutation(f.close,{...f.controller,input:{idempotencyKey:"cost-only",action:{kind:"adjustment",originalEntryId:firstJournal._id,fromAccount:"5000",toAccount:"1200",amountCents:7700,store:"sf-hayes-valley",date:"2026-10-19",evidence:f.proof,reason:"Reviewed cost reclassification only"}}});
    for (const who of ["owner","finance"]) await f.humans[who]!.mutation(makeFunctionReference<"mutation">("apClose:vote"),{scope:f.scope,input:{actionId:adjustment.actionId,actionHash:adjustment.actionHash,idempotencyKey:`cost-vote-${who}`,outcome:"approved",reason:"Original cost only; tax remains untouched"}});
    const credit = await f.credit(original.proposalId,"CORRECTED-RETURN",3850,385);
    await expect(credit.propose()).rejects.toThrow(/classification_changed/);
    const cost = await f.t.run(ctx=>readCostState(ctx,f.scope,firstJournal._id));
    credit.plan.correction={snapshotHash:cost.snapshotHash,evidence:f.proof,reason:"Reverse the reviewed remaining cost position",allocations:[{originalLineId:"line-1",allocationIndex:0,account:"1200",treatment:"inventory",store:"sf-hayes-valley",department:null,project:null,side:"credit",amountCents:3850}]};
    await f.approve(await credit.propose());
    const tax = await f.credit(original.proposalId,"CORRECTED-TAX-ONLY",0,385,"tax_adjustment");
    await f.approve(await tax.propose());
    const state = await f.state();
    expect(state.journals[0]).toEqual(firstJournal);
    expect(state.credits[0]!.allocations.map((a:any)=>[a.account,a.amountCents])).toEqual([["1200",3850],["1180",385]]);
    expect(state.credits[1]!.allocations.map((a:any)=>[a.account,a.amountCents])).toEqual([["1180",385]]);
  });
  it("rejects a same-seat tax reviewer alias at final approval", async () => {
    const f = await taxBusinessFixture(); const p=await f.propose(f.detail,f.a);await f.vote(p);await f.vote(p,"finance");
    await f.t.run(async ctx=>{const config=(await ctx.db.query("demoConfigs").collect())[0]!;await ctx.db.patch(config._id,{humanSubjects:config.humanSubjects.map(h=>h.seatId==="human-second"?{...h,seatId:"human-finance"}:h)});});
    await expect(f.vote(p,"second")).rejects.toThrow(/approval_segregation/);expect((await f.state()).journals).toHaveLength(0);
  });
  it("rejects a tax decision prepared under a superseded policy", async () => {
    const f = await taxBusinessFixture();const p=await f.propose(f.detail,f.a);await f.vote(p);await f.vote(p,"finance");
    const next=await f.t.mutation(cr.proposePolicy!,{...f.controller,idempotencyKey:"next-tax-policy",policy:{...f.policy,version:"next-tax-policy"}});
    const row=await f.t.run(ctx=>ctx.db.get(next.policyId as Id<"apBusinessPolicies">));
    await f.humans.governor!.mutation(cr.activatePolicy!,{scope:f.scope,policyId:next.policyId,expectedHash:row!.hash,reason:"New explicit synthetic policy"});
    await expect(f.vote(p,"second")).rejects.toThrow(/stale_business_context/);expect((await f.state()).journals).toHaveLength(0);
  });

  it("preserves approved department on tax and payable through successive credits", async () => {
    const f = await taxBusinessFixture({ settlementDepartment: true }); const original = await f.propose(f.detail,f.a); await f.approve(original);
    for (const n of [1,2]) { const credit=await f.credit(original.proposalId,`DEPT-RETURN-${n}`,3850,385); await f.approve(await credit.propose()); }
    const state=await f.state();
    expect(state.journals.every(j=>j.lines.every(l=>l.dims?.department==="operations"))).toBe(true);
    const cost=await f.t.run(ctx=>readCostState(ctx,f.scope,state.journals[0]!._id));
    expect(cost.positions.every(p=>p.balanceCents===0)).toBe(true);
  });

});
