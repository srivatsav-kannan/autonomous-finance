import {tmpdir} from 'node:os';
import {mkdtemp, rm} from 'node:fs/promises';
import {vi} from 'vitest';
import {makeFunctionReference} from 'convex/server';
import {api} from '../demo-fixture';
import {creditFixture, promoteIncrease} from './quickbooks-business-fixture';
import {br} from './business-fixture';
import {saveObservation, saveTransaction, postVerifiedTransaction} from '../../convex/lib/payments/applyObservation';
import {PAYMENT_EXECUTOR_VERSION, type TransferObservation, type BankTransaction} from '../../src/payments/contracts';
import type {Id} from '../../convex/_generated/dataModel';
import type {AccountingExport, ExportRequest, Mappings, Plan, Operation} from '../../src/ap-system/quickbooks/types';
import {QboClient} from '../../src/ap-system/quickbooks/client';
import {PrivateStore, hash} from '../../src/ap-system/quickbooks/private-store';
import {QuickBooksDispatcher, SyncJournal} from '../../src/ap-system/quickbooks/sync';
import type {OAuth} from '../../src/ap-system/quickbooks/oauth';
export const dirs: string[] = [];
export const cleanup = async () => {vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));};
export const mappings: Mappings = {version:'v12-independent-mapping',realmId:'123',country:'US',apAccount:'2000',bankAccount:'1000',vendors:{'golden-state-produce':{id:'5',displayName:'Golden State Produce Co.'}},accounts:{'2000':{id:'33',name:'AP',type:'Accounts Payable'},'1000':{id:'35',name:'Bank',type:'Bank'},'5000':{id:'7',name:'Produce',type:'Expense'},'5100':{id:'8',name:'Discount',type:'Expense'}},classes:{'sf-hayes-valley':{id:'9',name:'Hayes'}},dimensions:{version:'ap-qbo-dimensions-v1',policyId:'v12-explicit',reviewedBy:'synthetic-operator',reviewedAt:1,departmentAsLocation:{mode:'department_as_location',locations:{ops:{id:'11',name:'Operations'},sales:{id:'12',name:'Sales'}}}}};
const current = makeFunctionReference<'query'>('apAccountingExport:current');
const propose = makeFunctionReference<'mutation'>('apAccountingCorrections:propose');
const vote = makeFunctionReference<'mutation'>('apAccountingCorrections:vote');
export async function fixture(mode: 'bound'|'null'|'legacy' = 'bound') {
  const base = await creditFixture(0, mode==='legacy'?undefined:{department:mode==='null'?null:'ops',scope:'cost_and_settlement'});
  const credit = await base.credit();
  const f = {...base,...await promoteIncrease(base)};
  vi.stubEnv('AP_BANK_SCOPE',JSON.stringify(f.scope));
  let serial=0;
  const load = (request: ExportRequest) => f.humans.finance!.query(current,{scope:f.scope,...request}) as Promise<AccountingExport>;
  const exported = (extra: Record<string,string>={}) => load({caseId:f.detail.caseId,...extra});
  async function pay(gross=4100,applied=1350) {
    const suffix=`v12-${++serial}`;
    const request=await f.t.mutation(api.demoPayments.requestPayment,{scope:f.scope,seatId:'payments',token:'token-payments',requestKey:suffix,billIds:[f.original.billId as Id<'demoBills'>],billAmounts:[{billId:f.original.billId as Id<'demoBills'>,amountCents:gross}],credits:applied?[{creditId:credit.creditId,amountCents:applied}]:[]});
    const approved=await f.humans.finance!.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...request});
    const claim=await f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:'test-dispatch',paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:'v12-independent',leaseToken:`independent-lease-${suffix}`});
    if(!claim) throw Error('independent fixture expected a claim');
    const post=async(returning=false)=>{
      const row=(await f.t.run(ctx=>ctx.db.get(approved.commandId)))!;
      const c=row.command;
      const o:TransferObservation={id:`transfer-${suffix}`,scope:f.scope,commandId:c.commandId,requestHash:c.requestHash,idempotencyKey:c.idempotencyKey,amountCents:c.amountCents,currency:'USD',destination:c.destination,status:returning?'returned':'settled',createdAt:'2026-10-25T12:00:00Z',updatedAt:'2026-10-25T12:00:00Z',originalTransactionId:`debit-${suffix}`,...returning?{returnTransactionId:`return-${suffix}`}:{}};
      const t:BankTransaction={id:returning?`return-${suffix}`:`debit-${suffix}`,scope:f.scope,transferId:o.id,commandId:c.commandId,amountCents:returning?c.amountCents:-c.amountCents,currency:'USD',status:'posted',purpose:returning?'return':'debit',createdAt:o.createdAt,postedAt:o.updatedAt,...returning?{originalTransactionId:`debit-${suffix}`}:{}};
      await f.t.run(async ctx=>{await saveObservation(ctx,f.scope,o);await saveTransaction(ctx,f.scope,t);});
      return f.t.run(ctx=>postVerifiedTransaction(ctx,{scope:f.scope,token:'test-evidence',transactionId:t.id}));
    };
    const posted=await post();
    return {...request,...approved,post,posted,returnTransactionId:`return-${suffix}`,request:{caseId:f.detail.caseId,paymentVersionId:request.versionId}};
  }
  async function correct(input:Record<string,unknown>) {
    const p=await f.t.mutation(propose,{...f.controller,scope:f.scope,input:{caseId:f.detail.caseId,idempotencyKey:`v12-correction-${++serial}`,reason:'Independent exact original and restored principal check',...input}});
    for(const [i,step] of p.route.entries()) await f.humans[step.groupId==='govern'?'governor':step.groupId]!.mutation(vote,{scope:f.scope,input:{proposalId:p.proposalId,proposalHash:p.proposalHash,idempotencyKey:`v12-vote-${serial}-${i}`,outcome:'approved',reason:'Independent exact immutable dimensions'}});
    return {proposal:p,request:{caseId:f.detail.caseId,correctionId:p.proposalId}};
  }
  async function apply(amount=850) {
    const c=(await f.t.run(ctx=>ctx.db.get(f.detail.caseId as Id<'apCaseRecords'>)))!;
    const b=(await f.t.run(ctx=>ctx.db.get(f.original.billId as Id<'demoBills'>)))!;
    await f.humans.finance!.mutation(br.applyCredits!,{scope:f.scope,caseId:c._id,expectedRevision:c.currentRevision,snapshotHash:c.snapshotHash,billVersion:b.version,idempotencyKey:`v12-apply-${++serial}`,reason:'Independent zero-cash credit use',credits:[{creditId:credit.creditId,amountCents:amount}]});
    const row=await f.t.run(ctx=>ctx.db.query('apCreditApplications').order('desc').first());
    return {row:row!,request:{caseId:f.detail.caseId,creditApplicationId:row!._id}};
  }
  return {...f,credit,load,exported,pay,correct,apply};
}
/** No network transport: exact official-shaped reads/writes in an isolated ledger. */
export async function protocol(load: (r:ExportRequest)=>Promise<AccountingExport>, m:Mappings=mappings) {
  const root=await mkdtemp(`${tmpdir()}/ap97-v12-`);dirs.push(root);
  const rows=new Map<string,Record<string,any>>();
  const posts:Array<{entity:string,body:string,requestId:string|null}>=[];
  const state={loseNext:false,hide:false,tokenReads:0,extraReturned:null as null|((row:Record<string,any>)=>void)};
  const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'Content-Type':'application/json'}});
  const oauth={config:{realmId:'123'},access:async()=>{state.tokenReads++;return 'synthetic-only';},transport:async(input:URL,init:RequestInit={})=>{
    const u=new URL(String(input));if(u.origin!=='https://sandbox-quickbooks.api.intuit.com')throw Error('unexpected origin');
    const path=u.pathname.replace('/v3/company/123/','');
    if(path==='companyinfo/123')return json({CompanyInfo:{Id:'123',Country:'US'}});
    if(path==='preferences')return json({Preferences:{AccountingInfoPrefs:{TrackDepartments:true}}});
    for(const [name,entries] of [['Vendor',Object.values(m.vendors)],['Account',Object.values(m.accounts)],['Class',Object.values(m.classes??{})],['Department',Object.values(m.dimensions?.departmentAsLocation?.locations??{})]] as const){
      for(const v of entries) if(path===`${name.toLowerCase()}/${v.id}`)return json({[name]:{Id:v.id,Active:true,...'displayName'in v?{DisplayName:v.displayName}:{Name:v.name},...'type'in v?{AccountType:v.type}:{}}});
    }
    if(path==='query') {
      const q=u.searchParams.get('query')!,entity=q.match(/FROM (\w+)/)![1]!;
      const marker=q.match(/DocNumber = '([^']+)'/)?.[1];
      const selected=state.hide?[]:[...rows.entries()].filter(([key,r])=>key.startsWith(entity.toLowerCase()+'/')&&(marker?r.DocNumber===marker:r.VendorRef?.value==='5')).map(([,r])=>r);
      return json({QueryResponse:selected.length?{[entity]:selected}:{}});
    }
    if(init.method==='POST') {
      const entity=({bill:'Bill',billpayment:'BillPayment',vendorcredit:'VendorCredit',journalentry:'JournalEntry'} as Record<string,string>)[path];
      if(!entity) throw Error('unplanned mock POST');
      const body=String(init.body);posts.push({entity,body,requestId:u.searchParams.get('requestid')});
      const row={...JSON.parse(body),Id:String(900+posts.length),SyncToken:'0'};state.extraReturned?.(row);
      rows.set(`${path}/${row.Id}`,row);
      if(state.loseNext){state.loseNext=false;throw Error('Synthetic committed response loss');}
      return json({[entity]:row});
    }
    const row=rows.get(path);if(!row)throw Error(`unplanned mock GET ${path}`);
    const entity=({bill:'Bill',billpayment:'BillPayment',vendorcredit:'VendorCredit',journalentry:'JournalEntry'} as Record<string,string>)[path.split('/')[0]!]!;
    let consumed=0;
    for(const [key,payment] of rows) if(key.startsWith('billpayment/')) for(const line of payment.Line??[]) if(line.LinkedTxn?.some((l:any)=>l.TxnId===row.Id&&l.TxnType===entity))consumed+=line.Amount;
    return json({[entity]:{...row,...entity==='Bill'||entity==='VendorCredit'?{Balance:row.TotalAmt-consumed}:{}}});
  }} as unknown as OAuth;
  const client=new QboClient(oauth,async()=>{}),store=new PrivateStore(root),journal=new SyncJournal(store,client),dispatcher=new QuickBooksDispatcher(load,m,journal);
  async function submit(request:ExportRequest) {
    const preview=await dispatcher.run(request);if(!('plan'in preview)||!preview.plan)throw Error(`preview held: ${JSON.stringify(preview)}`);
    const result=await dispatcher.run(request,'submit',{expectedPlanHash:hash(preview.plan)});if(!('operation'in result)||!result.operation)throw Error(`submit held: ${JSON.stringify(result)}`);
    return result.operation;
  }
  return {root,rows,posts,state,client,store,journal,dispatcher,submit};
}
export const authorization=(p:Plan)=>({subject:'synthetic-v12-controller',planHash:hash(p),decidedAt:Date.now()});
export const operationRow=(wire:Awaited<ReturnType<typeof protocol>>,op:Operation)=>wire.rows.get(`${op.entity.toLowerCase()}/${op.externalId}`)!;
