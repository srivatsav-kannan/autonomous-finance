import { afterEach, describe, expect, it, vi } from "vitest";
import { creditFixture } from "./quickbooks-business-fixture";
import { api } from "../../convex/_generated/api";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { ExecutePaymentEffect } from "../../src/payments/application/execute-payment-effect";
import { ReconcilePaymentEvidence } from "../../src/payments/application/reconcile-payment-evidence";
import { createConvexPaymentKernel } from "../../src/payments/adapters/convex-payment-kernel";
import { createConvexPaymentEvidence } from "../../src/payments/adapters/convex-payment-evidence";
import type { KernelTransport } from "../../src/payments/adapters/convex-transport";
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe("V5 independent governed credit versus durable bank execution",()=>{
 it.each([false,true])("holds new sends but preserves exact original recovery after credit linkage changes, possible send=%s",async(possible)=>{
   vi.useFakeTimers();vi.setSystemTime(Date.parse("2026-10-25T12:00:00Z"));
   const f=await creditFixture(), credit=await f.credit("V5-GOVERNED-RETURN");
   const request=(key:string)=>f.t.mutation(api.demoPayments.requestPayment,{scope:f.scope,seatId:"payments",token:"token-payments",requestKey:key,billIds:[f.original.billId],billAmounts:[{billId:f.original.billId,amountCents:5000}],credits:[{creditId:credit.creditId,amountCents:1200}]});
   const p=await request("v5-credit-original"),q=await f.humans.finance!.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...p});
   const bank=openFakeBank({path:":memory:",scope:f.scope,seed:"v5-governed",startTime:new Date(Date.now()).toISOString(),faults:possible?[{operation:"createTransfer",call:1,kind:"accept_then_lost_response"}]:[]});
   try {
     const transport=f.t as unknown as KernelTransport;let n=0;
     const worker=new ExecutePaymentEffect(createConvexPaymentKernel(transport,f.scope,"test-dispatch"),bank.provider,"v5-governed-worker",{now:Date.now,newLeaseToken:()=>`v5-credit-lease-${++n}`,startHeartbeat:()=>()=>{}});
     if(possible)await worker.tick();
     const original=(await f.t.run(ctx=>ctx.db.get(q.commandId)))!;
     // Explicit test-owned integrity drift affects only credit linkage, not invoice approval.
     await f.t.run(async ctx=>{const link=(await ctx.db.query("apCreditLinks").collect())[0]!;await ctx.db.patch(link._id,{amountCents:link.amountCents+1});});
     await expect(request("replacement-under-broken-credit")).rejects.toThrow();
     if(possible)vi.setSystemTime(original.nextAttemptAt);
     await worker.tick();
     if(!possible){
       expect(bank.harness.inspect().transfers).toEqual([]);
       expect((await f.t.run(ctx=>ctx.db.get(q.commandId)))!).toMatchObject({execution:"exception",attemptCount:0});
       expect(await f.t.run(ctx=>ctx.db.query("demoAttempts").collect())).toEqual([]);
       expect((await f.t.run(ctx=>ctx.db.get(credit.creditId)))!.consumedCents).toBe(0);
     }else{
       expect(bank.harness.inspect().calls.createTransfer).toBe(1);
       const transfer=bank.harness.inspect().transfers[0]!;expect(transfer.amountCents).toBe(3800);
       expect((await f.t.run(ctx=>ctx.db.get(q.commandId)))!.command).toEqual(original.command);
       expect((await f.t.run(ctx=>ctx.db.get(p.versionId)))!.reservations).toBe("reserved");
       bank.harness.settle(transfer.id);
       const rec=new ReconcilePaymentEvidence(createConvexPaymentEvidence(transport,f.scope,"test-evidence"),bank.provider,f.scope,Date.now);await rec.tick();await rec.tick();
       expect((await f.get(f.detail.caseId)).amounts).toMatchObject({acceptedCents:7700,creditedCents:1200,settledCents:3800,outstandingCents:2700});
       expect((await f.t.run(ctx=>ctx.db.get(credit.creditId)))!.consumedCents).toBe(1200);
       expect(await f.t.run(ctx=>ctx.db.query("journalEntries").collect())).toHaveLength(3);
       expect(bank.harness.inspect().transfers).toHaveLength(1);
     }
   }finally{bank.close();}
 });
});
