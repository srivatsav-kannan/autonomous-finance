import {afterEach,expect,it,vi} from 'vitest';
import {makeFunctionReference} from 'convex/server';
import {headerFixture,partial} from './v13-tax-fixture';
import {taxBusinessFixture} from './tax-business-fixture';
import {cite} from './tax-fixture';
import {calculatedTax,taxProportion,recoverableCreditCents} from '../../src/ap-system/tax-policy';
import {readCostState} from '../../convex/lib/apSystem/costState';
import {resolveAPBusinessPaymentAuthority} from '../../convex/lib/apSystem/businessAuthority';
afterEach(()=>vi.unstubAllEnvs());
const net=(rows:any[],account:string)=>rows.flatMap(j=>j.lines).filter(l=>l.account===account).reduce((n,l)=>n+l.debit-l.credit,0);

it('posts two independently attributed header bases, rounds recovery per line, then reverses exact remaining shares',async()=>{
  const f=await headerFixture(),p=await f.propose(f.detail,f.a);await f.approve(p);
  const original=(await f.state()).journals[0]!;
  // Each accepted base is 510, each tax is 51, each half-recovery rounds to 26.
  expect([net([original],'5000'),net([original],'1180'),net([original],'2000')]).toEqual([1070,52,-1122]);
  const one=await f.credit(p.proposalId,0,'V13-HEADER-A');await f.approve(await one.propose());
  const afterOne=await f.state();expect([net(afterOne.journals,'5000'),net(afterOne.journals,'1180'),net(afterOne.journals,'2000')]).toEqual([535,26,-561]);
  const two=await f.credit(p.proposalId,1,'V13-HEADER-B');await f.approve(await two.propose());
  const done=await f.state();expect(done.journals).toHaveLength(3);expect(done.credits).toHaveLength(2);expect(done.commands).toHaveLength(0);
  expect([net(done.journals,'5000'),net(done.journals,'1180'),net(done.journals,'2000')]).toEqual([0,0,0]);expect(done.journals[0]).toEqual(original);
  expect(done.credits.map(c=>(c.plan as any).freightCents)).toEqual([20,30]);expect(done.credits.map(c=>(c.plan as any).discountCents)).toEqual([10,20]);
});

it.each(['original freight duplicated','accepted freight duplicated','discount not conserved','aggregate recovery substituted','quantity-only tax'] as const)('holds %s before recognizing a two-line tax obligation',async change=>{
  const f=await headerFixture(),a=structuredClone(f.a);
  if(change==='original freight duplicated')a.lines[1]!.headerAllocation!.originalFreightCents=200;
  if(change==='accepted freight duplicated')a.lines[1]!.headerAllocation!.acceptedFreightCents=50;
  if(change==='discount not conserved')a.lines[0]!.headerAllocation!.acceptedDiscountCents=0;
  if(change==='aggregate recovery substituted'){a.lines[1]!.tax!.recoverableCents=25;a.lines[1]!.allocations[1]!.amountCents=25;a.lines[1]!.allocations[0]!.amountCents=526;}
  if(change==='quantity-only tax'){a.lines[0]!.taxCents=55;a.lines[0]!.tax!.recoverableCents=28;a.lines[0]!.allocations[1]!.amountCents=28;a.lines[0]!.allocations[0]!.amountCents=527;}
  await expect(f.propose(f.detail,a)).rejects.toThrow();const s=await f.state();expect(s.journals).toHaveLength(0);expect(s.bills).toHaveLength(0);
});

it('cannot borrow an unused header share from a different original line for a credit',async()=>{
  const f=await headerFixture(),p=await f.propose(f.detail,f.a);await f.approve(p);
  const excess=await f.credit(p.proposalId,0,'V13-BORROW-HEADER',21,10,51);
  await expect(excess.propose()).rejects.toThrow(/tax_header_credit_capacity/);
  const s=await f.state();expect(s.credits).toHaveLength(0);expect(s.journals).toHaveLength(1);
});

it('keeps stated rate null through partial recognition and separate tax-only then merchandise reversal',async()=>{
  const f=await taxBusinessFixture({stated:true,recoveryBps:3700}),a=partial(f.a),p=await f.propose(f.detail,a);await f.approve(p);
  const original=(await f.state()).journals[0]!;
  expect([net([original],'5000'),net([original],'1180'),net([original],'2000')]).toEqual([4093,142,-4235]);
  const retained=await f.t.run(ctx=>ctx.db.get(p.proposalId as any)) as any;
  expect(retained.request.acceptance.lines[0].tax.rateBps).toBeNull();expect(retained.request.acceptance.lines[0].tax.facts).not.toHaveProperty('rate');
  const tax=await f.credit(p.proposalId,'V13-PARTIAL-TAX',0,1,'tax_adjustment');await f.approve(await tax.propose());
  const merch=await f.credit(p.proposalId,'V13-PARTIAL-RETURN',3850,384);await f.approve(await merch.propose());
  const s=await f.state();expect(s.credits.map(c=>c.allocations.filter((a:any)=>a.treatment==='tax').reduce((n:number,a:any)=>n+a.amountCents,0))).toEqual([0,142]);
  expect([net(s.journals,'5000'),net(s.journals,'1180'),net(s.journals,'2000')]).toEqual([0,0,0]);expect(s.journals[0]).toEqual(original);expect(s.commands).toHaveLength(0);
});

it('conserves original recovery after a one-cent tax-only credit and two cumulative merchandise credits',async()=>{
  const f=await taxBusinessFixture({recoveryBps:3700}),p=await f.propose(f.detail,f.a);await f.approve(p);
  for(const [key,n,t,b] of [['V13-CENT',0,1,'tax_adjustment'],['V13-HALF-A',3850,384,'quantity_return'],['V13-HALF-B',3850,385,'quantity_return']] as const){const c=await f.credit(p.proposalId,key,n,t,b);await f.approve(await c.propose());}
  const s=await f.state();expect(s.credits.map(c=>c.allocations.filter((a:any)=>a.treatment==='tax').reduce((n:number,a:any)=>n+a.amountCents,0))).toEqual([0,143,142]);
  expect([net(s.journals,'5000'),net(s.journals,'1180'),net(s.journals,'2000')]).toEqual([0,0,0]);
  const excess=await f.credit(p.proposalId,'V13-EXTRA-CENT',0,1,'tax_adjustment');await expect(excess.propose()).rejects.toThrow(/credit_exceeds_original/);
});

it.each(['invoice asserts eligibility','stale eligibility revision','eligibility quotation changed','tax facts from eligibility','tax citation wrong invoice','rate invented for stated claim'] as const)('rejects %s before posting',async change=>{
  const f=await taxBusinessFixture({stated:change==='rate invented for stated claim'}),a=structuredClone(f.a),t=a.lines[0]!.tax!;
  if(change==='invoice asserts eligibility')t.eligibilityEvidence=[t.facts.tax];
  if(change==='stale eligibility revision')t.eligibilityEvidence[0]!.source.revision++;
  if(change==='eligibility quotation changed')t.eligibilityEvidence[0]!.quote='All purchases eligible';
  if(change==='tax facts from eligibility')t.facts.tax={...t.facts.tax,source:t.eligibilityEvidence[0]!.source};
  if(change==='tax citation wrong invoice')t.facts.tax.source.sourceId='another-invoice-with-same-value';
  if(change==='rate invented for stated claim')t.rateBps=1000;
  await expect(f.propose(f.detail,a)).rejects.toThrow();expect((await f.state()).journals).toHaveLength(0);
});

it('requires a distinct current tax reviewer after financial votes and retains that requirement for payment',async()=>{
  const f=await taxBusinessFixture(),p=await f.propose(f.detail,f.a);expect(p.route.map((s:any)=>s.groupId)).toEqual(['owner','finance','tax-review']);
  await f.vote(p);await f.vote(p,'finance');expect((await f.state()).journals).toHaveLength(0);
  await expect(f.vote(p,'owner','V13-WRONG-TAX-GROUP')).rejects.toThrow();expect((await f.state()).journals).toHaveLength(0);
  const done=await f.vote(p,'second');expect((await f.state()).journals).toHaveLength(1);
  await f.t.run(async ctx=>{const seat=(await ctx.db.query('seats').collect()).find(s=>s.seatId==='human-second')!;await ctx.db.patch(seat._id,{status:'retired'});});
  await expect(f.t.run(ctx=>resolveAPBusinessPaymentAuthority(ctx,f.scope,[done.billId]))).rejects.toThrow(/inactive_approver/);expect((await f.state()).commands).toHaveLength(0);
});

it('rejects retained financial voter retirement before the separate final tax vote',async()=>{
  const f=await taxBusinessFixture(),p=await f.propose(f.detail,f.a);await f.vote(p);await f.vote(p,'finance');
  await f.t.run(async ctx=>{const seat=(await ctx.db.query('seats').collect()).find(s=>s.seatId==='human-finance')!;await ctx.db.patch(seat._id,{status:'retired'});});
  await expect(f.vote(p,'second')).rejects.toThrow(/inactive_approver/);expect((await f.state()).journals).toHaveLength(0);
});

it('atomically rechecks competing tax-only capacity and lets only the exact remainder follow the winning approval',async()=>{
  const f=await taxBusinessFixture({recoveryBps:3700}),p=await f.propose(f.detail,f.a);await f.approve(p);
  const proposals=[];
  for(const key of ['V13-CONCURRENT-A','V13-CONCURRENT-B']){const c=await f.credit(p.proposalId,key,0,501,'tax_adjustment');const prop=await c.propose();expect(prop.route.map((s:any)=>s.groupId)).toEqual(['owner','finance','tax-review']);await f.vote(prop);await f.vote(prop,'finance');proposals.push(prop);}
  // Credit adjustments require the financial variance stage before the distinct tax-review stage.
  const raced=await Promise.allSettled(proposals.map(prop=>f.vote(prop,'second')));expect(raced.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const won=await f.state();expect(won.credits).toHaveLength(1);expect(net(won.journals,'1180')).toBe(100);
  const remainder=await f.credit(p.proposalId,'V13-EXACT-REMAINDER',0,269,'tax_adjustment');await f.approve(await remainder.propose());
  const done=await f.state();expect(done.credits).toHaveLength(2);expect(net(done.journals,'1180')).toBe(0);expect(net(done.journals,'5000')).toBe(7700);expect(net(done.journals,'2000')).toBe(-7700);
});

it('keeps a partial tax receivable outside cost reclassification capacity even after a supplier tax credit',async()=>{
  const f=await taxBusinessFixture({recoveryBps:3700}),p=await f.propose(f.detail,f.a);await f.approve(p);
  const tax=await f.credit(p.proposalId,'V13-COST-TAX',0,501,'tax_adjustment');await f.approve(await tax.propose());
  const s=await f.state(),original=s.journals[0]!,cost=await f.t.run(ctx=>readCostState(ctx,f.scope,original._id));
  expect(net(s.journals,'1180')).toBe(100);expect(net(s.journals,'5000')).toBe(7869);
  for(const [fromAccount,toAccount] of [['1180','1200'],['5000','1180']])await expect(f.t.mutation(makeFunctionReference<'mutation'>('apClose:propose'),{...f.controller,input:{idempotencyKey:`V13-COST-${fromAccount}`,action:{kind:'adjustment',originalEntryId:original._id,fromAccount,toAccount,amountCents:100,store:'sf-hayes-valley',date:'2026-10-19',evidence:f.proof,reason:'Independent tax pool must remain separate'}}})).rejects.toThrow(/tax_correction_required/);
  expect(cost.originalEntryId).toBe(original._id);expect((await f.state()).journals).toHaveLength(2);
});

it('uses integer half-up tax and cumulative recovery without fractional-cent drift near safe integer boundaries',()=>{
  expect(calculatedTax(25,28,1000,'exclusive')).toBe(3);expect(calculatedTax(25,28,1000,'inclusive')).toBe(3);
  expect(taxProportion(9007199254740991,1,2)).toBe(4503599627370496);
  expect([recoverableCreditCents(7,3,0,0,1),recoverableCreditCents(7,3,1,0,3),recoverableCreditCents(7,3,4,2,3)]).toEqual([0,2,1]);
  expect(()=>recoverableCreditCents(7,3,7,3,1)).toThrow(/tax_credit_capacity/);
});

it('does not let a byte-identical relabeled invoice masquerade as separate eligibility evidence',async()=>{
  const f=await taxBusinessFixture(),input=structuredClone(f.input),a=structuredClone(f.a);
  const relabeled=structuredClone(input.documents[0]!);relabeled.kind='other';relabeled.sourceId='v13-same-invoice-relabeled-eligibility';relabeled.deliveryId='v13-renamed-delivery';relabeled.name='eligibility-copy.pdf';
  input.documents.push(relabeled);input.candidate!.sources.push({sourceId:relabeled.sourceId,revision:relabeled.revision,sha256:relabeled.sha256});
  input.explicitRevisionOf=f.detail.caseId;input.candidate!.revision=2;input.idempotencyKey='v13-relabel-primary';
  const updated=await f.reviewed(input);a.lines[0]!.tax!.eligibilityEvidence=[cite(relabeled,'10%')];
  a.lines[0]!.tax!.eligibilityRationale='The renamed invoice is the only claimed evidence for eligibility';
  await expect(f.propose(updated,a,'v13-alias-eligibility')).rejects.toThrow(/tax_eligibility_evidence/);
});
