import {afterEach,describe,expect,it,vi} from "vitest";
import {makeFunctionReference} from "convex/server";
import type {Id} from "../../convex/_generated/dataModel";
import {api,demoFixture} from "../demo-fixture";
const prepare=makeFunctionReference<"mutation">("apPaymentRuns:prepare"),authorize=makeFunctionReference<"mutation">("apPaymentRuns:authorize"),cancel=makeFunctionReference<"mutation">("apPaymentRuns:cancel"),detail=makeFunctionReference<"query">("apPaymentRuns:detail");
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function fixture(){
 vi.useFakeTimers();vi.setSystemTime(Date.parse("2026-10-25T12:00:00Z"));const f=await demoFixture();
 const selection=[];
 for(let i=0;i<2;i++){const billId=await f.bill(10000);const caseId=await f.t.run(ctx=>ctx.db.insert("apCaseRecords",{scope:f.scope,primaryHash:String(i+1).repeat(64),currentRevision:1,snapshotHash:String(i+3).repeat(64),intake:{},createdBy:"ap_clerk",documentStatus:"reviewed",businessStatus:"approved",fieldReviewId:`review-${i}`,billId,acceptedCents:10000,identityMode:"simulated_human",createdAt:1,updatedAt:1}));selection.push({caseId,expectedRevision:1,snapshotHash:String(i+3).repeat(64),amountCents:3000});}
 return {...f,selection,args:{...f.payments,requestKey:"batch-1",selection,executionDate:"2026-10-28"}};
}
describe("atomic AP payment runs use existing per-payment commands",()=>{
 it("prepares exact immutable members once and does not queue before independent human authorization",async()=>{
  const f=await fixture(),run=await f.t.mutation(prepare,f.args);
  expect(await f.t.mutation(prepare,{...f.args,selection:[...f.selection].reverse()})).toEqual(run);
  expect(await f.t.run(ctx=>ctx.db.query("demoVersions").collect())).toHaveLength(2);expect(await f.t.run(ctx=>ctx.db.query("demoCommands").collect())).toEqual([]);
  await expect(f.t.mutation(authorize,{scope:f.scope,...run})).rejects.toThrow(/human/);
  const q=await f.human.mutation(authorize,{scope:f.scope,...run});expect(q.commandIds).toHaveLength(2);expect(await f.human.mutation(authorize,{scope:f.scope,...run})).toEqual(q);
  const commands=await f.t.run(ctx=>ctx.db.query("demoCommands").collect());expect(new Set(commands.map(c=>c.command.idempotencyKey)).size).toBe(2);
  const view=await f.human.query(detail,{scope:f.scope,runId:run.runId});expect(view.items.every((i:any)=>i.payment.snapshot.amountCents===3000&&i.payment.snapshot.schedule.executionDate==="2026-10-28")).toBe(true);
  expect(JSON.stringify(view)).not.toContain("tokenHash");expect(JSON.stringify(view)).not.toContain("leaseToken");
 });
 it("rolls back all reservations if any selected member is stale or unavailable",async()=>{
  const f=await fixture();await expect(f.t.mutation(prepare,{...f.args,selection:f.selection.map((s,i)=>i===1?{...s,expectedRevision:2}:s)})).rejects.toThrow(/stale/);
  expect(await f.t.run(ctx=>ctx.db.query("apPaymentRuns").collect())).toEqual([]);expect(await f.t.run(ctx=>ctx.db.query("demoVersions").collect())).toEqual([]);
  expect((await f.t.run(ctx=>ctx.db.query("demoBills").collect())).every(b=>b.reservedVersionId===undefined)).toBe(true);
 });
 it("rejects changed schedule, amount and membership under an existing batch key",async()=>{
  const f=await fixture();await f.t.mutation(prepare,f.args);
  for(const change of [{executionDate:"2026-10-29"},{selection:f.selection.slice(0,1)},{selection:f.selection.map(s=>({...s,amountCents:4000}))}])await expect(f.t.mutation(prepare,{...f.args,...change})).rejects.toThrow(/idempotency conflict/);
  await expect(f.t.mutation(prepare,{...f.args,requestKey:"duplicate",selection:[f.selection[0],f.selection[0]]})).rejects.toThrow(/distinct/);
 });
 it("atomically refuses all authorization if a case changes or a frozen member was cancelled",async()=>{
  const f=await fixture(),run=await f.t.mutation(prepare,f.args);
  const d=await f.human.query(detail,{scope:f.scope,runId:run.runId});const last=d.items.at(-1)!;
  await f.human.mutation(api.demoPayments.cancel,{scope:f.scope,versionId:last.versionId});
  await expect(f.human.mutation(authorize,{scope:f.scope,...run})).rejects.toThrow(/Stale/);
  expect(await f.t.run(ctx=>ctx.db.query("demoCommands").collect())).toEqual([]);
  expect((await f.t.run(ctx=>ctx.db.query("demoVersions").collect())).every(v=>v.approvals.length===0)).toBe(true);
 });
 it("cancels all provably unsent proposals, releases allocations and requires a fresh batch/key for rescheduling",async()=>{
  const f=await fixture(),run=await f.t.mutation(prepare,f.args);await f.human.mutation(authorize,{scope:f.scope,...run});
  expect(await f.human.mutation(cancel,{scope:f.scope,...run})).toEqual({ok:true});expect(await f.human.mutation(cancel,{scope:f.scope,...run})).toEqual({ok:true});
  const next=await f.t.mutation(prepare,{...f.args,requestKey:"reschedule",executionDate:"2026-10-29"});expect(next.snapshotHash).not.toBe(run.snapshotHash);
  expect((await f.human.query(detail,{scope:f.scope,runId:next.runId})).items.every((i:any)=>i.payment.status==="awaiting_approval")).toBe(true);
 });
 it("does not partially cancel a batch containing a possibly sent member",async()=>{
  const f=await fixture(),run=await f.t.mutation(prepare,{...f.args,executionDate:"2026-10-25"});await f.human.mutation(authorize,{scope:f.scope,...run});
  const lease=await f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:"scoped-ap-v2",workerId:"batch-worker",leaseToken:"batch-worker-unique-lease"});expect(lease).not.toBeNull();
  await expect(f.human.mutation(cancel,{scope:f.scope,...run})).rejects.toThrow(/Submission/);
  const versions=await f.t.run(ctx=>ctx.db.query("demoVersions").collect());expect(versions.every(v=>v.reservations==="reserved"&&v.status==="queued")).toBe(true);
 });
 it("detects a tampered run manifest before any financial authorization",async()=>{
  const f=await fixture(),run=await f.t.mutation(prepare,f.args);
  await f.t.run(ctx=>ctx.db.patch(run.runId as Id<"apPaymentRuns">,{executionDate:"2026-10-25"}));
  await expect(f.human.mutation(authorize,{scope:f.scope,...run})).rejects.toThrow(/Stale/);expect(await f.t.run(ctx=>ctx.db.query("demoCommands").collect())).toEqual([]);
 });
});
