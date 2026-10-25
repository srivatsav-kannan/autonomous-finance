import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {makeFunctionReference} from "convex/server";
import {businessFixture,cr,subject} from "./business-fixture";
import type {OperationalTimings} from "../../src/ap-system/operational-timing";
const current=makeFunctionReference<"query">("apOperationalMetrics:current"),epoch=Date.parse("2026-10-25T12:00:00Z");
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(epoch);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
type Fixture=Awaited<ReturnType<typeof businessFixture>>;
const history=(f:Fixture)=>f.t.run(async ctx=>({cases:await ctx.db.query("apCaseRecords").collect(),proposals:await ctx.db.query("apApprovalProposals").collect(),decisions:await ctx.db.query("apCaseDecisions").collect(),journals:await ctx.db.query("journalEntries").collect(),commands:await ctx.db.query("demoCommands").collect()}));
async function read(f:Fixture,proposalId:string){const detail=await f.get(f.detail.caseId),metrics=await f.humans.finance!.query(current,{scope:f.scope}) as OperationalTimings;return{detail,sample:metrics.cases[0]!.samples.find(s=>s.id===`business:${proposalId}`)};}
it("keeps a valid partial route pending without demanding future quorum or changing history",async()=>{
 const f=await businessFixture(),p=await f.propose();expect((await read(f,p.proposalId)).detail.domain?.approvalStatus).toBe("pending");
 vi.setSystemTime(epoch+10_000);await f.vote(p);vi.setSystemTime(epoch+20_000);const before=await history(f),r=await read(f,p.proposalId);
 expect(r.detail.domain).toMatchObject({approvalStatus:"pending",stage:1});expect(r.detail.domain?.votes).toHaveLength(1);expect(r.sample).toMatchObject({state:"ongoing"});expect(await history(f)).toEqual(before);
});
it.each(["retired","rebound"])("marks a retained %s voter stale without rewriting pending approval history",async mode=>{
 const f=await businessFixture(),p=await f.propose();await f.vote(p);
 await f.t.run(async ctx=>{if(mode==="retired"){const seat=(await ctx.db.query("seats").collect()).find(s=>s.seatId==="human-owner")!;await ctx.db.patch(seat._id,{status:"retired"});}else{const config=(await ctx.db.query("demoConfigs").collect())[0]!;await ctx.db.patch(config._id,{humanSubjects:config.humanSubjects.map(b=>b.subject===subject("owner")?{...b,seatId:"human-second"}:b)});}});
 vi.setSystemTime(epoch+20_000);const before=await history(f),r=await read(f,p.proposalId);
 expect(r.detail.domain?.approvalStatus).toBe("stale");expect(r.detail.domain?.votes).toHaveLength(1);expect(r.detail.exceptions.some(e=>e.code==="business_authority_hold")).toBe(true);expect(r.sample).toMatchObject({state:"unavailable",elapsedMs:null,endedAt:null});expect(await history(f)).toEqual(before);await expect(f.vote(p,"finance")).rejects.toThrow();expect(await history(f)).toEqual(before);
});
it.each(["revoked","expired"])("marks a retained delegated vote %s before final quorum as unavailable",async mode=>{
 const f=await businessFixture(),p=await f.propose(),grant=await f.humans.owner!.mutation(cr.delegate!,{scope:f.scope,idempotencyKey:"timing-delegation",delegation:{groupId:"owner",toSubject:subject("delegate"),maxCents:10000,validFrom:epoch-1000,validUntil:epoch+30_000,reason:"Temporary synthetic absence"}});
 await f.vote(p,"delegate",undefined,{delegationId:grant.delegationId});expect((await read(f,p.proposalId)).detail.domain?.approvalStatus).toBe("pending");
 if(mode==="revoked")await f.humans.owner!.mutation(cr.revokeDelegation!,{scope:f.scope,delegationId:grant.delegationId,reason:"Synthetic revocation before completion"});else vi.setSystemTime(epoch+30_001);
 const before=await history(f),r=await read(f,p.proposalId);expect(r.detail.domain?.approvalStatus).toBe("stale");expect(r.sample).toMatchObject({state:"unavailable",elapsedMs:null,endedAt:null});expect(await history(f)).toEqual(before);await expect(f.vote(p,"finance")).rejects.toThrow(/invalid_delegation/);expect(await history(f)).toEqual(before);
});
it("preserves the completed historical duration when approved authority later becomes stale",async()=>{
 const f=await businessFixture(),p=await f.propose();await f.vote(p);vi.setSystemTime(epoch+10_000);await f.vote(p,"finance");const completed=(await read(f,p.proposalId)).sample;expect(completed?.state).toBe("completed");
 await f.t.run(async ctx=>{const seat=(await ctx.db.query("seats").collect()).find(s=>s.seatId==="human-owner")!;await ctx.db.patch(seat._id,{status:"retired"});});vi.setSystemTime(epoch+20_000);const before=await history(f),r=await read(f,p.proposalId);expect(r.detail.domain?.approvalStatus).toBe("stale");expect(r.sample).toEqual(completed);expect(await history(f)).toEqual(before);
});
