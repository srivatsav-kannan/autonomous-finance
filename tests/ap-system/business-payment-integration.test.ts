import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import { api, paymentLeaseProof } from "../demo-fixture";
import { businessFixture, acceptance } from "./business-fixture";
import { packet } from "./accounting-fixture";
import { PAYMENT_EXECUTOR_VERSION } from "../../src/payments/contracts";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { ExecutePaymentEffect } from "../../src/payments/application/execute-payment-effect";
import { ReconcilePaymentEvidence } from "../../src/payments/application/reconcile-payment-evidence";
import { createConvexPaymentKernel } from "../../src/payments/adapters/convex-payment-kernel";
import { createConvexPaymentEvidence } from "../../src/payments/adapters/convex-payment-evidence";
import type { KernelTransport } from "../../src/payments/adapters/convex-transport";
const request=makeFunctionReference<"mutation">("apCasePayments:request");
const start=Date.parse("2026-10-25T12:00:00Z");
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function setup(newSupplier=false){vi.useFakeTimers();vi.setSystemTime(start);const input=packet();if(newSupplier){input.candidate!.supplierId="another-approved-supplier";input.purchasingEvidence.forEach(p=>p.supplierId="another-approved-supplier");}const f=await businessFixture({input});await f.recognize(f.detail,acceptance(input,"1"));return f;}
type F=Awaited<ReturnType<typeof setup>>;
const prepare=(f:F,key="payment",more:Record<string,unknown>={})=>f.t.mutation(request,{scope:f.scope,seatId:"payments",token:"token-payments",caseId:f.detail.caseId,expectedRevision:f.detail.revision,snapshotHash:f.detail.snapshotHash,idempotencyKey:key,...more}) as Promise<{versionId:Id<"demoVersions">;snapshotHash:string}>;
const authorize=(f:F,p:{versionId:Id<"demoVersions">;snapshotHash:string})=>f.payer.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...p});
const claim=(f:F,key="business-payment-lease-1")=>f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:"test-dispatch",paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:"business-test",leaseToken:key});
async function retire(f:F,name:string){await f.t.run(async ctx=>{const seat=await ctx.db.query("seats").withIndex("by_run_seat",q=>q.eq("runId",f.scope.runId).eq("seatId",`human-${name}`)).unique();await ctx.db.patch(seat!._id,{status:"retired"});});}
describe("B3 authority integrated with the original durable payment engine",()=>{
 it("pays a partial recognized amount for a non-default verified supplier on its authorized date",async()=>{
  const f=await setup(true),p=await prepare(f,"partial",{amountCents:2000,executionDate:"2026-10-28"});
  const v=await f.t.run(ctx=>ctx.db.get(p.versionId));expect(v!.snapshot).toMatchObject({amountCents:2000,destination:{externalAccountId:"external-supplier-v1",version:"another-approved-supplier:r1"}});
  await authorize(f,p);expect(await claim(f)).toBeNull();vi.setSystemTime(Date.parse("2026-10-28T00:00:00Z"));
  const bank=openFakeBank({path:":memory:",scope:f.scope,seed:"business-payment",startTime:new Date(start).toISOString()});
  try{const transport=f.t as unknown as KernelTransport;let n=0;const worker=new ExecutePaymentEffect(createConvexPaymentKernel(transport,f.scope,"test-dispatch"),bank.provider,"business-worker",{now:Date.now,newLeaseToken:()=>`business-worker-lease-${++n}`,startHeartbeat:()=>()=>{}});const reconciliation=new ReconcilePaymentEvidence(createConvexPaymentEvidence(transport,f.scope,"test-evidence"),bank.provider,f.scope,Date.now);
   await worker.tick();const transfer=bank.harness.inspect().transfers[0]!;expect(transfer.destination.externalAccountId).toBe("external-supplier-v1");bank.harness.settle(transfer.id);await reconciliation.tick();await reconciliation.tick();
   const d=await f.get(f.detail.caseId);expect(d.amounts).toMatchObject({acceptedCents:3850,settledCents:2000,outstandingCents:1850});expect(d.candidate!.totalCents).toBe(7700);expect(d.journals).toHaveLength(2);expect(bank.harness.inspect().transfers).toHaveLength(1);
  }finally{bank.close();}
 });
 it("revalidates business authority on request, payment authorization and first dispatch",async()=>{
  for(const stage of ["request","authorize","dispatch"]){const f=await setup();const p=stage!=="request"?await prepare(f):undefined;if(stage==="dispatch")await authorize(f,p!);await retire(f,"owner");
   if(stage==="request")await expect(prepare(f)).rejects.toThrow(/inactive_approver/);
   else if(stage==="authorize")await expect(authorize(f,p!)).rejects.toThrow(/inactive_approver/);
   else {expect(await claim(f)).toBeNull();const commands=await f.t.run(ctx=>ctx.db.query("demoCommands").collect());expect(commands[0]).toMatchObject({execution:"exception",attemptCount:0});}
   expect(await f.t.run(ctx=>ctx.db.query("demoAttempts").collect())).toHaveLength(0);
  }
 });
 it("supplier revision cancels provably unsent reservations and requires recertification without rebooking",async()=>{
  const f=await setup(),p=await prepare(f);await authorize(f,p);await f.onboard({...f.supplier,expectedRevision:1,externalAccountId:"external-supplier-v2"},"change-destination");
  expect(await f.t.run(ctx=>ctx.db.get(p.versionId))).toMatchObject({status:"cancelled",reservations:"released"});await expect(prepare(f,"stale")).rejects.toThrow(/stale_supplier_approval/);
  const d=await f.get(f.detail.caseId),proposal=await f.propose(d,acceptance(f.input,"1"),"recertify",2);await f.vote(proposal);
  const next=await prepare(f,"new-destination");expect((await f.t.run(ctx=>ctx.db.get(next.versionId)))!.snapshot.destination).toEqual({externalAccountId:"external-supplier-v2",version:"golden-state-produce:r2"});expect((await f.get(d.caseId)).journals).toHaveLength(1);expect(await claim(f)).toBeNull();
 });
 it("recovers a possibly sent original after governance changes without rewriting beneficiary or operation key",async()=>{
  const f=await setup(),p=await prepare(f);await authorize(f,p);const lease=(await claim(f))!;expect(lease.action).toBe("submit");
  const failure=await f.t.mutation(api.demoPayments.fail,{scope:f.scope,token:"test-dispatch",paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,...paymentLeaseProof(lease),errorClass:"transport",error:"response lost",retryAfterMs:1000});
  await f.onboard({...f.supplier,expectedRevision:1,externalAccountId:"external-supplier-v2"},"change-after-send");await retire(f,"owner");vi.setSystemTime(failure.nextAttemptAt);
  const recovery=(await claim(f,"business-recovery-lease-2"))!;expect(recovery.action).toBe("reconcile");expect(recovery.command).toEqual(lease.command);expect(await f.t.run(ctx=>ctx.db.get(p.versionId))).toMatchObject({status:"queued",reservations:"reserved"});await expect(prepare(f,"replacement")).rejects.toThrow();
 });
});
