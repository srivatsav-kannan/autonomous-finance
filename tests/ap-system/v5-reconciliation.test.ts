import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {api} from '../demo-fixture';
import {businessFixture} from './business-fixture';
import {openFakeBank} from '../../src/integrations/banking/fake';
import {ExecutePaymentEffect} from '../../src/payments/application/execute-payment-effect';
import {ReconcilePaymentEvidence} from '../../src/payments/application/reconcile-payment-evidence';
import {createConvexPaymentKernel} from '../../src/payments/adapters/convex-payment-kernel';
import {createConvexPaymentEvidence} from '../../src/payments/adapters/convex-payment-evidence';
import type {KernelTransport} from '../../src/payments/adapters/convex-transport';
import type {Id} from '../../convex/_generated/dataModel';
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-31T20:00:00Z'));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe('V5 independent cancellation reconciliation boundary',()=>{
 it.each(['none','attempt','first_attempt','provider_id','linked_activity'] as const)('retains all command history and handles canceled marker %s',async marker=>{
  const f=await businessFixture(),recognized=await f.recognize();
  const request=(key:string)=>f.t.mutation(api.demoPayments.requestPayment,{scope:f.scope,seatId:'payments',token:'token-payments',requestKey:key,billIds:[recognized.billId as Id<'demoBills'>],billAmounts:[{billId:recognized.billId as Id<'demoBills'>,amountCents:1000}],credits:[]});
  const old=await request('v5x-old'),queued=await f.payer.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...old});await f.humans.finance!.mutation(api.demoPayments.cancel,{scope:f.scope,versionId:old.versionId});expect((await f.get(f.detail.caseId)).states.reconciliation).toBe('unmatched');
  const next=await request('v5x-next');await f.payer.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...next});
  const bank=openFakeBank({path:':memory:',scope:f.scope,seed:'v5x-reconciliation-'+marker,startTime:new Date().toISOString()});
  try{let n=0;const transport=f.t as unknown as KernelTransport,worker=new ExecutePaymentEffect(createConvexPaymentKernel(transport,f.scope,'test-dispatch'),bank.provider,'v5x',{now:Date.now,newLeaseToken:()=>`v5x-reconciliation-lease-${++n}`,startHeartbeat:()=>()=>{}}),evidence=new ReconcilePaymentEvidence(createConvexPaymentEvidence(transport,f.scope,'test-evidence'),bank.provider,f.scope,Date.now);await worker.tick();bank.harness.settle(bank.harness.inspect().transfers[0]!.id);await evidence.tick();await evidence.tick();expect((await f.get(f.detail.caseId)).states.reconciliation).toBe('matched');
   // Test-owned history probes model contradictory retained send/activity evidence; no actual old send is claimed.
   if(marker!=='none')await f.t.run(async ctx=>{const id=queued.commandId as Id<'demoCommands'>;if(marker==='attempt')await ctx.db.patch(id,{attemptCount:1});if(marker==='first_attempt')await ctx.db.patch(id,{firstAttemptAt:Date.now()});if(marker==='provider_id')await ctx.db.patch(id,{providerTransferId:'synthetic-old-transfer'});if(marker==='linked_activity'){const {_id,_creationTime,...row}=(await ctx.db.query('demoTransactions').collect())[0]!;await ctx.db.insert('demoTransactions',{...row,commandRowId:id,state:'exception',entryId:undefined,transaction:{...row.transaction,id:'synthetic-old-activity'}});}});
   const detail=await f.get(f.detail.caseId);expect(detail.states.reconciliation).toBe(marker==='none'?'matched':'unmatched');expect(detail.links.commandIds).toHaveLength(2);expect(bank.harness.inspect().transfers).toHaveLength(1);expect(await f.t.run(ctx=>ctx.db.query('journalEntries').collect())).toHaveLength(2);
  }finally{bank.close();}
 });
});
