import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api } from "./demo-fixture";
import {fixture as accountingFixture,packet,refs} from "./ap-system/accounting-fixture";
import type {Id} from "../convex/_generated/dataModel";
const request=makeFunctionReference<"mutation">("apCasePayments:request");
const authorize=makeFunctionReference<"mutation">("apCasePayments:authorize");
const detail=makeFunctionReference<"query">("apCasePayments:detail");
afterEach(()=>vi.unstubAllEnvs());
async function fixture(){
 const f=await accountingFixture();let invoice=0;
 const bill=async()=>{const d=await f.reviewed(packet(`handoff-${++invoice}`));const b=await f.human.mutation(refs.approve,{scope:f.scope,input:{...f.request(d,`approve-${invoice}`),acceptedCents:7700}});return {d,billId:b.billId as Id<"demoBills">};};
 const {d,billId}=await bill(),caseId=d.caseId as Id<"apCaseRecords">;
 return {...f,human:f.payer,bill:async()=>(await bill()).billId,payments:{scope:f.scope,seatId:"payments",token:"token-payments"},dispatcherToken:"test-dispatch",billId,caseId,binding:{scope:f.scope,caseId,expectedRevision:d.revision,snapshotHash:d.snapshotHash}};
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
  expect(view.snapshot.amountCents).toBe(7700);expect(view.command.idempotencyKey).toBe(`demo:${prepared.versionId}`);
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
 it("checks current case authority at first submission without rewriting a possible send",async()=>{
  const f=await fixture();const prepared=await f.t.mutation(request,{...f.payments,...f.binding,idempotencyKey:"prepare"});
  await f.human.mutation(authorize,{...f.binding,versionId:prepared.versionId,paymentSnapshotHash:prepared.snapshotHash});
  await f.t.run(ctx=>ctx.db.patch(f.caseId,{documentStatus:"review_required"}));
  await expect(f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:"scoped-ap-v2",workerId:"first-dispatch",leaseToken:"case-stale-lease"})).resolves.toBeNull();
  const command=await f.t.run(ctx=>ctx.db.query("demoCommands").first());expect(command).toMatchObject({attemptCount:0,execution:"exception"});
 });
 it("refuses a payment from another bill even within the same run",async()=>{
  const f=await fixture();const otherBill=await f.bill();
  const other=await f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:"other",billIds:[otherBill],credits:[]});
  await expect(f.human.mutation(authorize,{...f.binding,versionId:other.versionId,paymentSnapshotHash:other.snapshotHash})).rejects.toThrow(/another AP case/);
 });
});
