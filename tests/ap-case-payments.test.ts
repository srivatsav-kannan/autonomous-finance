import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api, demoFixture } from "./demo-fixture";
const request=makeFunctionReference<"mutation">("apCasePayments:request");
const authorize=makeFunctionReference<"mutation">("apCasePayments:authorize");
const detail=makeFunctionReference<"query">("apCasePayments:detail");
afterEach(()=>vi.unstubAllEnvs());
async function fixture(){
 const f=await demoFixture(); const billId=await f.bill(67860);
 const caseId=await f.t.run(ctx=>ctx.db.insert("apCaseRecords",{scope:f.scope,primaryHash:"a".repeat(64),currentRevision:1,snapshotHash:"b".repeat(64),intake:{},createdBy:"ap_clerk",documentStatus:"reviewed",businessStatus:"approved",fieldReviewId:"review-1",billId,acceptedCents:67860,identityMode:"simulated_human",createdAt:1,updatedAt:1}));
 return {...f,billId,caseId,binding:{scope:f.scope,caseId,expectedRevision:1,snapshotHash:"b".repeat(64)}};
}
describe("case payment handoff to existing durable engine (component)",()=>{
 it("prepares once and leaves command empty until independent human authorization",async()=>{
  const f=await fixture();const args={...f.payments,...f.binding,idempotencyKey:"same-case-payment"};
  const prepared=await f.t.mutation(request,args);expect(await f.t.mutation(request,args)).toEqual(prepared);
  expect(await f.t.run(ctx=>ctx.db.query("demoVersions").collect())).toHaveLength(1);
  expect(await f.t.run(ctx=>ctx.db.query("demoCommands").collect())).toHaveLength(0);
  const auth={...f.binding,versionId:prepared.versionId,paymentSnapshotHash:prepared.snapshotHash};
  await expect(f.t.mutation(authorize,auth)).rejects.toThrow(/human required/);
  const command=await f.human.mutation(authorize,auth);expect(await f.human.mutation(authorize,auth)).toEqual(command);
  const view=await f.human.query(detail,{scope:f.scope,versionId:prepared.versionId});
  expect(view.snapshot.amountCents).toBe(67860);expect(view.command.idempotencyKey).toBe(`demo:${prepared.versionId}`);
  expect(JSON.stringify(view)).not.toContain("leaseToken");
  expect(await f.t.run(ctx=>ctx.db.query("journalEntries").collect())).toHaveLength(1); // recognition only
 });
 it("rejects stale revision, wrong case and unreviewed direct requests",async()=>{
  const f=await fixture();
  await expect(f.t.mutation(request,{...f.payments,...f.binding,expectedRevision:2,idempotencyKey:"stale"})).rejects.toThrow(/Stale/);
  const prepared=await f.t.mutation(request,{...f.payments,...f.binding,idempotencyKey:"valid"});
  await f.human.mutation(api.demoPayments.cancel,{scope:f.scope,versionId:prepared.versionId});
  await f.t.run(ctx=>ctx.db.patch(f.caseId,{documentStatus:"review_required",businessStatus:"held"}));
  await expect(f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:"bypass",billIds:[f.billId],credits:[]})).rejects.toThrow(/AP evidence/);
  await expect(f.human.mutation(authorize,{...f.binding,versionId:prepared.versionId,paymentSnapshotHash:prepared.snapshotHash})).rejects.toThrow(/unapproved/);
  expect(await f.t.run(ctx=>ctx.db.query("demoCommands").collect())).toHaveLength(0);
 });
 it("refuses a payment from another bill even within the same run",async()=>{
  const f=await fixture();const otherBill=await f.bill();
  const other=await f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:"other",billIds:[otherBill],credits:[]});
  await expect(f.human.mutation(authorize,{...f.binding,versionId:other.versionId,paymentSnapshotHash:other.snapshotHash})).rejects.toThrow(/another AP case/);
 });
});
