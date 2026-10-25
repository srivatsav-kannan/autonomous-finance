import {createHash} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {makeFunctionReference} from 'convex/server';
import type {Id} from '../../convex/_generated/dataModel';
import {businessFixture,binding,policy,subject,cr,acceptance} from './business-fixture';
import {packet} from './accounting-fixture';
import {api} from '../demo-fixture';
import {currentSupplier} from '../../convex/lib/apSystem/businessAuthority';
import type {ContactChangeProposal} from '../../src/ap-system/supplier-contact-contracts';
import {openFakeBank} from '../../src/integrations/banking/fake';
import {ExecutePaymentEffect} from '../../src/payments/application/execute-payment-effect';
import {ReconcilePaymentEvidence} from '../../src/payments/application/reconcile-payment-evidence';
import {createConvexPaymentKernel} from '../../src/payments/adapters/convex-payment-kernel';
import {createConvexPaymentEvidence} from '../../src/payments/adapters/convex-payment-evidence';
import type {KernelTransport} from '../../src/payments/adapters/convex-transport';

// Expectations are independently derived from E03 process semantics and the
// frozen payment contract. No live identity, phone call or provider is used.
const epoch=Date.parse('2026-10-25T12:00:00Z');
const ref=(name:string)=>makeFunctionReference<'mutation'>(`apSupplierContacts:${name}`);
const view=makeFunctionReference<'query'>('apSupplierContacts:view');
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(epoch);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function fixture(){
 const input=packet('V8-E03-INVOICE'),p=policy();
 p.groups.find(g=>g.groupId==='verify')!.members.push(subject('second'));
 p.groups.find(g=>g.groupId==='escalation')!.members.push(subject('delegate'));
 p.supplierContactEscalationGroup='escalation';
 const source=structuredClone(input.documents[1]!),body='Synthetic independently retained executed agreement: Golden State Produce successor contact +14155550888.';
 Object.assign(source,{sourceId:'v8-independent-contact',deliveryId:'v8-contact-delivery',name:'v8-contact.txt',kind:'contract',mimeType:'text/plain',extractedText:body,originalBase64:Buffer.from(body).toString('base64'),sha256:createHash('sha256').update(body).digest('hex'),byteLength:Buffer.byteLength(body)});
 input.documents.push(source);
 const f=await businessFixture({input,policy:p}),proof=[binding(source)];
 const contact=await f.humans.second!.mutation(cr.registerTrustedContact!,{scope:f.scope,idempotencyKey:'v8-source',supplierId:f.supplier.supplierId,phone:'+14155550888',evidence:proof,mode:'simulated',origin:{kind:'executed_agreement',acquiredAt:epoch-86400000,description:'Independent synthetic agreement; no real contact performed'}});
 const proposal:ContactChangeProposal={supplierId:f.supplier.supplierId,expectedRevision:1,oldContactId:f.supplier.contactId,newContactId:contact.contactId,resolution:'replace',oldChannel:{status:'available',evidence:f.proof,reason:'Old held contact remains available'},reason:'Independently test governed succession without changing bank destination'};
 const propose=(value=proposal,key='v8-propose')=>f.t.mutation(ref('propose'),{...f.controller,idempotencyKey:key,proposal:value});
 const verify=async(c:{changeId:string;hash:string},method='old_channel_confirmation',who='verifier',time?:number)=>{const row=await f.t.run(ctx=>ctx.db.get(c.changeId as Id<'apSupplierContactChanges'>));return f.humans[who]!.mutation(ref('verify'),{scope:f.scope,changeId:c.changeId,expectedHash:c.hash,attestation:{method,performedAt:time??row!.createdAt,evidence:proof,mode:'simulated',reason:'Independent synthetic verification'}});};
 const escalate=async(c:{changeId:string;hash:string},who='escalation',time?:number)=>{const row=await f.t.run(ctx=>ctx.db.get(c.changeId as Id<'apSupplierContactChanges'>));return f.humans[who]!.mutation(ref('escalate'),{scope:f.scope,changeId:c.changeId,expectedHash:c.hash,attestation:{method:'independent_reestablishment',performedAt:time??row!.createdAt,evidence:proof,mode:'simulated',reason:'Independent synthetic escalation'}});};
 const decide=(c:{changeId:string;hash:string},outcome='approved')=>f.humans.governor!.mutation(ref('decide'),{scope:f.scope,input:{changeId:c.changeId,expectedHash:c.hash,outcome,reason:'Independent exact-proposal decision'}});
 const snapshot=()=>f.t.run(async ctx=>({changes:await ctx.db.query('apSupplierContactChanges').collect(),suppliers:await ctx.db.query('apSuppliers').collect(),bills:await ctx.db.query('demoBills').collect(),versions:await ctx.db.query('demoVersions').collect(),commands:await ctx.db.query('demoCommands').collect(),journals:await ctx.db.query('journalEntries').collect()}));
 const request=(billId:string,key='v8-pay')=>f.t.mutation(api.demoPayments.requestPayment,{scope:f.scope,seatId:'payments',token:'token-payments',requestKey:key,billIds:[billId as Id<'demoBills'>],credits:[]});
 const active=()=>f.t.run(ctx=>currentSupplier(ctx,f.scope,f.supplier.supplierId));
 const replace=async()=>{const c=await propose({...proposal,oldChannel:{...proposal.oldChannel,status:'unavailable'}});await verify(c,'independent_reestablishment');await escalate(c);await decide(c);return c;};
 return {...f,proof,contact,proposal,proposeChange:propose,verify,escalate,decide,snapshot,request,active,replace};
}
async function retire(f:Awaited<ReturnType<typeof fixture>>,who:string){await f.t.run(async ctx=>{const s=(await ctx.db.query('seats').collect()).find(s=>s.seatId===`human-${who}`)!;await ctx.db.patch(s._id,{status:'retired'});});}
async function alias(f:Awaited<ReturnType<typeof fixture>>,who:string,seat:string){await f.t.run(async ctx=>{const c=(await ctx.db.query('demoConfigs').collect())[0]!;await ctx.db.patch(c._id,{humanSubjects:c.humanSubjects.map(h=>h.subject===subject(who)?{...h,seatId:`human-${seat}`}:h)});});}
function worker(f:Awaited<ReturnType<typeof fixture>>,bank:ReturnType<typeof openFakeBank>){let seq=0;return new ExecutePaymentEffect(createConvexPaymentKernel(f.t as unknown as KernelTransport,f.scope,'test-dispatch'),bank.provider,'v8-worker',{now:Date.now,newLeaseToken:()=>`v8-independent-worker-lease-${++seq}`,startHeartbeat:()=>()=>{}});}

describe('V8 independent E03 authority and recovery',()=>{
 it('rejects old-channel confirmation for a replacement explicitly declaring that channel unavailable',async()=>{
  const f=await fixture(),c=await f.proposeChange({...f.proposal,oldChannel:{...f.proposal.oldChannel,status:'unavailable'}}),before=await f.snapshot();
  await expect(f.verify(c,'old_channel_confirmation')).rejects.toThrow();
  expect(await f.snapshot()).toEqual(before);
 });
 it('requires the extra unavailable-channel review and rejects a subject alias for the existing verifier',async()=>{
  const f=await fixture(),c=await f.proposeChange({...f.proposal,oldChannel:{...f.proposal.oldChannel,status:'unavailable'}});
  await expect(f.escalate(c)).rejects.toThrow();await f.verify(c,'independent_reestablishment');
  await expect(f.decide(c)).rejects.toThrow();await alias(f,'delegate','verifier');const before=await f.snapshot();
  await expect(f.escalate(c,'delegate')).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
  await f.escalate(c);await f.decide(c);expect((await f.snapshot()).changes[0]!.status).toBe('approved');
 });
 it('keeps source recorder and verifier distinct even with different authenticated subject strings',async()=>{
  const f=await fixture(),c=await f.proposeChange();await alias(f,'verifier','second');const before=await f.snapshot();
  await expect(f.verify(c)).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
 });
 it.each(['second','verifier','escalation'])('rechecks retained current human %s at final approval without changing any financial state',async who=>{
  const f=await fixture(),c=await f.proposeChange({...f.proposal,oldChannel:{...f.proposal.oldChannel,status:'unavailable'}});
  await f.verify(c,'independent_reestablishment');await f.escalate(c);await retire(f,who);const before=await f.snapshot();
  await expect(f.decide(c)).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
 });
 it('rejects wrong scope, stale hash and a cross-supplier contact without replacing the existing hold',async()=>{
  const f=await fixture(),c=await f.proposeChange(),before=await f.snapshot();
  await expect(f.humans.verifier!.mutation(ref('verify'),{scope:{...f.scope,organizationId:'foreign'},changeId:c.changeId,expectedHash:c.hash,attestation:{method:'old_channel_confirmation',performedAt:epoch,evidence:f.proof,mode:'simulated',reason:'Wrong scope'}})).rejects.toThrow();
  await expect(f.verify({...c,hash:'f'.repeat(64)})).rejects.toThrow();
  const other=await f.humans.second!.mutation(cr.registerTrustedContact!,{scope:f.scope,idempotencyKey:'foreign-supplier-contact',supplierId:'another-supplier',phone:'+14155550888',evidence:f.proof,mode:'simulated',origin:{kind:'executed_agreement',acquiredAt:epoch,description:'Other supplier synthetic contact'}});
  await expect(f.proposeChange({...f.proposal,newContactId:other.contactId,supersedesChangeId:c.changeId},'v8-wrong-supplier')).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
 });
 it('rejects a retained contact whose source has moved outside scope, with proposal insertion rolled back',async()=>{
  const f=await fixture();await f.t.run(async ctx=>{const source=(await ctx.db.query('apCaseSources').collect()).find(s=>s.document.sourceId===f.proof[0]!.sourceId)!;await ctx.db.patch(source._id,{scope:{...source.scope,accountId:'another-account'}});});const before=await f.snapshot();
  await expect(f.proposeChange()).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
 });
 it('requires fresh reviews after policy supersession; old exact replay cannot authorize the new proposal',async()=>{
  const f=await fixture(),old=await f.proposeChange();await f.verify(old);
  const next=await f.t.mutation(cr.proposePolicy!,{...f.controller,idempotencyKey:'v8-policy',policy:{...f.policy,version:'v8-policy-2'}}),stored=await f.t.run(ctx=>ctx.db.get(next.policyId as Id<'apBusinessPolicies'>));await f.humans.governor!.mutation(cr.activatePolicy!,{scope:f.scope,policyId:next.policyId,expectedHash:stored!.hash,reason:'Independent policy supersession'});
  await expect(f.decide(old)).rejects.toThrow();const fresh=await f.proposeChange({...f.proposal,supersedesChangeId:old.changeId},'v8-fresh');
  await f.verify(old);await expect(f.decide(fresh)).rejects.toThrow();await f.verify(fresh);await f.decide(fresh);
  const state=await f.snapshot();expect(state.changes.map(c=>c.status)).toEqual(['superseded','approved']);expect(state.journals).toHaveLength(0);
 });
 it('uses the newly governed contact as the next proposal basis even before supplier recertification',async()=>{
  const f=await fixture();await f.replace();await expect(f.proposeChange(f.proposal,'v8-stale-old')).rejects.toThrow();
  const next=await f.proposeChange({...f.proposal,oldContactId:f.contact.contactId,newContactId:f.contact.contactId,resolution:'retain_current'},'v8-retain-new');await f.verify(next);await f.decide(next);
  await expect(f.active()).rejects.toThrow(/recertification/);await f.onboard({...f.supplier,expectedRevision:1,contactId:f.contact.contactId},'v8-recertify');expect((await f.active()).value.contactId).toBe(f.contact.contactId);
 });
 it('blocks authorization of a preexisting unapproved request while retaining its reservation and immutable snapshot',async()=>{
  const f=await fixture(),b=await f.recognize(),p=await f.request(b.billId),before=await f.snapshot();await f.proposeChange();
  await expect(f.payer.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...p})).rejects.toThrow();const after=await f.snapshot();expect(after.versions).toEqual(before.versions);expect(after.commands).toHaveLength(0);expect(after.journals).toEqual(before.journals);
 });
 it('holds a queued unsent payment without sending, then releases it only after fresh retain-current approval',async()=>{
  const f=await fixture(),b=await f.recognize(),p=await f.request(b.billId);await f.payer.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...p});const before=await f.snapshot(),c=await f.proposeChange();expect((await f.snapshot()).commands).toEqual(before.commands);
  const bank=openFakeBank({path:':memory:',scope:f.scope,seed:'v8-unsent',startTime:new Date(epoch).toISOString()});
  try{await worker(f,bank).tick();expect(bank.harness.inspect().transfers).toHaveLength(0);let state=await f.snapshot();expect(state.versions[0]).toMatchObject({reservations:'reserved',status:'queued'});expect(state.commands[0]).toMatchObject({attemptCount:0,execution:'exception'});
   await f.decide(c,'rejected');await expect(f.active()).rejects.toThrow(/review_pending/);const restore=await f.proposeChange({...f.proposal,resolution:'retain_current',newContactId:f.supplier.contactId,supersedesChangeId:c.changeId},'v8-restore');await expect(f.decide(restore)).rejects.toThrow();await f.verify(restore);await f.decide(restore);
   state=await f.snapshot();expect(state.versions[0]).toMatchObject({reservations:'released',status:'cancelled'});expect(state.commands[0]).toMatchObject({attemptCount:0,execution:'cancelled'});expect(state.journals).toEqual(before.journals);expect((await f.active()).value.externalAccountId).toBe('external-supplier-v1');
   const newPayment=await f.request(b.billId,'v8-restored-pay');expect(newPayment.versionId).not.toBe(p.versionId);expect(bank.harness.inspect().transfers).toHaveLength(0);
  }finally{bank.close();}
 });
 it('recovers an accepted lost-response transfer after contact replacement with exactly one original operation and settlement',async()=>{
  const f=await fixture(),b=await f.recognize(),p=await f.request(b.billId);await f.payer.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...p});
  const bank=openFakeBank({path:':memory:',scope:f.scope,seed:'v8-possible-send',startTime:new Date(epoch).toISOString(),faults:[{operation:'createTransfer',call:1,kind:'accept_then_lost_response'}]});
  try{const w=worker(f,bank),evidence=new ReconcilePaymentEvidence(createConvexPaymentEvidence(f.t as unknown as KernelTransport,f.scope,'test-evidence'),bank.provider,f.scope,Date.now);await w.tick();const before=await f.snapshot();expect(before.commands[0]).toMatchObject({attemptCount:1});expect(bank.harness.inspect().transfers).toHaveLength(1);
   await f.replace();let after=await f.snapshot();expect(after.commands).toEqual(before.commands);expect(after.versions).toEqual(before.versions);expect(after.bills).toEqual(before.bills);expect(after.journals).toEqual(before.journals);await expect(f.request(b.billId,'v8-no-replacement')).rejects.toThrow();
   vi.setSystemTime(epoch+15000);await w.tick();expect(bank.harness.inspect().transfers).toHaveLength(1);after=await f.snapshot();expect(after.commands[0]!.command).toEqual(before.commands[0]!.command);expect(after.versions[0]!.reservations).toBe('reserved');
   bank.harness.settle(bank.harness.inspect().transfers[0]!.id);const evidenceResult=await evidence.tick();const settled=await f.snapshot();expect(evidenceResult.errors).toEqual([]);expect(settled.bills[0]!.paidCents).toBe(7700);expect(settled.journals).toHaveLength(2);await evidence.tick();await w.tick();expect((await f.snapshot()).journals).toEqual(settled.journals);expect(bank.harness.inspect().transfers).toHaveLength(1);
  }finally{bank.close();}
 });
 it('requires both recovered old-channel confirmation and escalation when retain-current still declares prior unavailability',async()=>{
  const f=await fixture(),old=await f.proposeChange();await f.decide(old,'rejected');
  const restored=await f.proposeChange({...f.proposal,resolution:'retain_current',newContactId:f.supplier.contactId,supersedesChangeId:old.changeId,oldChannel:{...f.proposal.oldChannel,status:'unavailable'}},'v8-restored-unavailable');
  await expect(f.verify(restored,'independent_reestablishment')).rejects.toThrow();await f.verify(restored);await expect(f.decide(restored)).rejects.toThrow();await f.escalate(restored);await f.decide(restored);expect((await f.active()).value.contactId).toBe(f.supplier.contactId);
 });
 it('rechecks replacement source-recorder authority at future payment gates after supplier and case recertification',async()=>{
  const f=await fixture(),b=await f.recognize();await f.replace();await f.onboard({...f.supplier,expectedRevision:1,contactId:f.contact.contactId},'v8-new-contact-supplier');
  const recert=await f.propose(await f.get(f.detail.caseId),acceptance(f.input),'v8-case-recert',2);await f.vote(recert);await f.vote(recert,'finance');await retire(f,'second');const before=await f.snapshot();
  await expect(f.request(b.billId,'v8-after-retirement')).rejects.toThrow();expect(await f.snapshot()).toEqual(before);expect(before.changes[0]!.status).toBe('approved');expect(before.journals).toHaveLength(1);
 });

});
