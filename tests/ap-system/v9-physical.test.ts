import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Id} from '../../convex/_generated/dataModel';
import {cr,br,acceptance,subject} from './business-fixture';
import {physicalFixture,physicalPacket,physicalView,physical,physicalRef,originalLines} from './v9-physical-fixture';
import {api} from '../demo-fixture';
const epoch=Date.parse('2026-10-31T20:00:00Z');beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(epoch);});afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});

it.each(['merged','resplit','reordered'] as const)('conserves original half-plus-one-and-half units across a %s parser representation while allowing both legitimate invoices',async style=>{
 const f=await physicalFixture(),m=await f.mapping(),cat=await f.approveMapping(m);await f.recognize(f.detail,f.accepted(f.input,m.reviewId,['north']));
 const input=physicalPacket(`V9-${style}`,style),d=await f.reviewed(input),next=await f.mapping(input,d,cat.catalogId);await f.approveMapping(next);await f.recognize(d,f.accepted(input,next.reviewId,['south']));
 const state=await f.snapshot();expect(state.bills.map(b=>b.approvedCents).sort((a,b)=>a!-b!)).toEqual([1925,5775]);expect(state.journals).toHaveLength(2);
 const capacities=(await f.humans.second!.query(physicalView,{scope:f.scope})).catalogs[0].capacities;expect(capacities).toEqual([{physicalLineId:'north',consumedQuantity:'0.5',accruedQuantity:'0',remainingQuantity:'0'},{physicalLineId:'south',consumedQuantity:'1.5',accruedQuantity:'0',remainingQuantity:'0'}]);
 const extra=physicalPacket(`V9-over-${style}`,style),ed=await f.reviewed(extra),em=await f.mapping(extra,ed,cat.catalogId);await f.approveMapping(em);const before=await f.snapshot();await expect(f.propose(ed,f.accepted(extra,em.reviewId,['north']))).rejects.toThrow(/received_units_already_used/);expect(await f.snapshot()).toEqual(before);
});
it('permits a reviewed split of a previously merged row without inheriting its prior consumed physical sibling',async()=>{
 const f=await physicalFixture(),input=physicalPacket('V9-initial-merged','merged'),d=await f.reviewed(input),m=await f.mapping(input,d),cat=await f.approveMapping(m);await f.recognize(d,f.accepted(input,m.reviewId,['south']));
 const split=physicalPacket('V9-split-again','resplit'),sd=await f.reviewed(split),sm=await f.mapping(split,sd,cat.catalogId);await f.approveMapping(sm);await f.recognize(sd,f.accepted(split,sm.reviewId,['north']));expect((await f.snapshot()).bills.reduce((n,b)=>n+b.approvedCents!,0)).toBe(7700);
});
it('rejects a second catalog from renamed identical bytes and refuses reassigning a partial merged claim to an unrelated physical row',async()=>{
 const f=await physicalFixture(),m=await f.mapping(),cat=await f.approveMapping(m),input=physicalPacket('V9-alias','merged'),d=await f.reviewed(input);await expect(f.mapping(input,d)).rejects.toThrow(/catalog_exists/);const map=await f.mapping(input,d,cat.catalogId);await f.approveMapping(map);
 const a=f.accepted(input,map.reviewId,['north']);a.lines[0]!.receipts[0]!.identity!.allocations=[{physicalLineId:'south',quantity:'0.75'}];await expect(f.propose(d,a)).rejects.toThrow(/claim_sum/);expect((await f.snapshot()).journals).toHaveLength(0);
});
it('rechecks a newly remapped reviewer seat at final business approval and a retired reviewer at payment request',async()=>{
 const f=await physicalFixture(),m=await f.mapping();await f.approveMapping(m);const proposal=await f.propose(f.detail,f.accepted(f.input,m.reviewId));await f.vote(proposal);
 await f.t.run(async ctx=>{const config=(await ctx.db.query('demoConfigs').collect())[0]!;await ctx.db.patch(config._id,{humanSubjects:config.humanSubjects.map(h=>h.subject===subject('second')?{...h,seatId:'human-delegate'}:h)});});const before=await f.snapshot();await expect(f.vote(proposal,'finance')).rejects.toThrow(/reviewer_changed/);expect(await f.snapshot()).toEqual(before);
 await f.t.run(async ctx=>{const config=(await ctx.db.query('demoConfigs').collect())[0]!;await ctx.db.patch(config._id,{humanSubjects:config.humanSubjects.map(h=>h.subject===subject('second')?{...h,seatId:'human-second'}:h)});});const approved=await f.vote(proposal,'finance');
 await f.t.run(async ctx=>{const seat=(await ctx.db.query('seats').collect()).find(s=>s.seatId==='human-second')!;await ctx.db.patch(seat._id,{status:'retired'});});await expect(f.t.mutation(api.demoPayments.requestPayment,{scope:f.scope,seatId:'payments',token:'token-payments',requestKey:'v9-payment',billIds:[approved.billId],credits:[]})).rejects.toThrow(/inactive_approver/);expect((await f.snapshot()).journals).toHaveLength(1);
});
it('rejects an accrual posted for another supplier against the first supplier physical receipt',async()=>{
 const f=await physicalFixture(),m=await f.mapping();await f.approveMapping(m);const other=await f.humans.verifier!.mutation(cr.registerTrustedContact!,{scope:f.scope,idempotencyKey:'v9-other-contact',supplierId:'other-supplier',phone:'+14155550777',evidence:f.proof,mode:'simulated'});await f.onboard({...f.supplier,supplierId:'other-supplier',legalName:'Other Supplier',contactId:other.contactId},'v9-other-supplier');
 const before=await f.snapshot();await expect(f.approveClose({kind:'accrual',accrual:{supplierId:'other-supplier',source:f.input.purchasingEvidence[1]!.source,lineId:f.input.purchasingEvidence[1]!.lines[0]!.lineId,sku:'KALE-24',unit:'case',description:'North receiving',quantity:'0.5',capacityQuantity:'0.5',unitPriceCents:3850,allocations:acceptance(f.input,'0.5').lines[0]!.allocations,date:'2026-10-31',expectedInvoiceCaseId:null,quote:originalLines[0]!,reason:'Must not change receipt supplier',identity:{reviewId:m.reviewId,physicalLineId:'north'}}})).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
});
it('requires the current case snapshot and source binding even if a different case approved the same original catalog',async()=>{
 const f=await physicalFixture(),m=await f.mapping(),cat=await f.approveMapping(m),input=physicalPacket('V9-another-case'),d=await f.reviewed(input);await expect(f.propose(d,f.accepted(input,m.reviewId))).rejects.toThrow(/review_stale/);const next=await f.mapping(input,d,cat.catalogId);await f.approveMapping(next);await f.recognize(d,f.accepted(input,next.reviewId));expect((await f.snapshot()).bills).toHaveLength(1);
});
it('requires a fresh same-case mapping after a parser revision and then permits recognition from the conserved catalog',async()=>{
 const f=await physicalFixture(),m=await f.mapping(),cat=await f.approveMapping(m),input=structuredClone(f.input);input.idempotencyKey='v9-explicit-parser-revision';input.explicitRevisionOf=f.detail.caseId;input.candidate!.revision=f.detail.revision+1;input.purchasingEvidence[1]!.lines.forEach(l=>l.lineId='renamed-'+l.lineId);const current=await f.reviewed(input);expect(current.revision).toBe(f.detail.revision+1);
 await expect(f.propose(current,f.accepted(input,m.reviewId),'v9-stale-mapping')).rejects.toThrow(/physical_review_stale/);const next=await f.mapping(input,current,cat.catalogId);await f.approveMapping(next);await f.recognize(current,f.accepted(input,next.reviewId));expect((await f.snapshot()).bills).toHaveLength(1);
});
it('requires fresh proposal approval after the identity-review policy changes',async()=>{
 const f=await physicalFixture(),m=await f.mapping(),proposed=await f.t.mutation(cr.proposePolicy!,{...f.controller,idempotencyKey:'v9-policy-new',policy:{...f.policy,version:'v9-next-policy'}}),row=await f.t.run(ctx=>ctx.db.get(proposed.policyId as Id<'apBusinessPolicies'>));await f.humans.governor!.mutation(cr.activatePolicy!,{scope:f.scope,policyId:proposed.policyId,expectedHash:row!.hash,reason:'Independent policy revision'});
 await expect(f.approveMapping(m)).rejects.toThrow(/physical_review_stale/);const next=await f.mapping();await f.approveMapping(next);expect((await f.snapshot()).catalogs).toHaveLength(1);
});
it('serializes two competing final human approvals for the same physical half-unit',async()=>{
 const f=await physicalFixture(),m=await f.mapping(),cat=await f.approveMapping(m),input=physicalPacket('V9-competing','merged'),d=await f.reviewed(input),next=await f.mapping(input,d,cat.catalogId);await f.approveMapping(next);const a=await f.propose(f.detail,f.accepted(f.input,m.reviewId,['north']),'v9-race-a'),b=await f.propose(d,f.accepted(input,next.reviewId,['north']),'v9-race-b');const results=await Promise.allSettled([f.vote(a),f.vote(b)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);const snapshot=await f.snapshot();expect(snapshot.bills).toHaveLength(1);expect(snapshot.bills[0]!.approvedCents).toBe(1925);expect(snapshot.journals).toHaveLength(1);
});
