import {afterEach,expect,it} from 'vitest';
import {fixture,protocol,mappings,cleanup,operationRow,authorization} from './v12-settlement-fixture';
import {billPlan,creditPlan,paymentPlan,applicationPlan} from '../../src/ap-system/quickbooks/plans';
import {successful} from './quickbooks-business-fixture';
import {canonical,hash} from '../../src/ap-system/quickbooks/private-store';
import type {AccountingExport} from '../../src/ap-system/quickbooks/types';
afterEach(cleanup);

it('conserves 2750 returned cash across 850 zero-cash restored credit and 1900 replacement with exact external linked records',async()=>{
  const f=await fixture(),p=await f.pay(),wire=await protocol(f.load);
  const bill=await wire.submit({caseId:f.detail.caseId});
  const credit=await wire.submit({caseId:f.credit.caseId});
  const initial=await wire.submit(p.request);
  expect(initial.payload).toMatchObject({DepartmentRef:{value:'11'},TotalAmt:27.5,Line:[{Amount:41,LinkedTxn:[{TxnId:bill.externalId,TxnType:'Bill'}]},{Amount:13.5,LinkedTxn:[{TxnId:credit.externalId,TxnType:'VendorCredit'}]}]});
  await p.post(true);
  const returned=await f.correct({kind:'bank_return',paymentVersionId:p.versionId,returnTransactionId:p.returnTransactionId});
  const back=await wire.submit(returned.request);
  expect(back.payload.Line).toEqual([{Amount:27.5,DetailType:'JournalEntryLineDetail',JournalEntryLineDetail:{DepartmentRef:{value:'11'},PostingType:'Debit',AccountRef:{value:'35'}}},{Amount:27.5,DetailType:'JournalEntryLineDetail',JournalEntryLineDetail:{DepartmentRef:{value:'11'},PostingType:'Credit',AccountRef:{value:'33'},Entity:{Type:'Vendor',EntityRef:{value:'5'}}}}]);
  const applied=await f.apply();
  const zero=await f.correct({kind:'credit_allocation',creditApplicationId:applied.row._id,originalBillCents:0,restoredPayables:[{correctionId:returned.proposal.proposalId,amountCents:850}]});
  expect(await wire.dispatcher.checkHolds(zero.request)).toMatchObject([{code:'return_correction_sync_required'}]);
  expect(await wire.dispatcher.checkHolds(zero.request,{verify:true})).toEqual([]);
  const z=await wire.submit(zero.request);
  expect(z.payload).toMatchObject({DepartmentRef:{value:'11'},TotalAmt:0,Line:[{Amount:8.5,LinkedTxn:[{TxnId:back.externalId,TxnType:'JournalEntry'}]},{Amount:8.5,LinkedTxn:[{TxnId:credit.externalId,TxnType:'VendorCredit'}]}]});
  expect(await wire.client.journalAppliedCents(back,'5')).toBe(850);
  const replaced=await f.pay(1900,0);
  const allocation=await f.correct({kind:'payment_allocation',paymentVersionId:replaced.versionId,originalBillCents:0,restoredPayables:[{correctionId:returned.proposal.proposalId,amountCents:1900}]});
  const replacement=await wire.submit(allocation.request);
  expect(replacement.payload).toMatchObject({DepartmentRef:{value:'11'},TotalAmt:19,Line:[{Amount:19,LinkedTxn:[{TxnId:back.externalId,TxnType:'JournalEntry'}]}]});
  expect(await wire.client.journalAppliedCents(back,'5')).toBe(2750);
  const local=await f.t.run(async ctx=>({bill:await ctx.db.get(f.original.billId as any),credit:await ctx.db.get(f.credit.creditId),commands:await ctx.db.query('demoCommands').collect(),journals:await ctx.db.query('journalEntries').collect()}));
  expect(local.bill).toMatchObject({paidCents:4100});
  expect(local.bill).not.toHaveProperty('reservedVersionId');
  expect(local.credit).toMatchObject({consumedCents:2200,reservedCents:0});
  expect(local.commands).toHaveLength(2);
  expect(local.journals.filter(j=>j.source.kind==='payment_settlement')).toHaveLength(3);
  const before=wire.posts.map(p=>p.requestId);
  expect((await wire.submit(zero.request)).externalId).toBe(z.externalId);
  expect((await wire.submit(allocation.request)).externalId).toBe(replacement.externalId);
  expect(wire.posts.map(p=>p.requestId)).toEqual(before);
  expect(new Set(before).size).toBe(6);
  for(const post of wire.posts.filter(p=>p.entity==='BillPayment'))expect(JSON.parse(post.body)).not.toHaveProperty('ProcessBillPayment');
  const exact=structuredClone(operationRow(wire,z));operationRow(wire,z).Line[0].LinkedTxn[0].TxnId='999';
  expect(await wire.dispatcher.checkHolds(zero.request,{verify:true})).toMatchObject([{code:'restored_application_verification_required'}]);
  Object.assign(operationRow(wire,z),exact);
  expect(await wire.dispatcher.checkHolds(zero.request,{verify:true})).toEqual([]);
});

it.each(['null','legacy'] as const)('preserves exact accounting-only payload bytes for %s department without inferring header or line dimensions',async mode=>{
  const f=await fixture(mode),p=await f.pay(),e=await f.load(p.request);
  const b=successful(billPlan(e,mappings),'910'),c=successful(creditPlan(e.settlement!.credits![0]!.recognition,mappings,b),'911'),plan=paymentPlan(e,mappings,b,[c]);
  const expected={VendorRef:{value:'5'},APAccountRef:{value:'33'},CurrencyRef:{value:'USD'},TxnDate:'2026-10-25',DocNumber:`AP${hash(plan.identity).slice(0,18)}`,PrivateNote:`ap-sync:${hash(plan.identity)}; Increase settlement ${e.settlement!.bankTransactionId}`,PayType:'Check',CheckPayment:{BankAccountRef:{value:'35'},PrintStatus:'NotSet'},TotalAmt:27.5,Line:[{Amount:41,LinkedTxn:[{TxnId:'910',TxnType:'Bill'}]},{Amount:13.5,LinkedTxn:[{TxnId:'911',TxnType:'VendorCredit'}]}]};
  expect(canonical(plan.payload)).toBe(canonical(expected));
  if(mode==='null')expect(e.settlement!.accountingBinding!.department).toBeNull();else expect(e.settlement).not.toHaveProperty('accountingBinding');
  const wire=await protocol(f.load);const saved=await wire.journal.execute(plan,mappings,undefined,authorization(plan));
  expect(wire.posts[0]!.body).toBe(canonical(expected));expect(saved.state).toBe('succeeded');
});

it('retains the first authorizer, request bytes and identity while an accepted response is lost and subsequent searches are empty',async()=>{
  const f=await fixture(),p=await f.pay(),e=await f.load(p.request),b=successful(billPlan(e,mappings),'910'),c=successful(creditPlan(e.settlement!.credits![0]!.recognition,mappings,b),'911'),plan=paymentPlan(e,mappings,b,[c]),wire=await protocol(f.load);
  const first=authorization(plan);wire.state.loseNext=true;
  await expect(wire.journal.execute(plan,mappings,undefined,first)).rejects.toThrow('qbo_transport_unknown');
  const unknown=(await wire.journal.get(plan))!;expect(unknown.state).toBe('unknown');
  wire.state.hide=true;
  const absent=await wire.journal.execute(plan,mappings,undefined,{...first,subject:'later-independent-human'});
  expect(absent.state).toBe('unknown');expect(absent.requestId).toBe(unknown.requestId);expect(absent.submissionAuthorization).toEqual(first);expect(wire.posts).toHaveLength(1);
  wire.state.hide=false;
  const recovered=await wire.journal.execute(plan,mappings,undefined,{...first,subject:'later-independent-human'});
  expect(recovered.state).toBe('succeeded');expect(recovered.submissionAuthorization).toEqual(first);expect(recovered.requestId).toBe(unknown.requestId);expect(recovered.payloadHash).toBe(unknown.payloadHash);expect(recovered.attempts).toBe(1);expect(wire.posts).toHaveLength(1);
  expect(wire.posts[0]!.body).toBe(canonical(plan.payload));
});

it.each(['missing header','wrong header','extra line department','extra class','wrong linked bill','merchant processing'] as const)('refuses %s on ambiguous external settlement without retry or authorizer replacement',async change=>{
  const f=await fixture(),p=await f.pay(),e=await f.load(p.request),b=successful(billPlan(e,mappings),'910'),c=successful(creditPlan(e.settlement!.credits![0]!.recognition,mappings,b),'911'),plan=paymentPlan(e,mappings,b,[c]),wire=await protocol(f.load);
  const first=authorization(plan);wire.state.loseNext=true;await expect(wire.journal.execute(plan,mappings,undefined,first)).rejects.toThrow('qbo_transport_unknown');
  const unknown=(await wire.journal.get(plan))!,row=[...wire.rows.values()][0]!;
  if(change==='missing header')delete row.DepartmentRef;
  if(change==='wrong header')row.DepartmentRef={value:'12'};
  if(change==='extra line department')row.Line[0].DepartmentRef={value:'11'};
  if(change==='extra class')row.ClassRef={value:'9'};
  if(change==='wrong linked bill')row.Line[0].LinkedTxn[0].TxnId='999';
  if(change==='merchant processing')row.ProcessBillPayment=true;
  await expect(wire.journal.execute(plan,mappings,undefined,{...first,subject:'later-human'})).rejects.toThrow('external_mapping_conflict');
  const blocked=(await wire.journal.get(plan))!;expect(blocked.state).toBe('conflict');expect(blocked.requestId).toBe(unknown.requestId);expect(blocked.submissionAuthorization).toEqual(first);expect(blocked.payload).toEqual(plan.payload);expect(blocked.attempts).toBe(1);expect(wire.posts).toHaveLength(1);
});

it('rechecks the exact externally stored original bill department before submitting linked settlement',async()=>{
  const f=await fixture(),p=await f.pay(),wire=await protocol(f.load),b=await wire.submit({caseId:f.detail.caseId});await wire.submit({caseId:f.credit.caseId});
  const preview=await wire.dispatcher.run(p.request);expect(preview).toHaveProperty('plan');
  operationRow(wire,b).DepartmentRef={value:'12'};
  await expect(wire.dispatcher.run(p.request,'submit',{expectedPlanHash:hash((preview as any).plan)})).rejects.toThrow('external_stale_or_changed');
  expect(wire.posts).toHaveLength(2);
  const operation=(await wire.journal.get((preview as any).plan))!;expect(operation.attempts).toBe(0);expect(operation).not.toHaveProperty('submissionAuthorization');
});

it.each(['journal hash','command binding','journal extra dimension'] as const)('refuses authoritative settlement export after changed %s',async change=>{
  const f=await fixture(),p=await f.pay();expect((await f.load(p.request)).settlement!.amountCents).toBe(2750);
  await f.t.run(async ctx=>{
    if(change==='command binding'){const row=(await ctx.db.get(p.commandId))!;await ctx.db.patch(row._id,{command:{...row.command,accountingBindingHash:'f'.repeat(64)}});return;}
    const row=(await ctx.db.get(p.posted.entryId))!;
    if(change==='journal hash')await ctx.db.patch(row._id,{memo:row.memo+' changed'});
    else await ctx.db.patch(row._id,{lines:row.lines.map((l,i)=>i?l:{...l,dims:{...l.dims,project:'unauthorized-project'}})});
  });
  await expect(f.load(p.request)).rejects.toThrow();
});

it.each(['recognition approval','recognition authority','credit coverage','credit supplier'] as const)('rejects changed %s when mapping an authenticated export',async change=>{
  const f=await fixture(),p=await f.pay(),e=await f.load(p.request),b=successful(billPlan(e,mappings),'910'),c=successful(creditPlan(e.settlement!.credits![0]!.recognition,mappings,b),'911');
  const altered=structuredClone(e) as AccountingExport;
  if(change==='recognition approval')altered.recognizedInvoice!.approvalId='unrelated-approval';
  if(change==='recognition authority')altered.recognizedInvoice!.settlementAuthority!.policyHash='f'.repeat(64);
  if(change==='credit coverage')altered.settlement!.accountingBinding!.credits=[];
  if(change==='credit supplier')altered.settlement!.credits![0]!.recognition.supplierId='another-supplier';
  expect(()=>paymentPlan(altered,mappings,b,[c])).toThrow(/settlement_accounting_binding_invalid/);
});

it('does not release a returned-payment hold for changed return-journal dimensions or newly requested payment processing',async()=>{
  const f=await fixture(),p=await f.pay(),wire=await protocol(f.load);
  await wire.submit({caseId:f.detail.caseId});await wire.submit({caseId:f.credit.caseId});await wire.submit(p.request);await p.post(true);
  const returned=await f.correct({kind:'bank_return',paymentVersionId:p.versionId,returnTransactionId:p.returnTransactionId});
  const back=await wire.submit(returned.request),row=operationRow(wire,back),original=structuredClone(row);
  const request={caseId:f.detail.caseId};
  for(const change of ['missing AP location','changed bank location','unexpected header department','processing flag']){
    Object.keys(row).forEach(k=>delete row[k]);Object.assign(row,structuredClone(original));
    if(change==='missing AP location')delete row.Line[1].JournalEntryLineDetail.DepartmentRef;
    if(change==='changed bank location')row.Line[0].JournalEntryLineDetail.DepartmentRef={value:'12'};
    if(change==='unexpected header department')row.DepartmentRef={value:'11'};
    if(change==='processing flag')row.ProcessBillPayment=true;
    expect(await wire.dispatcher.checkHolds(request,{verify:true}),change).toMatchObject([{code:'return_correction_sync_required'}]);
  }
  Object.keys(row).forEach(k=>delete row[k]);Object.assign(row,original,{MetaData:{CreateTime:'synthetic'},domain:'QBO'});
  expect(await wire.dispatcher.checkHolds(request,{verify:true})).toEqual([]);expect(wire.posts).toHaveLength(4);
});

it('keeps generated dimension-bearing payment requests accounting-only in preparation and saved readback',async()=>{
  const f=await fixture(),p=await f.pay(),e=await f.load(p.request),b=successful(billPlan(e,mappings),'910'),c=successful(creditPlan(e.settlement!.credits![0]!.recognition,mappings,b),'911'),plan=paymentPlan(e,mappings,b,[c]);
  const bad={...plan,payload:{...plan.payload,ProcessBillPayment:true}},refused=await protocol(f.load);
  await expect(refused.journal.execute(bad,mappings,undefined,authorization(bad))).rejects.toThrow('merchant_processing_forbidden');expect(refused.posts).toHaveLength(0);
  const prepared=(await refused.journal.get(bad))!;expect(prepared.attempts).toBe(1);expect(prepared.state).toBe('rejected');
  const wire=await protocol(f.load),done=await wire.journal.execute(plan,mappings,undefined,authorization(plan));
  operationRow(wire,done).ProcessBillPayment=true;
  await expect(wire.journal.execute(plan,mappings)).rejects.toThrow('external_stale_or_changed');expect(wire.posts).toHaveLength(1);
});
