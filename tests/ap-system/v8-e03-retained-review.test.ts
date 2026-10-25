import {createHash} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {makeFunctionReference} from 'convex/server';
import type {Id} from '../../convex/_generated/dataModel';
import {businessFixture,binding,policy,subject,cr,acceptance} from './business-fixture';
import {packet} from './accounting-fixture';
import {api} from '../demo-fixture';
import {currentSupplier} from '../../convex/lib/apSystem/businessAuthority';
import type {ContactChangeProposal} from '../../src/ap-system/supplier-contact-contracts';

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
// Upgrade-state probe: the original baseline F1 proves this review is reachable
// through public mutations. Seed only that retained pre-repair review here.
it('does not promote a pre-repair contradictory unavailable-channel verification into current authority',async()=>{
 const f=await fixture(),c=await f.proposeChange({...f.proposal,oldChannel:{...f.proposal.oldChannel,status:'unavailable'}});
 await f.t.run(async ctx=>{const id=c.changeId as Id<'apSupplierContactChanges'>,row=await ctx.db.get(id);await ctx.db.patch(id,{verification:{method:'old_channel_confirmation',performedAt:row!.createdAt,evidence:f.proof,mode:'simulated',reason:'Retained pre-repair confirmation',subject:subject('verifier'),seatId:'human-verifier',recordedAt:row!.createdAt}});});
 const before=await f.snapshot();await expect(f.escalate(c)).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
});

it('does not approve a complete but contradictory pre-repair contact review',async()=>{
 const f=await fixture(),c=await f.proposeChange({...f.proposal,oldChannel:{...f.proposal.oldChannel,status:'unavailable'}});
 await f.verify(c,'independent_reestablishment');await f.escalate(c);
 await f.t.run(async ctx=>{const id=c.changeId as Id<'apSupplierContactChanges'>,row=await ctx.db.get(id);await ctx.db.patch(id,{verification:{...row!.verification!,method:'old_channel_confirmation'}});});
 const before=await f.snapshot();await expect(f.decide(c)).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
});
it('does not reuse approved pre-repair contradictory review at future supplier authority gates',async()=>{
 const f=await fixture(),c=await f.replace();
 await f.t.run(async ctx=>{const id=c.changeId as Id<'apSupplierContactChanges'>,row=await ctx.db.get(id);await ctx.db.patch(id,{verification:{...row!.verification!,method:'old_channel_confirmation'}});});
 const before=await f.snapshot();await expect(f.onboard({...f.supplier,contactId:f.contact.contactId,expectedRevision:1},'v8-upgrade-new-supplier')).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
});
