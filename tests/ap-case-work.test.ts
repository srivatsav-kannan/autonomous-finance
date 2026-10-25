import {afterEach,describe,expect,it,vi} from "vitest";
import {makeFunctionReference} from "convex/server";
import {fixture,packet,refs} from "./ap-system/accounting-fixture";
const claim=makeFunctionReference<"mutation">("apCaseAgent:claim"),advance=makeFunctionReference<"mutation">("apCaseAgent:advance"),control=makeFunctionReference<"mutation">("apCaseAgent:control"),inspect=makeFunctionReference<"query">("apCaseAgent:inspect");
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
async function setup(){const f=await fixture();const p=packet("WORK-1");p.documents=p.documents.filter(d=>d.kind!=="receipt");p.purchasingEvidence=p.purchasingEvidence.filter(d=>d.kind!=="receipt");p.candidate!.sources=p.candidate!.sources.filter(s=>!s.sourceId.startsWith("receipt-"));const r=await f.t.mutation(refs.ingest,{...f.ap,input:p});return {...f,caseId:r.caseId};}
const auth=(f:Awaited<ReturnType<typeof setup>>)=>({...f.ap,caseId:f.caseId});
describe("shared AP work and atomic transition evidence",()=>{
 it("reconstructs creation, claim, missing-evidence wait and resumption on one work; replay creates no duplicate diff",async()=>{
  const f=await setup();let d=await f.get(f.caseId);const workId=d.work!.workId;
  expect(d.work!.status).toBe("queued");expect(d.timeline.filter(e=>e.transition)).toHaveLength(1);
  const lease=await f.t.mutation(claim,{...f.ap,requestId:"claim-a"});
  expect(await f.t.mutation(claim,{...f.ap,requestId:"claim-a"})).toEqual(lease);
  await f.t.mutation(advance,{...auth(f),generation:lease.generation});
  const count=(await f.get(f.caseId)).timeline.length;
  expect(await f.t.mutation(advance,{...auth(f),generation:lease.generation})).toMatchObject({replayed:true});
  d=await f.get(f.caseId);expect(d.timeline).toHaveLength(count);expect(d.work).toMatchObject({workId,status:"waiting",stage:"missing_evidence"});
  const revised=packet("WORK-1");revised.explicitRevisionOf=f.caseId;revised.idempotencyKey="receipt-arrival";revised.candidate!.revision=2;
  await f.t.mutation(refs.ingest,{...f.ap,input:revised});
  const next=await f.t.mutation(claim,{...f.ap,requestId:"claim-b"});await f.t.mutation(advance,{...auth(f),generation:next.generation});
  d=await f.get(f.caseId);expect(d.work).toMatchObject({workId,status:"waiting",stage:"field_review"});
  const events=d.timeline.filter(e=>e.transition).map(e=>e.transition!);
  expect(events.map(e=>e.action)).toEqual(["created","claimed","advanced","claimed","advanced"]);
  for(let i=1;i<events.length;i++)expect(events[i]!.before).toEqual(events[i-1]!.after);
  expect(events.at(-1)!.sourceBindings.some(s=>s.sourceId.startsWith("receipt-"))).toBe(true);
  expect((await f.t.query(inspect,auth(f))).work).toEqual(d.work);
  expect(d.payments).toHaveLength(0);expect(d.journals).toHaveLength(0);
 });
 it("binds human controls to current work and source; records stale denial without business effect",async()=>{
  const f=await setup();const d=await f.get(f.caseId);const request={scope:f.scope,caseId:f.caseId,action:"pause" as const,reason:"Investigate source discrepancy",expectedGeneration:d.work!.generation,expectedRevision:d.revision,snapshotHash:d.snapshotHash,idempotencyKey:"pause-1"};
  await expect(f.t.mutation(control,request)).rejects.toThrow(/human/);
  expect(await f.human.mutation(control,request)).toEqual({ok:true});
  expect(await f.human.mutation(control,request)).toEqual({ok:true});
  const paused=await f.get(f.caseId);expect(paused.work!.generation).toBe(1);expect(paused.work!.status).toBe("paused");
  const stale={...request,action:"resume" as const,idempotencyKey:"stale-resume"};
  expect(await f.human.mutation(control,stale)).toEqual({ok:false,code:"stale_work_control"});
  const denied=await f.get(f.caseId);expect(denied.work).toEqual(paused.work);const event=denied.timeline.find(e=>e.transition?.outcome==="denied")!.transition!;expect(event.changes).toEqual([]);expect(event.before).toEqual(event.after);
  await f.human.mutation(control,{...stale,idempotencyKey:"resume-current",expectedGeneration:1});
  const resumed=await f.get(f.caseId);expect(resumed.work).toMatchObject({workId:d.work!.workId,status:"queued",generation:2});
  expect(resumed.timeline.filter(e=>e.transition?.action==="paused")).toHaveLength(1);expect(resumed.payments).toHaveLength(0);expect(resumed.journals).toHaveLength(0);
 });
 it("records one handoff when an AP-only claim returns null, even after replay and later polling",async()=>{
  const f=await fixture();const d=await f.reviewed(packet("WORK-HANDOFF"));
  await f.human.mutation(refs.approve,{scope:f.scope,input:{...f.request(d,"approve-handoff"),acceptedCents:7700}});
  expect(await f.t.mutation(claim,{...f.ap,requestId:"ap-only"})).toBeNull();
  const first=await f.get(d.caseId);const n=first.timeline.filter(e=>e.transition?.action==="handoff").length;expect(n).toBe(1);
  expect(await f.t.mutation(claim,{...f.ap,requestId:"ap-only"})).toBeNull();
  expect(await f.t.mutation(claim,{...f.ap,requestId:"ap-poll"})).toBeNull();
  expect((await f.get(d.caseId)).timeline.filter(e=>e.transition?.action==="handoff")).toHaveLength(n);
  expect((await f.get(d.caseId)).payments).toHaveLength(0);
 });
 it("fences stale/wrong-role leases and persists a model handoff without creating payment authority",async()=>{
  const f=await setup();const lease=await f.t.mutation(claim,{...f.ap,requestId:"model-lease"});const d=await f.get(f.caseId);
  await expect(f.t.mutation(advance,{...auth(f),seatId:"payments",token:"token-payments",generation:lease.generation})).rejects.toThrow(/lease/);
  const decision={version:"ap-model-decision-v1",runId:"model-1",mode:"model",provider:"openai",model:"test-double",action:"handoff",reason:"Source contradiction needs controller",evidenceIds:[],inspectedRevision:d.revision,inspectedSnapshotHash:d.snapshotHash,inputHash:"a".repeat(64),usage:{inputTokens:10,outputTokens:5,costMicros:1},latencyMs:20};
  await expect(f.t.mutation(advance,{...auth(f),generation:lease.generation,decision:{...decision,inspectedRevision:99}})).rejects.toThrow(/Stale model/);
  await f.t.mutation(advance,{...auth(f),generation:lease.generation,decision});
  const after=await f.get(f.caseId);expect(after.work).toMatchObject({status:"escalated",owner:"controller"});expect(after.timeline.at(-1)!.transition!.decision).toMatchObject({runId:"model-1"});expect(after.payments).toHaveLength(0);expect(after.journals).toHaveLength(0);
 });
});
