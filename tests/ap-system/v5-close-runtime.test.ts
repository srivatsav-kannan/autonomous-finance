import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {ConvexHttpClient} from 'convex/browser';
import {makeFunctionReference} from 'convex/server';
import {businessFixture,binding} from './business-fixture';
import {createQBOCloseBridge} from '../../src/ap-system/quickbooks/close-runtime';
import {PrivateStore,hash} from '../../src/ap-system/quickbooks/private-store';
import {CALLBACK} from '../../src/ap-system/quickbooks/oauth';
import type {Mappings,Operation} from '../../src/ap-system/quickbooks/types';
const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();await Promise.all(dirs.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const mappings:Mappings={version:'v5x',realmId:'123',country:'US',apAccount:'2000',bankAccount:'1000',vendors:{'golden-state-produce':{id:'5',displayName:'Golden State Produce Co.'}},classes:{'sf-hayes-valley':{id:'9',name:'SF Hayes Valley'}},accounts:{'2000':{id:'2',name:'AP',type:'Accounts Payable'},'1000':{id:'1',name:'Bank',type:'Bank'},'2010':{id:'3',name:'Accrual',type:'Other Current Liability'},'5000':{id:'4',name:'Produce',type:'Expense'}}};
async function fixture(increase=false){
 const f=await businessFixture(),p=await f.t.mutation(makeFunctionReference<'mutation'>('apClose:propose'),{...f.controller,input:{idempotencyKey:'v5x-runtime-accrual',action:{kind:'accrual',accrual:{supplierId:f.supplier.supplierId,source:binding(f.input.documents[2]!),lineId:'receipt-line-1',sku:'KALE-24',unit:'case',description:'Two received cases',quantity:'2',capacityQuantity:'2',unitPriceCents:3850,allocations:structuredClone(f.input.candidate!.lines[0]!.allocations),date:'2026-10-19',expectedInvoiceCaseId:null,quote:f.input.documents[2]!.extractedText,reason:'Explicit received obligation'}}}});
 for(const who of ['owner','finance'])await f.humans[who]!.mutation(makeFunctionReference<'mutation'>('apClose:vote'),{scope:f.scope,input:{actionId:p.actionId,actionHash:p.actionHash,idempotencyKey:`v5x-${who}`,outcome:'approved',reason:'Independent actual original and amount review'}});
 const scope=increase?{...f.scope,provider:'increase' as const,environment:'sandbox' as const}:f.scope;
 if(increase)await f.t.run(async ctx=>{ // Explicit synthetic scope conversion only, no Increase API or bank verification.
  for(const table of ['demoConfigs','apCaseRecords','apCaseRevisions','apCaseSources','apCaseDeliveries','apCaseDecisions','apCaseOperations','apBusinessPolicies','apSupplierContacts','apSuppliers','apSupplierRevisions','apApprovalProposals','apCloseActions','apAccruals','apAccrualApplications'] as const)for(const row of await ctx.db.query(table).collect())await ctx.db.patch(row._id,{scope});
 });
 const dir=await mkdtemp('/private/tmp/ap97-v5x-runtime-');dirs.push(dir);const store=new PrivateStore(dir);await store.write('mappings.json',mappings);
 const env={QBO_CLIENT_ID:'synthetic-v5x-client',QBO_CLIENT_SECRET:'synthetic-v5x-secret',QBO_REALM_ID:'123',QBO_REDIRECT_URI:CALLBACK,QBO_ENVIRONMENT:'sandbox',QBO_PRIVATE_DIR:dir};
 return {...f,scope,store,dir,env,request:{actionId:p.actionId}};
}
describe('V5 independent request-owned period accounting runtime',()=>{
 it('uses current backend authority for readiness and preview and refuses a retired human without provider reads',async()=>{
  const f=await fixture(),fetcher=vi.fn(()=>{throw Error('No provider calls permitted');});vi.stubGlobal('fetch',fetcher);const bridge=createQBOCloseBridge(f.humans.finance as unknown as ConvexHttpClient,f.scope,f.env);
  const status=await bridge.status(f.request),preview=await bridge.preview(f.request);expect(status).toMatchObject({configuration:'configured',externalVerification:'not_checked',receipts:[],holds:[],externalWritesAllowed:false});expect(preview).toMatchObject({externalWrites:0,plan:{payload:{Line:[{Amount:77,JournalEntryLineDetail:{PostingType:'Debit',AccountRef:{value:'4'},ClassRef:{value:'9'}}},{Amount:77,JournalEntryLineDetail:{PostingType:'Credit',AccountRef:{value:'3'}}}]}}});expect(JSON.stringify([status,preview])).not.toMatch(/synthetic-v5x-secret|synthetic-v5x-client/);
  await f.t.run(async ctx=>{const seat=(await ctx.db.query('seats').collect()).find(s=>s.seatId==='human-finance')!;await ctx.db.patch(seat._id,{status:'retired'});});await expect(bridge.status(f.request)).rejects.toThrow();await expect(bridge.preview(f.request)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();expect((await readdir(f.dir)).filter(x=>x.startsWith('operation-'))).toEqual([]);
 });
 it('rejects an authenticated subject change at the last backend recheck before period journal POST',async()=>{
  const f=await fixture(true),posts:unknown[]=[],json=(x:unknown)=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
  await f.store.write('tokens.json',{realmId:'123',clientHash:hash(f.env.QBO_CLIENT_ID),access:'synthetic-v5x-access',refresh:'synthetic-v5x-refresh',accessUntil:Date.now()+3600000,refreshUntil:Date.now()+86400000,hardUntil:null,generation:1,blocked:false});
  const fetcher=vi.fn(async(input:RequestInfo|URL,init:RequestInit={})=>{const u=new URL(String(input)),id=u.pathname.split('/').at(-1)!;expect(u.origin).toBe('https://sandbox-quickbooks.api.intuit.com');if(init.method==='POST'){posts.push(init.body);throw Error('Unexpected provider POST');}if(u.pathname.includes('/companyinfo/'))return json({CompanyInfo:{Id:'123',Country:'US'}});if(u.pathname.includes('/vendor/'))return json({Vendor:{Id:'5',Active:true,DisplayName:'Golden State Produce Co.'}});if(u.pathname.includes('/class/'))return json({Class:{Id:'9',Active:true,Name:'SF Hayes Valley'}});if(u.pathname.includes('/account/')){const a=Object.values(mappings.accounts).find(x=>x.id===id)!;return json({Account:{Id:a.id,Active:true,Name:a.name,AccountType:a.type}});}if(id==='query')return json({QueryResponse:{}});throw Error('Unexpected route');});vi.stubGlobal('fetch',fetcher);
  let reads=0;const human={query:async(ref:any,args:any)=>{reads++;return f.humans[reads>=3?'owner':'finance']!.query(ref,args);}} as unknown as ConvexHttpClient,bridge=createQBOCloseBridge(human,f.scope,f.env),preview=await bridge.preview(f.request);if(preview.hold)throw Error(preview.hold.code);
  await expect(bridge.submit(f.request,preview.planHash)).rejects.toThrow('submission_identity_changed');expect(reads).toBe(3);expect(posts).toHaveLength(0);const files=(await readdir(f.dir)).filter(x=>x.startsWith('operation-'));expect(files).toHaveLength(1);const op=await f.store.read<Operation>(files[0]!);expect(op).toMatchObject({attempts:0,state:'prepared',lastError:'submission_identity_changed'});expect(op?.submissionAuthorization).toBeUndefined();
 });
});
