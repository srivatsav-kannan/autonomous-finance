import {afterEach,describe,expect,it,vi} from 'vitest';
import {readdir} from 'node:fs/promises';
import type {ConvexHttpClient} from 'convex/browser';
import {creditFixture,promoteIncrease} from './quickbooks-business-fixture';
import {restoredCreditFixture} from './quickbooks-restored-credit-fixture';
import {protocol,mappings} from './v5-qbo-fixture';
import {createQBOBridge} from '../../src/ap-system/quickbooks/runtime';
import {CALLBACK} from '../../src/ap-system/quickbooks/oauth';
import type {SyncHold} from '../../src/ap-system/quickbooks/types';
afterEach(()=>{vi.unstubAllGlobals();});
async function restored(){
 let h!:Awaited<ReturnType<typeof protocol>>;
 const f=await restoredCreditFixture(async(f,s,c)=>{h=await protocol(({caseId,...rest})=>s.load(caseId,rest));await h.submit({caseId:f.detail.caseId});await h.submit({caseId:c.caseId});await h.submit({caseId:f.detail.caseId,paymentVersionId:s.versionId});},2500);
 const base={caseId:f.detail.caseId},request={...base,creditApplicationId:f.application._id};
 await h.dispatcher.run(request,'submit');const je=await h.submit({...base,correctionId:f.returned.proposalId});return {f,h,base,request,je};
}
describe('V5 independent store dimensions and restored-credit evidence',()=>{
 it('preserves Class on both signed Bill and VendorCredit lines and detects changed or removed Classes',async()=>{
  const f=await creditFixture(100),c=await f.credit('V5-CLASS-CREDIT'),s=await promoteIncrease(f),h=await protocol(({caseId,...rest})=>s.load(caseId,rest));
  const bill=await h.submit({caseId:f.detail.caseId}),credit=await h.submit({caseId:c.caseId});expect(bill.payload.TotalAmt).toBe(76);expect(credit.payload.TotalAmt).toBe(38);
  for(const [op,amounts] of [[bill,[77,-1]],[credit,[38.5,-.5]]] as const){expect((op.payload.Line as any[]).map(l=>[l.Amount,l.AccountBasedExpenseLineDetail.ClassRef.value])).toEqual(amounts.map(a=>[a,'9']));const row=h.rows.get(`${op.entity}:${op.externalId}`),saved=structuredClone(row);row.Line[1].AccountBasedExpenseLineDetail.ClassRef.value='999';await expect(h.client.verify(op)).rejects.toThrow(/external_modified_conflict|external_stale_or_changed/);h.rows.set(`${op.entity}:${op.externalId}`,structuredClone(saved));delete h.rows.get(`${op.entity}:${op.externalId}`).Line[0].AccountBasedExpenseLineDetail.ClassRef;await expect(h.client.verify(op)).rejects.toThrow(/external_modified_conflict|external_stale_or_changed/);h.rows.set(`${op.entity}:${op.externalId}`,saved);}
  expect(h.posts).toHaveLength(2);expect(await h.journal.get(bill)).toEqual(bill);expect(await h.journal.get(credit)).toEqual(credit);
 });
 it('repairs current Class readiness without erasing held history and refuses changed mapping over an immutable successful receipt',async()=>{
  const f=await creditFixture(),s=await promoteIncrease(f),h=await protocol(({caseId,...rest})=>s.load(caseId,rest)),request={caseId:f.detail.caseId};const original=await h.submit(request),plan=await h.preview(request);await h.store.write('mappings.json',mappings);
  const blockedFetch=vi.fn(()=>{throw Error('Readiness must not contact provider');});vi.stubGlobal('fetch',blockedFetch);const bridge=createQBOBridge(f.humans.finance as unknown as ConvexHttpClient,s.scope,{QBO_CLIENT_ID:'v5-synthetic',QBO_CLIENT_SECRET:'v5-synthetic',QBO_REALM_ID:'123',QBO_REDIRECT_URI:CALLBACK,QBO_ENVIRONMENT:'sandbox',QBO_PRIVATE_DIR:h.path});
  await h.store.write('mappings.json',{...mappings,classes:{}});expect(await bridge.submit(request,'a'.repeat(64))).toMatchObject({hold:{code:'class_mapping_missing'}});const bad=await bridge.status(f.detail.caseId);expect(bad.holdHistory).toMatchObject([{current:true,state:'held'}]);const file=(await readdir(h.path)).find(x=>x.startsWith('hold-'))!,record=await h.store.read(file);
  await h.store.write('mappings.json',mappings);const fixed=await bridge.status(f.detail.caseId);expect(fixed.holds).toEqual([]);expect(fixed.holdHistory).toMatchObject([{current:false,state:'held'}]);expect(fixed.receipts).toMatchObject([{externalId:original.externalId,state:'succeeded'}]);expect(await h.store.read(file)).toEqual(record);expect(await h.journal.get(original)).toEqual(original);
  await h.store.write('mappings.json',{...mappings,classes:{'sf-hayes-valley':{id:'10',name:'Changed Class'}}});const changed=await bridge.preview(request);if(changed.hold)throw Error(changed.hold.code);await expect(bridge.submit(request,changed.planHash)).rejects.toThrow('immutable_operation_conflict');expect(await h.journal.get(original)).toEqual(original);expect(h.posts).toHaveLength(1);expect(blockedFetch).not.toHaveBeenCalled();expect(plan.payload.Line).toBeDefined();
 });
 it('releases only the exact restored-credit application hold after readback, with zero new local bank effects',async()=>{
  const {f,h,base,request,je}=await restored();expect(await h.dispatcher.checkHolds(base,{verify:true})).toEqual([]);const a=await f.proposeCorrection(f.allocationRequest);await f.voteCorrection(a);await f.voteCorrection(a,'finance');
  await h.journal.recordHold({...base,creditApplicationId:'unrelated-application'},{code:'restored_payable_allocation_required',owner:'controller',reason:'Different application remains unresolved',relatedIds:['unrelated-application']});
  const list=async()=>Promise.all((await readdir(h.path)).filter(n=>n.startsWith('hold-')).map(n=>h.store.read<SyncHold>(n)));const prior=(await list()).find(x=>x?.request.creditApplicationId===f.application._id)!;expect(prior.state).toBe('held');
  const op=await h.submit({...base,correctionId:a.proposalId});expect(op.payload).toMatchObject({TotalAmt:0,Line:[{Amount:5,LinkedTxn:[{TxnType:'Bill'}]},{Amount:20,LinkedTxn:[{TxnType:'JournalEntry',TxnId:je.externalId}]},{Amount:25,LinkedTxn:[{TxnType:'VendorCredit'}]}]});
  const calls=h.calls();expect(await h.dispatcher.checkHolds(request)).toEqual([]);expect(h.calls()).toBe(calls);expect((await list()).find(x=>x?.request.creditApplicationId===f.application._id)!.state).toBe('held');expect(await h.dispatcher.checkHolds(request,{verify:true})).toEqual([]);
  expect((await list()).find(x=>x?.request.creditApplicationId===f.application._id)).toMatchObject({state:'resolved',resolution:{corrections:[{correctionId:f.returned.proposalId,externalId:je.externalId},{correctionId:a.proposalId,externalId:op.externalId}]}});expect((await list()).find(x=>x?.request.creditApplicationId==='unrelated-application')!.state).toBe('held');expect((await h.submit(request)).requestId).toBe(op.requestId);expect(h.posts).toHaveLength(5);
  expect(await f.t.run(ctx=>ctx.db.query('journalEntries').collect())).toEqual(f.beforeApplication.journals);expect(await f.t.run(ctx=>ctx.db.query('demoCommands').collect())).toEqual(f.beforeApplication.commands);expect((await f.load()).detail.amounts.outstandingCents).toBe(5200);
  h.rows.get(`BillPayment:${op.externalId}`).Line[1].Amount=19;expect(await h.dispatcher.checkHolds(request,{verify:true})).toMatchObject([{code:'restored_application_verification_required'}]);expect(h.posts).toHaveLength(5);
 });
 it('does not certify a returned liability whose classless external journal gained an unauthorized Class',async()=>{
  const {h,base,je}=await restored();h.rows.get(`JournalEntry:${je.externalId}`).Line[1].JournalEntryLineDetail.ClassRef={value:'999'};
  expect(await h.dispatcher.checkHolds(base,{verify:true})).toMatchObject([{code:'return_correction_sync_required'}]);expect(h.posts).toHaveLength(4);
 });
});
