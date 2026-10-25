import {afterEach,it,expect,vi} from "vitest";
import {makeFunctionReference} from "convex/server";
import {fixture,packet,refs} from "./accounting-fixture";
import {businessFixture} from "./business-fixture";
import {openFakeBank} from "../../src/integrations/banking/fake";
import {ExecutePaymentEffect} from "../../src/payments/application/execute-payment-effect";
import {ReconcilePaymentEvidence} from "../../src/payments/application/reconcile-payment-evidence";
import {createConvexPaymentKernel} from "../../src/payments/adapters/convex-payment-kernel";
import {createConvexPaymentEvidence} from "../../src/payments/adapters/convex-payment-evidence";
import type {KernelTransport} from "../../src/payments/adapters/convex-transport";
import type {OperationalTimings} from "../../src/ap-system/operational-timing";
const current=makeFunctionReference<"query">("apOperationalMetrics:current"),request=makeFunctionReference<"mutation">("apCasePayments:request"),authorize=makeFunctionReference<"mutation">("apCasePayments:authorize");
const epoch=Date.parse("2026-10-25T12:00:00Z"),time=(elapsed:number)=>vi.setSystemTime(epoch+elapsed);
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
it("reads actual retained review/post/authorization/recovery events and changes no economic state",async()=>{
 vi.useFakeTimers();time(0);const f=await fixture(),ingested=await f.t.mutation(refs.ingest,{...f.ap,input:packet()});const d=await f.get(ingested.caseId);const retainedAt=(await f.t.run(ctx=>ctx.db.query("apCaseRevisions").first()))!.at;
 time(10_000);await f.human.mutation(refs.review,{scope:f.scope,input:f.request(d)});
 time(30_000);await f.human.mutation(refs.approve,{scope:f.scope,input:{...f.request(d,"approve"),acceptedCents:7700}});
 const binding={scope:f.scope,caseId:d.caseId,expectedRevision:d.revision,snapshotHash:d.snapshotHash};
 time(40_000);const p=await f.t.mutation(request,{...binding,seatId:"payments",token:"token-payments",idempotencyKey:"metrics",amountCents:2000});
 time(50_000);await f.human.mutation(authorize,{...binding,versionId:p.versionId,paymentSnapshotHash:p.snapshotHash});
 const bank=openFakeBank({path:":memory:",scope:f.scope,seed:"timing-only",startTime:new Date(epoch).toISOString(),faults:[{operation:"createTransfer",call:1,kind:"accept_then_lost_response"}]});
 try{const transport=f.t as unknown as KernelTransport;let n=0;const worker=new ExecutePaymentEffect(createConvexPaymentKernel(transport,f.scope,"test-dispatch"),bank.provider,"timing-worker",{now:Date.now,newLeaseToken:()=>`timing-test-lease-${++n}`,startHeartbeat:()=>()=>{}}),reconcile=new ReconcilePaymentEvidence(createConvexPaymentEvidence(transport,f.scope,"test-evidence"),bank.provider,f.scope,Date.now);
 time(60_000);await worker.tick();time(90_000);
 const load=()=>f.human.query(current,{scope:f.scope}) as Promise<OperationalTimings>;
 let metrics=await load(),samples=metrics.cases[0]!.samples;
 expect(samples.find(s=>s.metric==="document_to_review")).toMatchObject({state:"completed",elapsedMs:epoch+10_000-retainedAt,revision:1,snapshotHash:d.snapshotHash});
 expect(samples.find(s=>s.metric==="review_to_post")).toMatchObject({state:"completed",elapsedMs:20_000});expect(samples.find(s=>s.paymentVersionId===p.versionId&&s.metric==="human_wait")).toMatchObject({state:"completed",elapsedMs:10_000,revision:1});
 expect(samples.find(s=>s.metric==="recovery_time")).toMatchObject({state:"ongoing",elapsedMs:30_000});
 time(100_000);await worker.tick();bank.harness.settle(bank.harness.inspect().transfers[0]!.id);time(110_000);await reconcile.tick();
 metrics=await load();samples=metrics.cases[0]!.samples;const persisted=await f.t.run(async ctx=>({attempts:await ctx.db.query("demoAttempts").collect(),command:await ctx.db.query("demoCommands").first(),transaction:await ctx.db.query("demoTransactions").first()}));const matchedAt=persisted.transaction!.matchedAt!,failedAt=persisted.attempts.find(a=>a.errorClass)!.completedAt!;
 expect(samples.find(s=>s.metric==="recovery_time")).toMatchObject({state:"completed",elapsedMs:matchedAt-failedAt,endedAt:matchedAt});expect(samples.find(s=>s.metric==="unresolved_payment_age")).toMatchObject({state:"completed",elapsedMs:matchedAt-persisted.command!.firstAttemptAt!,endedAt:matchedAt});
 const before=await f.t.run(async ctx=>({commands:await ctx.db.query("demoCommands").collect(),journals:await ctx.db.query("journalEntries").collect()}));await load();expect(await f.t.run(async ctx=>({commands:await ctx.db.query("demoCommands").collect(),journals:await ctx.db.query("journalEntries").collect()}))).toEqual(before);expect(bank.harness.inspect().transfers).toHaveLength(1);
 await expect(f.t.query(current,{scope:f.scope})).rejects.toThrow();await expect(f.human.query(current,{scope:{...f.scope,accountId:"other"}})).rejects.toThrow();
 }finally{bank.close();}
});
it("measures a sequential business route until its final independent vote",async()=>{vi.useFakeTimers();time(0);const f=await businessFixture();time(10_000);const proposal=await f.propose();time(20_000);await f.vote(proposal);time(30_000);let result=await f.humans.finance!.query(current,{scope:f.scope}) as OperationalTimings;expect(result.cases[0]!.samples.find(s=>s.id===`business:${proposal.proposalId}`)).toMatchObject({state:"ongoing",elapsedMs:20_000});time(40_000);await f.vote(proposal,"finance");result=await f.humans.finance!.query(current,{scope:f.scope}) as OperationalTimings;expect(result.cases[0]!.samples.find(s=>s.id===`business:${proposal.proposalId}`)).toMatchObject({state:"completed",elapsedMs:30_000});});

it("binds grouped proposal timing to its frozen source revision and stops an unsent queue at cancellation",async()=>{
 vi.useFakeTimers();time(0);const f=await fixture(),created=await f.t.mutation(refs.ingest,{...f.ap,input:packet()});const d=await f.get(created.caseId);
 time(10_000);await f.human.mutation(refs.review,{scope:f.scope,input:f.request(d)});time(20_000);await f.human.mutation(refs.approve,{scope:f.scope,input:{...f.request(d,"approve"),acceptedCents:7700}});
 time(30_000);const run=await f.t.mutation(makeFunctionReference<"mutation">("apPaymentRuns:prepare"),{scope:f.scope,seatId:"payments",token:"token-payments",requestKey:"timing-run",selection:[{caseId:d.caseId,expectedRevision:d.revision,snapshotHash:d.snapshotHash,amountCents:2000}],executionDate:"2026-11-01"});
 time(40_000);let result=await f.human.query(current,{scope:f.scope}) as OperationalTimings;let wait=result.cases[0]!.samples.find(s=>s.paymentVersionId&&s.metric==="human_wait")!;
 expect(wait).toMatchObject({state:"ongoing",elapsedMs:10_000,revision:1,snapshotHash:d.snapshotHash,paymentRunIds:[run.runId]});
 time(50_000);await f.human.mutation(makeFunctionReference<"mutation">("apPaymentRuns:cancel"),{scope:f.scope,...run});time(60_000);result=await f.human.query(current,{scope:f.scope}) as OperationalTimings;wait=result.cases[0]!.samples.find(s=>s.paymentVersionId&&s.metric==="human_wait")!;
 expect(wait).toMatchObject({state:"completed",elapsedMs:20_000,revision:1,paymentRunIds:[run.runId]});expect(result.cases[0]!.samples.find(s=>s.metric==="unresolved_payment_age")).toMatchObject({state:"not_started",elapsedMs:null});
 const casesBefore=result.cases.length;await f.t.run(async ctx=>{const row=(await ctx.db.query("apCaseRecords").collect())[0]!;const {_id,_creationTime,...copy}=row;await ctx.db.insert("apCaseRecords",{...copy,scope:{...copy.scope,accountId:"foreign-account"}});});expect((await f.human.query(current,{scope:f.scope}) as OperationalTimings).cases).toHaveLength(casesBefore);
});
