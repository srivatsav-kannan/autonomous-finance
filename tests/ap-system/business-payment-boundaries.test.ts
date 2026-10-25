import type { Id } from "../../convex/_generated/dataModel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { businessFixture, acceptance, br, syncPrimary } from "./business-fixture";
import { packet } from "./accounting-fixture";
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
  const creditInput=packet("boundary-credit");const candidate=creditInput.candidate!;
  candidate.kind="credit_note";creditInput.documents[0]!.kind="credit_note";
  candidate.lines[0]!.quantity.decimal="1";candidate.lines[0]!.unitPriceCents=2000;candidate.lines[0]!.amountCents=2000;candidate.lines[0]!.allocations[0]!.amountCents=2000;candidate.subtotalCents=2000;candidate.totalCents=2000;
  syncPrimary(creditInput);const creditCase=await f.reviewed(creditInput);
  const proposal=await f.t.mutation(br.propose!,{...f.ap,input:{caseId:creditCase.caseId,expectedRevision:creditCase.revision,snapshotHash:creditCase.snapshotHash,idempotencyKey:"boundary-credit-proposal",policyVersion:f.policy.version,supplierRevision:1,credit:{originalCaseId:f.detail.caseId,originalApprovalId:b.proposal.proposalId,freightCents:0,discountCents:0,lines:[{creditLineId:"line-1",originalLineId:"line-1",basis:"price_adjustment",quantity:"0",netCents:2000,taxCents:0,returnEvidence:[]}],reason:"Explicit supplier price adjustment against the original approved invoice"}}});
  let recognized=await f.vote(proposal);if(recognized.status==="pending")recognized=await f.vote(proposal,"finance");
  expect(recognized.status).toBe("approved");const {creditId}=recognized;
  expect(await f.t.run(ctx=>ctx.db.query("apCreditLinks").collect())).toEqual([expect.objectContaining({creditId,originalBillId:b.billId})]);
  const r=await f.t.mutation(api.demoPayments.requestPayment,{scope:f.scope,seatId:"payments",token:"token-payments",requestKey:"partial-credit",billIds:[b.billId],billAmounts:[{billId:b.billId,amountCents:6000}],credits:[{creditId,amountCents:2000}]});
  await f.t.run((ctx)=>settleEffects(ctx,r.versionId));let d=await f.get(f.detail.caseId);expect(d.amounts).toMatchObject({acceptedCents:7700,creditedCents:2000,instructedCents:4000,settledCents:4000,outstandingCents:1700});
  await f.t.run((ctx)=>returnEffects(ctx,r.versionId));d=await f.get(f.detail.caseId);expect(d.amounts).toMatchObject({creditedCents:2000,settledCents:0,outstandingCents:5700});
 });
});
