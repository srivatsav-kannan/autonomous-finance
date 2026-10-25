import {afterEach,describe,expect,it,vi} from 'vitest';
import {makeFunctionReference} from 'convex/server';
import {creditFixture} from './quickbooks-business-fixture';
import {br} from './business-fixture';
import {correctionAllocations} from '../../console/src/APSystemCorrections';
const read=makeFunctionReference<'query'>('apAccountingCorrections:creditApplication');
afterEach(()=>vi.unstubAllEnvs());
async function setup(){
 const f=await creditFixture(),a=await f.credit('V6-A'),b=await f.credit('V6-B');
 for(const [key,x,y]of [['v6-first',500,600],['v6-second',300,400]] as const){const d=(await f.load()).detail;await f.humans.finance!.mutation(br.applyCredits!,{scope:f.scope,caseId:d.caseId,expectedRevision:d.revision,snapshotHash:d.snapshotHash,billVersion:d.links.billVersion,idempotencyKey:key,reason:'Independent grouped credit application',credits:[{creditId:a.creditId,amountCents:x},{creditId:b.creditId,amountCents:y}]});}
 const rows=await f.t.run(ctx=>ctx.db.query('apCreditApplications').collect()),args={scope:f.scope,caseId:f.detail.caseId,creditApplicationId:rows[0]!._id};return{...f,a,b,rows,args,read:(extra={})=>f.humans.finance!.query(read,{...args,...extra})};
}
describe('V6 independent grouped credit and zero-cash boundary',()=>{
 it('groups only the immutable request key despite same bill, credits and date; selecting either component returns exact total',async()=>{
  const f=await setup(),before=await f.t.run(async ctx=>({commands:await ctx.db.query('demoCommands').collect(),journals:await ctx.db.query('journalEntries').collect(),credits:await ctx.db.query('demoCredits').collect(),authority:await ctx.db.query('apAccountingCorrections').collect()}));
  const groups=new Map<string,typeof f.rows>();for(const row of f.rows)groups.set(row.requestKey,[...(groups.get(row.requestKey)??[]),row]);expect(groups.size).toBe(2);
  const totals=[];for(const rows of groups.values()){const a=await f.read({creditApplicationId:rows[0]!._id}),b=await f.read({creditApplicationId:rows[1]!._id});expect(a).toEqual(b);expect(a.applicationIds).toEqual(rows.map(r=>r._id).sort());totals.push(a.amountCents);expect(a.credits.reduce((n:number,c:any)=>n+c.amountCents,0)).toBe(a.amountCents);}
  expect(totals.sort((a,b)=>a-b)).toEqual([700,1100]);expect(await f.t.run(async ctx=>({commands:await ctx.db.query('demoCommands').collect(),journals:await ctx.db.query('journalEntries').collect(),credits:await ctx.db.query('demoCredits').collect(),authority:await ctx.db.query('apAccountingCorrections').collect()}))).toEqual(before);expect(before.commands).toEqual([]);
 });
 it('rejects group member, zero-cash receipt and consumed-credit corruption rather than showing a trusted partial total',async()=>{
  const f=await setup(),row=f.rows[0]!,peer=f.rows.find(r=>r.requestKey===row.requestKey&&r._id!==row._id)!;
  await f.t.run(ctx=>ctx.db.patch(peer._id,{actor:'different-human'}));await expect(f.read()).rejects.toThrow('Invalid immutable credit application');await f.t.run(ctx=>ctx.db.patch(peer._id,{actor:peer.actor}));
  const receipt=await f.t.run(async ctx=>(await ctx.db.query('apCaseOperations').collect()).find(r=>r.key===`credit-application:${row.requestKey}`)!);await f.t.run(ctx=>ctx.db.patch(receipt._id,{result:{...receipt.result,cashCents:1}}));await expect(f.read()).rejects.toThrow('receipt mismatch');await f.t.run(ctx=>ctx.db.patch(receipt._id,{result:receipt.result}));
  const credit=await f.t.run(ctx=>ctx.db.get(row.creditId));await f.t.run(ctx=>ctx.db.patch(row.creditId,{consumedCents:row.amountCents-1}));await expect(f.read()).rejects.toThrow('Consumed same-supplier credit required');await f.t.run(ctx=>ctx.db.patch(row.creditId,{consumedCents:credit!.consumedCents}));expect((await f.read()).amountCents).toBe(1100);
 });
 it('rejects another bill/case, organization, funding account and retired human from actual query',async()=>{
  const f=await setup();await expect(f.read({caseId:f.a.caseId})).rejects.toThrow();for(const scope of [{...f.scope,organizationId:'other'},{...f.scope,accountId:'other'}])await expect(f.read({scope})).rejects.toThrow();await expect(f.t.query(read,f.args)).rejects.toThrow();
  await f.t.run(async ctx=>{const seat=(await ctx.db.query('seats').collect()).find(s=>s.seatId==='human-finance')!;await ctx.db.patch(seat._id,{status:'retired'});});await expect(f.read()).rejects.toThrow();
 });
 it('requires whole-group exact cents, preserving zero cash and rejecting component totals, negatives and overflow',()=>{
  expect(correctionAllocations({returned:'5.00'},600,1100)).toEqual({originalBillCents:600,restoredPayables:[{correctionId:'returned',amountCents:500}]});expect(correctionAllocations({returned:'11.00'},0,1100).originalBillCents).toBe(0);
  for(const [rows,original,gross]of [[{returned:'5.00'},100,1100],[{returned:'5.01'},600,1100],[{returned:'-1.00'},1200,1100],[{returned:'0'},1100,1100],[{returned:'0.001'},1100,1100],[{returned:'0.01'},Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER],[{},1100,0]] as [Record<string,string>,number,number][])expect(()=>correctionAllocations(rows,original,gross)).toThrow();
 });
});
