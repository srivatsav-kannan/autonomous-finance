import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {makeFunctionReference} from 'convex/server';
import {businessFixture,binding,br,syncPrimary,acceptance} from './business-fixture';
import {packet} from './accounting-fixture';
import type {CloseAction} from '../../src/ap-system/close-contracts';
import type {CostState,CostCorrection} from '../../src/ap-system/cost-contracts';
const proposeRef=makeFunctionReference<'mutation'>('apClose:propose'),voteRef=makeFunctionReference<'mutation'>('apClose:vote'),stateRef=makeFunctionReference<'query'>('apClose:costState'),exportRef=makeFunctionReference<'query'>('apBusinessExports:current');
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-31T20:00:00Z'));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function fixture(recognize=true){
 const f=await businessFixture(),original=recognize?await f.recognize():null,proof=binding(f.input.documents[1]!);let n=0;
 const state=(id=original!.entryId)=>f.humans.finance!.query(stateRef,{scope:f.scope,originalEntryId:id}) as Promise<CostState>;
 async function close(action:CloseAction){const p=await f.t.mutation(proposeRef,{...f.controller,input:{action,idempotencyKey:`v5x-${++n}`}});let r:any;for(const s of p.route)r=await f.humans[s.groupId==='owner'?'owner':s.groupId==='govern'?'governor':'finance']!.mutation(voteRef,{scope:f.scope,input:{actionId:p.actionId,actionHash:p.actionHash,idempotencyKey:`${p.actionId}-${s.groupId}`,outcome:'approved',reason:'Independent exact accounting review'}});return r;}
 const adjust=(id:string,amountCents:number,fromAccount='5000',toAccount='1200')=>close({kind:'adjustment',originalEntryId:id,date:'2026-10-31',fromAccount,toAccount,amountCents,store:'sf-hayes-valley',evidence:[proof],reason:'Reviewed original cost movement'});
 const correction=async(id:string,allocations:Array<[string,number]>,line='line-1'):Promise<CostCorrection>=>({snapshotHash:(await state(id)).snapshotHash,evidence:[proof],reason:'Original proportional cost with explicit current account shares',allocations:allocations.map(([account,amountCents])=>({originalLineId:line,allocationIndex:0,account,amountCents,side:'credit',store:'sf-hayes-valley',treatment:account==='5000'?'expense':account==='1300'?'prepayment':'inventory'}))});
 async function credit(){const input=packet(`V5X-CREDIT-${++n}`),c=input.candidate!;c.kind='credit_note';input.documents[0]!.kind='credit_note';c.lines[0]!.quantity.decimal='1';c.lines[0]!.amountCents=3850;c.lines[0]!.allocations[0]!.amountCents=3850;c.subtotalCents=3850;c.totalCents=3850;syncPrimary(input);const d=await f.reviewed(input);
  const propose=(plan?:CostCorrection)=>f.t.mutation(br.propose!,{...f.ap,input:{caseId:d.caseId,expectedRevision:d.revision,snapshotHash:d.snapshotHash,idempotencyKey:`v5x-credit-${++n}`,policyVersion:f.policy.version,supplierRevision:1,accountingDate:'2026-10-31',credit:{originalCaseId:f.detail.caseId,originalApprovalId:original!.proposal.proposalId,freightCents:0,discountCents:0,lines:[{creditLineId:'line-1',originalLineId:'line-1',basis:'price_adjustment',quantity:'0',netCents:3850,taxCents:0,returnEvidence:[]}],reason:'Supported explicit price correction',...(plan?{correction:plan}:{})}}});return {d,propose};
 }
 const positions=async(id=original!.entryId)=>Object.fromEntries((await state(id)).positions.filter(x=>x.balanceCents!==0).map(x=>[x.account,x.balanceCents]));
 return {...f,original,proof,state,close,adjust,correction,credit,positions};
}
describe('V5 independent corrected-cost extension',()=>{
 it('consumes two exact corrected credits through a multi-step cost chain without minting bill or cash effects',async()=>{
  const f=await fixture(),id=f.original!.entryId,before=await f.t.run(ctx=>ctx.db.get(id));
  await f.adjust(id,3000);await f.adjust(id,500,'1200','1300');expect(await f.positions()).toEqual({'5000':4700,'1200':2500,'1300':500});
  const a=await f.credit();await expect(a.propose()).rejects.toThrow('credit_classification_changed');const p=await a.propose(await f.correction(id,[['5000',850],['1200',2500],['1300',500]]));
  expect(p.route.map((x:any)=>x.groupId)).toEqual(['owner','finance']);await f.vote(p);const posted=await f.vote(p,'finance');expect(await f.vote(p,'finance')).toEqual(posted);expect(await f.positions()).toEqual({'5000':3850});
  const exp=await f.humans.finance!.query(exportRef,{scope:f.scope,caseId:a.d.caseId});expect(exp.recognized.allocations).toEqual([{account:'5000',amountCents:850,store:'sf-hayes-valley'},{account:'1200',amountCents:2500,store:'sf-hayes-valley'},{account:'1300',amountCents:500,store:'sf-hayes-valley'}]);
  const b=await f.credit();const q=await b.propose(await f.correction(id,[['5000',3850]]));await f.vote(q);await f.vote(q,'finance');expect(await f.positions()).toEqual({});expect(await f.t.run(ctx=>ctx.db.get(id))).toEqual(before);
  const rows=await f.t.run(async ctx=>({bills:await ctx.db.query('demoBills').collect(),journals:await ctx.db.query('journalEntries').collect(),commands:await ctx.db.query('demoCommands').collect()}));expect(rows.bills).toHaveLength(1);expect(rows.commands).toHaveLength(0);expect(rows.journals).toHaveLength(5);expect(rows.journals.flatMap(x=>x.lines).filter(x=>x.account==='2000').reduce((n,x)=>n+x.credit-x.debit,0)).toBe(0);
 });
 it('rejects pending corrected-credit authority after a one-cent round trip even when current balances return to identical values',async()=>{
  const f=await fixture(),id=f.original!.entryId;await f.adjust(id,3000);const c=await f.credit(),plan=await f.correction(id,[['1200',3000],['5000',850]]),p=await c.propose(plan);await f.vote(p);const before=await f.positions();
  await f.adjust(id,1);await f.adjust(id,1,'1200','5000');expect(await f.positions()).toEqual(before);expect((await f.state()).snapshotHash).not.toBe(plan.snapshotHash);await expect(f.vote(p,'finance')).rejects.toThrow('stale_cost_snapshot');
  expect(await f.t.run(ctx=>ctx.db.query('demoCredits').collect())).toHaveLength(0);const fresh=await c.propose(await f.correction(id,[['1200',3000],['5000',850]]));await f.vote(fresh);await f.vote(fresh,'finance');expect(await f.positions()).toEqual({'5000':3850});
 });
 it('recognizes the invoice after a split partial corrected accrual reversal without reusing original share capacity',async()=>{
  const f=await fixture(false),a=await f.close({kind:'accrual',accrual:{supplierId:f.supplier.supplierId,source:binding(f.input.documents[2]!),lineId:'receipt-line-1',sku:'KALE-24',unit:'case',description:'Two actual received cases',quantity:'2',capacityQuantity:'2',unitPriceCents:3850,allocations:structuredClone(f.input.candidate!.lines[0]!.allocations),date:'2026-10-31',expectedInvoiceCaseId:f.detail.caseId,quote:f.input.documents[2]!.extractedText,reason:'Source-backed accrued obligation'}}),id=a.entryId;
  await f.adjust(id,3000);await f.adjust(id,1000,'1200','1300');await f.close({kind:'reverse_accrual',accrualId:a.accrualId,quantity:'1',date:'2026-10-31',evidence:[f.proof],reason:'Explicit first half reversal',correction:await f.correction(id,[['5000',850],['1200',2000],['1300',1000]],'accrual')});expect(await f.positions(id)).toEqual({'5000':3850});
  const apply=(corr?:CostCorrection)=>f.t.mutation(br.propose!,{...f.ap,input:{caseId:f.detail.caseId,expectedRevision:f.detail.revision,snapshotHash:f.detail.snapshotHash,idempotencyKey:corr?'v5x-invoice-current':'v5x-invoice-no-plan',policyVersion:f.policy.version,supplierRevision:1,accountingDate:'2026-10-31',acceptance:acceptance(f.input),accrualApplications:[{accrualId:a.accrualId,quantity:'1',...(corr?{correction:corr}:{})}]}});
  await expect(apply()).rejects.toThrow('accrual_classification_changed');const p=await apply(await f.correction(id,[['5000',3850]],'accrual'));await f.vote(p);await f.vote(p,'finance');expect(await f.positions(id)).toEqual({});
  const rows=await f.t.run(async ctx=>({apps:await ctx.db.query('apAccrualApplications').collect(),journals:await ctx.db.query('journalEntries').collect(),commands:await ctx.db.query('demoCommands').collect()}));expect(rows.apps.map(x=>[x.amountCents,x.allocations.map((a:any)=>a.originalAllocationIndex)])).toEqual([[3850,[0,0,0]],[3850,[0]]]);expect(rows.journals).toHaveLength(6);expect(rows.commands).toHaveLength(0);
  const totals=(account:string)=>rows.journals.flatMap(x=>x.lines).filter(x=>x.account===account).reduce((n,x)=>n+x.debit-x.credit,0);expect([totals('5000'),totals('1200'),totals('1300'),totals('2000'),totals('2010')]).toEqual([7700,0,0,-7700,0]);
  await expect(f.close({kind:'reverse_accrual',accrualId:a.accrualId,quantity:'1',date:'2026-10-31',evidence:[f.proof],reason:'Cannot reverse consumed units'})).rejects.toThrow('reversal_excess');
 });
});
