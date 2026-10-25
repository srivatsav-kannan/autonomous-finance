import type { Id } from "../../convex/_generated/dataModel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { businessFixture, acceptance } from "./business-fixture";
import { api } from "../../convex/_generated/api";
import { PAYMENT_EXECUTOR_VERSION } from "../../src/payments/contracts";
import { resolveAPBusinessPaymentAuthority } from "../../convex/lib/apSystem/businessAuthority";
import { settleEffects, returnEffects } from "../../convex/lib/payments/reservations";
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
describe("B3 governance versus C3 reservation lifecycle",()=>{
 it.each([false,true])("bank change cancels provably unsent operation, queued=%s",async(queued)=>{
  const f=await businessFixture();const bill=await f.recognize();const r=await f.t.mutation(api.demoPayments.requestPayment,{scope:f.scope,seatId:"payments",token:"token-payments",requestKey:"request",billIds:[bill.billId],credits:[],billAmounts:[{billId:bill.billId,amountCents:4000}]});
  const command=queued?await f.humans.finance!.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...r}):null;
  await f.onboard({...f.supplier,expectedRevision:1,externalAccountId:"bank-v2"},"change");
  expect(await f.t.run((ctx)=>ctx.db.get(r.versionId))).toMatchObject({status:"cancelled",reservations:"released"});
  expect((await f.t.run((ctx)=>ctx.db.get(bill.billId as Id<"demoBills">)))?.reservedVersionId).toBeUndefined();
  if(command)expect(await f.t.run((ctx)=>ctx.db.get(command.commandId))).toMatchObject({execution:"cancelled",attemptCount:0});
 });
 it("bank change retains possible-send key, command, request and reservations",async()=>{
  const f=await businessFixture();const bill=await f.recognize();const r=await f.t.mutation(api.demoPayments.requestPayment,{scope:f.scope,seatId:"payments",token:"token-payments",requestKey:"request",billIds:[bill.billId],credits:[]});
  const command=await f.humans.finance!.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...r});
  const lease=await f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:"test-dispatch",paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:"B3-boundary",leaseToken:"B3-possible-send-lease"});expect(lease).not.toBeNull();
  const before=await f.t.run((ctx)=>ctx.db.get(command.commandId));
  await f.onboard({...f.supplier,expectedRevision:1,externalAccountId:"bank-v2"},"change");
  expect(await f.t.run((ctx)=>ctx.db.get(command.commandId))).toEqual(before);
  expect(await f.t.run((ctx)=>ctx.db.get(r.versionId))).toMatchObject({status:"queued",reservations:"reserved",requestKey:"request"});
  expect((await f.t.run((ctx)=>ctx.db.get(bill.billId as Id<"demoBills">)))?.reservedVersionId).toBe(r.versionId);
  await expect(f.t.run((ctx)=>resolveAPBusinessPaymentAuthority(ctx,f.scope,[bill.billId]))).rejects.toThrow(/stale_supplier/);
 });
 it("mixed legacy and B3 obligations never resolve to a default beneficiary",async()=>{
  const f=await businessFixture();const b=await f.recognize(f.detail,acceptance(f.input,"1"));const legacy=await f.t.run(async(ctx)=>{const bill=await ctx.db.get(b.billId as Id<"demoBills">);const {_id,_creationTime,...value}=bill!;return ctx.db.insert("demoBills",{...value,invoiceNumber:"legacy"});});
  expect(await f.t.run((ctx)=>resolveAPBusinessPaymentAuthority(ctx,f.scope,[legacy]))).toBe(null);
  await expect(f.t.run((ctx)=>resolveAPBusinessPaymentAuthority(ctx,f.scope,[legacy,b.billId]))).rejects.toThrow(/mixed_business_authority/);
 });
 it("projects consumed gross discharge as separate credit and cash and retains credit when cash returns",async()=>{
  const f=await businessFixture();const b=await f.recognize();
  // This exercises the authoritative reservation transition in isolation; no provider or settlement-journal claim.
  const {creditId}=await f.human.mutation(api.demoPayments.recordCredit,{scope:f.scope,reference:"boundary-credit",amountCents:2000,evidence:"isolated legacy credit projection fixture",date:"2026-10-19",expenseAccount:"5000"});
  const r=await f.t.mutation(api.demoPayments.requestPayment,{scope:f.scope,seatId:"payments",token:"token-payments",requestKey:"partial-credit",billIds:[b.billId],billAmounts:[{billId:b.billId,amountCents:6000}],credits:[{creditId,amountCents:2000}]});
  await f.t.run((ctx)=>settleEffects(ctx,r.versionId));let d=await f.get(f.detail.caseId);expect(d.amounts).toMatchObject({acceptedCents:7700,creditedCents:2000,instructedCents:4000,settledCents:4000,outstandingCents:1700});
  await f.t.run((ctx)=>returnEffects(ctx,r.versionId));d=await f.get(f.detail.caseId);expect(d.amounts).toMatchObject({creditedCents:2000,settledCents:0,outstandingCents:5700});
 });
});
