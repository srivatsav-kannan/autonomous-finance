import {afterEach,expect,it,vi} from 'vitest';
import {api} from '../demo-fixture';
import {businessFixture} from './business-fixture';
import {openFakeBank} from '../../src/integrations/banking/fake';
import {ExecutePaymentEffect} from '../../src/payments/application/execute-payment-effect';
import {ReconcilePaymentEvidence} from '../../src/payments/application/reconcile-payment-evidence';
import {createConvexPaymentKernel} from '../../src/payments/adapters/convex-payment-kernel';
import {createConvexPaymentEvidence} from '../../src/payments/adapters/convex-payment-evidence';
import type {KernelTransport} from '../../src/payments/adapters/convex-transport';
import type {Id} from '../../convex/_generated/dataModel';
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
it('reconciles a replacement after an unattempted cancellation but retains any later activity on the old command',async()=>{
 vi.useFakeTimers();vi.setSystemTime(Date.parse('2026-10-25T12:00:00Z'));const f=await businessFixture(),recognized=await f.recognize();
 const prepare=(requestKey:string)=>f.t.mutation(api.demoPayments.requestPayment,{scope:f.scope,seatId:'payments',token:'token-payments',requestKey,billIds:[recognized.billId as Id<'demoBills'>],billAmounts:[{billId:recognized.billId as Id<'demoBills'>,amountCents:1000}],credits:[]});
 const first=await prepare('cancel-first');const old=await f.payer.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...first});await f.humans.finance!.mutation(api.demoPayments.cancel,{scope:f.scope,versionId:first.versionId});expect((await f.get(f.detail.caseId)).states.reconciliation).toBe('unmatched');
 const next=await prepare('replacement');await f.payer.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...next});
 const bank=openFakeBank({path:':memory:',scope:f.scope,seed:'reconciliation-replacement',startTime:new Date().toISOString()});
 try{let n=0;const transport=f.t as unknown as KernelTransport;const worker=new ExecutePaymentEffect(createConvexPaymentKernel(transport,f.scope,'test-dispatch'),bank.provider,'case-reconciliation',{now:Date.now,newLeaseToken:()=>`case-reconciliation-lease-${++n}`,startHeartbeat:()=>()=>{}});const evidence=new ReconcilePaymentEvidence(createConvexPaymentEvidence(transport,f.scope,'test-evidence'),bank.provider,f.scope,Date.now);await worker.tick();bank.harness.settle(bank.harness.inspect().transfers[0]!.id);await evidence.tick();await evidence.tick();
  const d=await f.get(f.detail.caseId);expect(d.states).toMatchObject({execution:'settled',reconciliation:'matched'});expect(d.links.commandIds).toHaveLength(2);expect(d.journals).toHaveLength(2);expect(bank.harness.inspect().transfers).toHaveLength(1);
  // Simulate unexpected late provider evidence on the canceled command: it cannot be hidden.
  await f.t.run(async ctx=>{const row=(await ctx.db.query('demoTransactions').collect())[0]!;const {_id,_creationTime,...copy}=row;await ctx.db.insert('demoTransactions',{...copy,commandRowId:old.commandId,entryId:undefined,state:'exception',transaction:{...copy.transaction,id:'unexpected-late-canceled-debit'}});});
  expect((await f.get(f.detail.caseId)).states.reconciliation).toBe('unmatched');
 }finally{bank.close();}
});
