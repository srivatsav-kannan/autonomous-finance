import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {makeFunctionReference} from 'convex/server';
import {businessFixture,binding,br,syncPrimary,acceptance} from './business-fixture';
import {packet} from './accounting-fixture';
import {buildCostCorrection} from '../../console/src/APCostCorrection';
import {accountingAmountInput,paymentAmountInput} from '../../console/src/apSystemView';
import type {CostState,CostCorrection} from '../../src/ap-system/cost-contracts';
const costRef=makeFunctionReference<'query'>('apClose:costState'),proposeRef=makeFunctionReference<'mutation'>('apClose:propose'),voteRef=makeFunctionReference<'mutation'>('apClose:vote');
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-31T20:00:00Z'));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function setup(){
 const input=packet('V6-ORIGINAL'),c=input.candidate!;c.discountCents=100;c.discountAllocations=[{...c.lines[0]!.allocations[0]!,amountCents:100}];c.totalCents=7600;syncPrimary(input);
 const f=await businessFixture({input}),a=acceptance(input);a.discountCents=100;a.discountAllocations=structuredClone(c.discountAllocations);const recognized=await f.recognize(f.detail,a),proof=binding(input.documents[1]!);
 const p=await f.t.mutation(proposeRef,{...f.controller,input:{idempotencyKey:'v6-reclass',action:{kind:'adjustment',originalEntryId:recognized.entryId,date:'2026-10-31',fromAccount:'5000',toAccount:'1200',amountCents:4000,store:'sf-hayes-valley',evidence:[proof],reason:'Move exact cost to inventory'}}});
 for(const step of p.route)await f.humans[step.groupId==='owner'?'owner':'finance']!.mutation(voteRef,{scope:f.scope,input:{actionId:p.actionId,actionHash:p.actionHash,idempotencyKey:`v6-vote-${step.groupId}`,outcome:'approved',reason:'Independent classification review'}});
 const state=await f.humans.finance!.query(costRef,{scope:f.scope,originalEntryId:recognized.entryId}) as CostState;
 const credit=packet('V6-CREDIT'),cc=credit.candidate!;cc.kind='credit_note';credit.documents[0]!.kind='credit_note';cc.lines[0]!.quantity.decimal='1';cc.lines[0]!.amountCents=3850;cc.lines[0]!.allocations[0]!.amountCents=3850;cc.subtotalCents=3850;cc.discountCents=50;cc.discountAllocations=[{...cc.lines[0]!.allocations[0]!,amountCents:50}];cc.totalCents=3800;syncPrimary(credit);const d=await f.reviewed(credit);
 const propose=(correction:CostCorrection,accountingDate='2026-10-31')=>f.t.mutation(br.propose!,{...f.ap,input:{caseId:d.caseId,expectedRevision:d.revision,snapshotHash:d.snapshotHash,idempotencyKey:'v6-credit',policyVersion:f.policy.version,supplierRevision:1,accountingDate,credit:{originalCaseId:f.detail.caseId,originalApprovalId:recognized.proposal.proposalId,freightCents:0,discountCents:50,lines:[{creditLineId:'line-1',originalLineId:'line-1',basis:'price_adjustment',quantity:'0',netCents:3850,taxCents:0,returnEvidence:[]}],reason:'Independent exact half adjustment',correction}}});
 const gross=state.originalShares.findIndex(s=>s.originalLineId==='line-1'),discount=state.originalShares.findIndex(s=>s.originalLineId==='discount');
 const rows=(excess=0)=>[{share:gross,account:'5000',amount:((3650+excess)/100).toFixed(2)},{share:gross,account:'1200',amount:((200-excess)/100).toFixed(2)},{share:discount,account:'5000',amount:'0.50'}];
 const build=(excess=0)=>buildCostCorrection(state,rows(excess),f.policy,[proof],'Signed capacity independently calculated');
 const snapshot=()=>f.t.run(async ctx=>({journals:await ctx.db.query('journalEntries').collect(),bills:await ctx.db.query('demoBills').collect(),credits:await ctx.db.query('demoCredits').collect(),proposals:await ctx.db.query('apApprovalProposals').collect(),commands:await ctx.db.query('demoCommands').collect()}));
 return {...f,state,recognized,propose,build,snapshot};
}
describe('V6 independent signed cost and read authority boundaries',()=>{
 it('rejects UI readiness when net same-account reversals exceed the actual signed position by one cent',async()=>{
  const f=await setup();expect(Object.fromEntries(f.state.positions.map(p=>[p.account,p.balanceCents]))).toEqual({'5000':3600,'1200':4000});
  // Original shares still have 7700 credit and 100 debit available, but 3651 - 50 = 3601 exceeds 3600.
  expect(()=>f.build(1)).toThrow();
 });
 it('allows exact signed netting and posts only independently reviewed proportional credit shares',async()=>{
  const f=await setup(),plan=f.build();expect(plan.allocations.map(a=>[a.account,a.side,a.amountCents])).toEqual([['5000','credit',3650],['1200','credit',200],['5000','debit',50]]);
  const p=await f.propose(plan);await f.vote(p);await f.vote(p,'finance');const after=await f.humans.finance!.query(costRef,{scope:f.scope,originalEntryId:f.recognized.entryId}) as CostState;
  expect(Object.fromEntries(after.positions.map(p=>[p.account,p.balanceCents]))).toEqual({'5000':0,'1200':3800});expect((await f.snapshot()).commands).toHaveLength(0);
 });
 it('independently rejects a forged one-cent overdraw atomically at the actual backend',async()=>{
  const f=await setup(),plan=f.build(),before=await f.snapshot();plan.allocations[0]!.amountCents++;plan.allocations[1]!.amountCents--;
  await expect(f.propose(plan)).rejects.toThrow('cost_capacity_exceeded');expect(await f.snapshot()).toEqual(before);
 });
 it('requires an explicit later posting date for a credit issued before a cost correction',async()=>{
  const f=await setup(),before=await f.snapshot();await expect(f.propose(f.build(),'2026-10-19')).rejects.toThrow('cost_correction_date');expect(await f.snapshot()).toEqual(before);expect((await f.propose(f.build(),'2026-10-31')).proposalId).toBeTruthy();
 });
 it('keeps cost reads current-human and scope bound with no ledger or payment mutations',async()=>{
  const f=await setup(),args={scope:f.scope,originalEntryId:f.recognized.entryId},before=await f.snapshot();
  expect(await f.humans.finance!.query(costRef,args)).toEqual(f.state);
  await expect(f.t.query(costRef,args)).rejects.toThrow();
  await expect(f.t.withIdentity({issuer:'https://ap-demo.invalid',subject:'unconfigured',tokenIdentifier:'https://ap-demo.invalid|unconfigured'}).query(costRef,args)).rejects.toThrow();
  await expect(f.humans.finance!.query(costRef,{...args,scope:{...f.scope,runId:'another-run'}})).rejects.toThrow();
  expect(await f.snapshot()).toEqual(before);
  await f.t.run(async ctx=>{const seat=(await ctx.db.query('seats').collect()).find(s=>s.seatId==='human-finance')!;await ctx.db.patch(seat._id,{status:'retired'});});
  await expect(f.humans.finance!.query(costRef,args)).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
 });
 it('retains exact accounting parsing while payment amounts always require a real positive safe balance',()=>{
  expect(accountingAmountInput('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);expect(accountingAmountInput('0.00',true)).toBe(0);expect(accountingAmountInput('36.51')).toBe(3651);
  for(const value of ['',' ','0','00.10','1.001','1e3','+1','-0','1,000','90071992547409.92','Infinity','NaN'])expect(()=>accountingAmountInput(value)).toThrow();
  for(const balance of [null,0,-1,0.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity])for(const value of ['','0.01'])expect(()=>paymentAmountInput(value,balance)).toThrow();
  expect(paymentAmountInput('',3600)).toBe(3600);expect(paymentAmountInput('36.00',3600)).toBe(3600);expect(()=>paymentAmountInput('36.01',3600)).toThrow();
 });
});
