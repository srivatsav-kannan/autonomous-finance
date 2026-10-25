import {afterEach,expect,it,vi} from 'vitest';
import {makeFunctionReference} from 'convex/server';
import {adjustmentFixture,taxRead} from './v13-adjustment-fixture';
import {refs} from './accounting-fixture';
import {cite} from './tax-fixture';
import type {TaxShare} from '../../src/ap-system/tax-adjustment-contracts';
const net=(rows:any[],account:string)=>rows.flatMap(j=>j.lines).filter(l=>l.account===account).reduce((n,l)=>n+l.debit-l.credit,0);
afterEach(()=>vi.unstubAllEnvs());

it('attributes only remaining embedded tax after prior tax consumption and cost reclassification, then reverses exact current buckets',async()=>{
  const f=await adjustmentFixture(3700),first=await f.credit(f.original.proposalId,'V13-ADJ-PRIOR',0,100,'tax_adjustment');await f.approve(await first.propose());
  const costAction=await f.t.mutation(f.close,{...f.controller,input:{idempotencyKey:'v13-prior-cost',action:{kind:'adjustment',originalEntryId:f.entry._id,fromAccount:'5000',toAccount:'1200',amountCents:8122,store:'sf-hayes-valley',date:'2026-10-19',evidence:f.proof,reason:'Independent remaining cost 8185 minus 63'}}});await f.approveTax(costAction);
  const before=await f.state();expect([net(before.journals,'1200'),net(before.journals,'1180'),net(before.journals,'2000')]).toEqual([8122,248,-8370]);
  await f.changePolicy(10000);
  const share:TaxShare={originalLineId:'line-1',allocationIndex:0,account:'1200',treatment:'inventory',store:'sf-hayes-valley',department:null,project:null,amountCents:422};
  const a=await f.action(670,[{from:share,toAccount:'1180',toTreatment:'tax'}],[share]),proposal=await f.proposeTax(a);
  expect(proposal.route.map((s:any)=>s.groupId)).toEqual(['owner','finance','tax-review']);
  await f.voteTax(proposal,'owner');await f.voteTax(proposal,'finance');expect((await f.state()).journals).toEqual(before.journals);
  const result=await f.voteTax(proposal,'second');expect(await f.approveTax(proposal)).toEqual(result);
  const adjusted=await f.state();expect(adjusted.journals.slice(0,3)).toEqual(before.journals);expect(adjusted.bills).toEqual(before.bills);expect(adjusted.commands).toHaveLength(0);
  expect([net(adjusted.journals,'1200'),net(adjusted.journals,'1180'),net(adjusted.journals,'2000')]).toEqual([7700,670,-8370]);
  for(const [i,tax] of [285,385].entries()){
    const c=await f.credit(f.original.proposalId,`V13-ADJ-RETURN-${i}`,3850,tax),s=await f.taxState();
    await expect(c.propose()).rejects.toThrow(/stale_tax_snapshot/);
    c.plan.taxReversal={snapshotHash:s.snapshotHash,allocations:i===0?[{...s.buckets.find(b=>b.allocationIndex===0)!,amountCents:285}]:s.buckets,reason:'Reverse only original remaining tax from exact current attribution'};
    c.plan.correction={snapshotHash:s.costSnapshotHash,allocations:[{originalLineId:'line-1',allocationIndex:0,account:'1200',treatment:'inventory',store:'sf-hayes-valley',department:null,project:null,side:'credit',amountCents:3850}],evidence:f.proof,reason:'Only merchandise cost follows its reviewed reclassification'};
    await f.approve(await c.propose());
  }
  const final=await f.state();expect([net(final.journals,'5000'),net(final.journals,'1200'),net(final.journals,'1180'),net(final.journals,'2000')]).toEqual([0,0,0,0]);expect((await f.taxState()).buckets).toEqual([]);expect(final.journals.slice(0,3)).toEqual(before.journals);
});

it('serializes a final tax-adjustment vote against a final supplier-credit vote without double consuming the shared state',async()=>{
  const f=await adjustmentFixture();await f.changePolicy(5000);const s=await f.taxState();
  const p=await f.proposeTax(await f.action(385,[{from:{...s.buckets[0]!,amountCents:385},toAccount:'5000',toTreatment:'expense'}]));
  const c=await f.credit(f.original.proposalId,'V13-ADJ-RACE',0,100,'tax_adjustment'),cp=await c.propose();
  await f.voteTax(p,'owner');await f.voteTax(p,'finance');await f.vote(cp);await f.vote(cp,'finance');
  const results=await Promise.allSettled([f.voteTax(p,'second'),f.vote(cp,'second')]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const rows=await f.state();expect(rows.journals).toHaveLength(2);expect(rows.commands).toHaveLength(0);
  const state=await f.taxState();expect(state.lines[0]!.remainingTaxCents).toBe(rows.credits.length?670:770);expect(state.buckets.reduce((n,b)=>n+b.amountCents,0)+state.lines[0]!.unattributedCostCents).toBe(state.lines[0]!.remainingTaxCents);
});

it('keeps cumulative recovery rounding anchored to the latest approved adjustment across separate one-cent credits',async()=>{
  const f=await adjustmentFixture();await f.changePolicy(3766);const s=await f.taxState();await f.approveTax(await f.proposeTax(await f.action(290,[{from:{...s.buckets[0]!,amountCents:480},toAccount:'5000',toTreatment:'expense'}])));
  const expected=[0,1,0,1,0];
  for(const [i,recovery] of expected.entries()){
    const state=await f.taxState(),c=await f.credit(f.original.proposalId,`V13-ADJ-CENT-${i}`,0,1,'tax_adjustment');
    const bucket=state.buckets.find(b=>recovery?b.treatment==='tax':b.treatment!=='tax')!;
    c.plan.taxReversal={snapshotHash:state.snapshotHash,allocations:[{...bucket,amountCents:1}],reason:'Independent cumulative 290/770 expected sequence 0,1,0,1,0'};await f.approve(await c.propose());
  }
  const end=await f.taxState();expect(end.lines[0]).toMatchObject({remainingTaxCents:765,creditBasisTaxCents:770,creditBasisRecoverableCents:290,creditedTaxCents:5,creditedRecoverableCents:2});
  const rows=await f.state();expect(net(rows.journals,'1180')).toBe(288);expect(net(rows.journals,'2000')).toBe(-8465);
});

it.each(['wrong approval','stale tax hash','stale cost hash','cash destination','wrong source coordinates','intermediate reuse'] as const)('rejects %s in a tax correction without changing AP, cash or prior journals',async change=>{
  const f=await adjustmentFixture();await f.changePolicy(5000);const s=await f.taxState(),a=await f.action(385,[{from:{...s.buckets[0]!,amountCents:385},toAccount:'5000',toTreatment:'expense'}]);
  if(change==='wrong approval')a.originalApprovalId='foreign-approval';if(change==='stale tax hash')a.taxSnapshotHash='f'.repeat(64);if(change==='stale cost hash')a.costSnapshotHash='f'.repeat(64);if(change==='cash destination')a.movements[0]!.toAccount='1000';if(change==='wrong source coordinates')a.movements[0]!.from.store=null;
  if(change==='intermediate reuse')a.movements.push({from:{...a.movements[0]!.from,account:'5000',treatment:'expense'},toAccount:'1200',toTreatment:'inventory'});
  const before=await f.state();await expect(f.proposeTax(a)).rejects.toThrow();expect(await f.state()).toEqual(before);
});

it('requires authenticated scoped tax state reads',async()=>{
  const f=await adjustmentFixture();await expect(f.t.query(taxRead,{scope:f.scope,originalEntryId:f.entry._id})).rejects.toThrow();
  await expect(f.humans.finance!.query(taxRead,{scope:{...f.scope,runId:'other-run'},originalEntryId:f.entry._id})).rejects.toThrow();expect((await f.taxState()).originalApprovalId).toBe(f.original.proposalId);
});

it('rejects byte-identical invoice material as adjustment eligibility even when separately stored as other',async()=>{
  const f=await adjustmentFixture(),input=structuredClone(f.input),copy=structuredClone(input.documents[0]!);copy.sourceId='v13-adjustment-invoice-alias';copy.deliveryId='v13-adjustment-alias-delivery';copy.kind='other';copy.name='support-copy.pdf';input.documents.push(copy);input.candidate!.sources.push({sourceId:copy.sourceId,revision:copy.revision,sha256:copy.sha256});input.idempotencyKey='v13-store-eligibility-alias';
  await f.t.mutation(refs.ingest,{...f.ap,input});await f.changePolicy(5000);const s=await f.taxState(),a=await f.action(385,[{from:{...s.buckets[0]!,amountCents:385},toAccount:'5000',toTreatment:'expense'}]);a.eligibilityEvidence=[cite(copy,'10%')];
  await expect(f.proposeTax(a)).rejects.toThrow(/tax_eligibility_evidence/);
});
