import {fixture as accountingFixture,refs} from "./accounting-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { makeFunctionReference } from "convex/server";
import { api, demoFixture, paymentLeaseProof } from "../demo-fixture";
import { PAYMENT_EXECUTOR_VERSION } from "../../src/payments/contracts";
import { parseCommandEnvelope } from "../../src/payments/domain/validation";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { ExecutePaymentEffect } from "../../src/payments/application/execute-payment-effect";
import { ReconcilePaymentEvidence } from "../../src/payments/application/reconcile-payment-evidence";
import { createConvexPaymentKernel } from "../../src/payments/adapters/convex-payment-kernel";
import { createConvexPaymentEvidence } from "../../src/payments/adapters/convex-payment-evidence";
import type { KernelTransport } from "../../src/payments/adapters/convex-transport";

const start = Date.parse("2026-10-25T12:00:00Z"), due = Date.parse("2026-10-28T00:00:00Z");
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function setup() { vi.useFakeTimers(); vi.setSystemTime(start); return demoFixture(); }
type F = Awaited<ReturnType<typeof setup>>;
const claim = (f:F, leaseToken="schedule-lease-token-1") => f.t.mutation(api.demoPayments.claim, {scope:f.scope, token:f.dispatcherToken, paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION, workerId:"schedule-test", leaseToken});
async function requested(f:F, extra:{executionDate?:string;amount?:number}={}) {
  const billId=await f.bill();
  const args={...f.payments,requestKey:"schedule",billIds:[billId],credits:[],...(extra.executionDate?{executionDate:extra.executionDate}:{}),...(extra.amount?{billAmounts:[{billId,amountCents:extra.amount}]}:{})};
  const version=await f.t.mutation(api.demoPayments.requestPayment,args);
  return {billId,args,...version};
}
const approve=(f:F,r:{versionId:string;snapshotHash:string})=>f.human.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,versionId:r.versionId as Id<"demoVersions">,snapshotHash:r.snapshotHash});

describe("business scheduling bound to independent payment authorization",()=>{
  it("waits through restart-shaped worker claims without spending recovery budget, then initiates at UTC midnight",async()=>{
    const f=await setup(),r=await requested(f,{executionDate:"2026-10-28"});
    expect(await claim(f)).toBeNull(); // proposal is not authority
    const q=await approve(f,r);
    expect((await f.t.run(ctx=>ctx.db.get(r.versionId)))?.snapshot.schedule).toEqual({executionDate:"2026-10-28",timeZone:"UTC"});
    // An overdue technical nextAttemptAt is deliberately not authority to bypass the business date.
    await f.t.run(ctx=>ctx.db.patch(q.commandId,{nextAttemptAt:0}));
    for(const now of [start,start+86400000,due-1]) {vi.setSystemTime(now);expect(await claim(f,`restart-${now}-lease`)).toBeNull();}
    expect(await f.t.run(ctx=>ctx.db.get(q.commandId))).toMatchObject({execution:"queued",attemptCount:0,generation:0});
    expect(await f.t.run(ctx=>ctx.db.query("demoAttempts").collect())).toEqual([]);
    vi.setSystemTime(due);const lease=await claim(f);expect(lease).toMatchObject({action:"submit",firstAttemptAt:due,generation:1});
  });
  it.each(["2026-02-29","2026-13-01","2026-11-31","2026-1-1","2026-10-28T00:00:00Z",""])("rejects invalid calendar selection %s before reservation",async executionDate=>{
    const f=await setup(),billId=await f.bill();
    await expect(f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:"invalid",billIds:[billId],credits:[],executionDate})).rejects.toThrow();
    expect(await f.t.run(ctx=>ctx.db.query("demoVersions").collect())).toEqual([]);
    expect((await f.t.run(ctx=>ctx.db.get(billId as Id<"demoBills">)))?.reservedVersionId).toBeUndefined();
  });
  it.each([undefined,"2026-10-01","2026-10-25"])("preserves immediate and overdue behavior (%s)",async executionDate=>{
    const f=await setup(),r=await requested(f,{executionDate});await approve(f,r);expect(await claim(f)).toMatchObject({action:"submit"});
  });
  it("accepts a real leap day and binds schedule and partial allocation to replay identity",async()=>{
    const f=await setup(),r=await requested(f,{executionDate:"2028-02-29",amount:4000});
    expect(await f.t.mutation(api.demoPayments.requestPayment,r.args)).toEqual({versionId:r.versionId,snapshotHash:r.snapshotHash});
    for(const change of [{executionDate:"2028-03-01"},{executionDate:undefined},{billAmounts:[{billId:r.billId,amountCents:5000}]},{billAmounts:undefined}]) {
      await expect(f.t.mutation(api.demoPayments.requestPayment,{...r.args,...change})).rejects.toThrow(/idempotency conflict/);
    }
    expect(await f.t.run(ctx=>ctx.db.query("demoVersions").collect())).toHaveLength(1);
    await approve(f,r);expect(await claim(f)).toBeNull();
  });
  it("cannot edit an approved schedule, and rescheduling cancels and requires a new human decision",async()=>{
    const f=await setup(),r=await requested(f,{executionDate:"2026-10-28"});const q=await approve(f,r);
    await f.human.mutation(api.demoPayments.cancel,{scope:f.scope,versionId:r.versionId});
    const next=await f.t.mutation(api.demoPayments.requestPayment,{...r.args,requestKey:"rescheduled",executionDate:"2026-10-29"});
    expect(next.snapshotHash).not.toBe(r.snapshotHash);expect(await claim(f)).toBeNull();
    await expect(approve(f,{...next,snapshotHash:r.snapshotHash})).rejects.toThrow(/Stale/);
    expect(await f.t.run(ctx=>ctx.db.get(q.commandId))).toMatchObject({execution:"cancelled",attemptCount:0});
    expect((await f.t.run(ctx=>ctx.db.get(next.versionId)))?.approvals).toEqual([]);
  });
  it("rechecks authority at initiation, while possible-send recovery keeps its original request",async()=>{
    const f=await setup(),r=await requested(f,{executionDate:"2026-10-28"});const q=await approve(f,r);vi.setSystemTime(due);
    const lease=(await claim(f))!;
    await f.t.mutation(api.demoPayments.fail,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,...paymentLeaseProof(lease),errorClass:"transport",error:"response lost",retryAfterMs:60000});
    const failed=(await f.t.run(ctx=>ctx.db.get(q.commandId)))!;
    expect(failed.nextAttemptAt).toBe(due+60000);expect(await claim(f,"early-retry-lease-token")).toBeNull();
    await f.t.run(ctx=>ctx.db.patch(r.billId,{flags:["changed after possible send"],version:99}));
    vi.setSystemTime(failed.nextAttemptAt);const recovery=(await claim(f,"recovery-new-lease-token"))!;
    expect(recovery.action).toBe("reconcile");expect(recovery.command).toEqual(lease.command);expect(recovery.firstAttemptAt).toBe(due);
    await expect(f.human.mutation(api.demoPayments.cancel,{scope:f.scope,versionId:r.versionId})).rejects.toThrow(/Submission/);
  });
  it("blocks revoked approval before a due-date dispatch with no attempt",async()=>{
    const f=await setup(),r=await requested(f,{executionDate:"2026-10-28"});const q=await approve(f,r);
    await f.t.run(async ctx=>{const seat=(await ctx.db.query("seats").collect()).find(s=>s.seatId==="human_cfo")!;await ctx.db.patch(seat._id,{status:"retired"});});
    vi.setSystemTime(due);expect(await claim(f)).toBeNull();expect(await f.t.run(ctx=>ctx.db.get(q.commandId))).toMatchObject({execution:"exception",attemptCount:0});
  });
});

describe("explicit partial bill discharge and supplier credit accounting",()=>{
  it("rejects overpayment, duplicate or incomplete allocations and zero cash without creating financial state",async()=>{
    const f=await setup(),billId=await f.bill();
    for(const billAmounts of [[{billId,amountCents:10001}],[{billId,amountCents:0}],[{billId,amountCents:0.5}],[],[{billId,amountCents:1000},{billId,amountCents:1000}]]) {
      await expect(f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:"bad",billIds:[billId],billAmounts,credits:[]})).rejects.toThrow();
    }
    expect(await f.t.run(ctx=>ctx.db.query("demoVersions").collect())).toEqual([]);
    expect(()=>parseCommandEnvelope({commandId:"bad",command:{type:"RequestPayment",billIds:[billId],billAmounts:[],credits:[]}})).toThrow();
  });
  it("settles partial cash plus credit once, preserves remaining AP, and settles the balance with a new authorization",async()=>{
    const f=await setup(),billId=await f.bill(10000);
    const {creditId}=await f.human.mutation(api.demoPayments.recordCredit,{scope:f.scope,reference:"RETURN-1",amountCents:2000,evidence:"verified-credit-original",date:"2026-10-25",expenseAccount:"5000"});
    const args={...f.payments,requestKey:"partial",billIds:[billId],billAmounts:[{billId,amountCents:6000}],credits:[{creditId,amountCents:2000}]};
    const r=await f.t.mutation(api.demoPayments.requestPayment,args);expect((await f.t.run(ctx=>ctx.db.get(r.versionId)))?.snapshot.amountCents).toBe(4000);
    await expect(f.t.mutation(api.demoPayments.requestPayment,{...args,requestKey:"overlap"})).rejects.toThrow(/available/);
    await approve(f,r);
    const bank=openFakeBank({path:":memory:",scope:f.scope,seed:"partial",startTime:new Date(start).toISOString()});
    try {
      const transport=f.t as unknown as KernelTransport;
      const kernel=createConvexPaymentKernel(transport,f.scope,f.dispatcherToken),evidence=createConvexPaymentEvidence(transport,f.scope,f.evidenceToken);
      let n=0;const worker=new ExecutePaymentEffect(kernel,bank.provider,"partial-worker",{now:Date.now,newLeaseToken:()=>`partial-worker-lease-${++n}`,startHeartbeat:()=>()=>{}});
      const reconcile=new ReconcilePaymentEvidence(evidence,bank.provider,f.scope,Date.now);
      await worker.tick();bank.harness.settle(bank.harness.inspect().transfers[0]!.id);await reconcile.tick();await reconcile.tick();
      expect(await f.t.run(ctx=>ctx.db.get(billId))).toMatchObject({originalCents:10000,approvedCents:10000,paidCents:6000,status:"approved"});
      expect(await f.t.run(ctx=>ctx.db.get(creditId))).toMatchObject({consumedCents:2000,reservedCents:0});
      expect(await f.t.mutation(api.demoPayments.requestPayment,args)).toEqual(r);
      const next=await f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:"balance",billIds:[billId],credits:[]});
      expect((await f.t.run(ctx=>ctx.db.get(next.versionId)))?.snapshot.amountCents).toBe(4000);
      await worker.tick();expect(bank.harness.inspect().transfers).toHaveLength(1);
      await approve(f,next);await worker.tick();const transfer=bank.harness.inspect().transfers.find(t=>t.commandId===next.versionId)!;bank.harness.settle(transfer.id);await reconcile.tick();
      expect(await f.t.run(ctx=>ctx.db.get(billId))).toMatchObject({paidCents:10000,status:"paid"});
      const journals=await f.t.run(ctx=>ctx.db.query("journalEntries").collect());expect(journals).toHaveLength(4);
      const apNet=journals.flatMap(j=>j.lines).filter(l=>l.account==="2000").reduce((n,l)=>n+l.credit-l.debit,0);expect(apNet).toBe(0);
      expect(bank.harness.inspect().transfers.map(t=>t.amountCents)).toEqual([4000,4000]);
      expect(bank.harness.inspect().transactions.filter(t=>t.status==="posted"&&t.purpose==="debit")).toHaveLength(2);
    } finally {bank.close();}
  });
  it("fails closed if an approved bill loses its valid balance before partial first dispatch",async()=>{
    const f=await setup(),r=await requested(f,{amount:2000});const q=await approve(f,r);
    await f.t.run(ctx=>ctx.db.patch(r.billId,{approvedCents:undefined}));
    expect(await claim(f)).toBeNull();expect(await f.t.run(ctx=>ctx.db.get(q.commandId))).toMatchObject({execution:"exception",attemptCount:0});
  });
  it("binds the AP case seam to explicit amount/date and still requires separate authorization",async()=>{
    vi.useFakeTimers();vi.setSystemTime(start);
    const f=await accountingFixture(),d=await f.reviewed();
    const {billId}=await f.human.mutation(refs.approve,{scope:f.scope,input:{...f.request(d,"bill"),acceptedCents:7700}});
    const caseId=d.caseId;
    const request=makeFunctionReference<"mutation">("apCasePayments:request");
    const r=await f.t.mutation(request,{scope:f.scope,seatId:"payments",token:"token-payments",caseId,expectedRevision:1,snapshotHash:d.snapshotHash,idempotencyKey:"ap-partial",amountCents:2500,executionDate:"2026-10-28"});
    expect((await f.t.run(ctx=>ctx.db.get(r.versionId as Id<"demoVersions">)))?.snapshot).toMatchObject({amountCents:2500,schedule:{executionDate:"2026-10-28"}});
    expect(await f.t.run(ctx=>ctx.db.query("demoCommands").collect())).toEqual([]);
    const cancel=makeFunctionReference<"mutation">("apCasePayments:cancel");
    const cancelArgs={scope:f.scope,caseId,expectedRevision:1,snapshotHash:d.snapshotHash,versionId:r.versionId};
    await expect(f.t.mutation(cancel,cancelArgs)).rejects.toThrow(/human/);
    expect(await f.human.mutation(cancel,cancelArgs)).toEqual({ok:true});expect(await f.human.mutation(cancel,cancelArgs)).toEqual({ok:true});
    expect((await f.t.run(ctx=>ctx.db.get(billId as Id<"demoBills">)))?.reservedVersionId).toBeUndefined();
  });
});
