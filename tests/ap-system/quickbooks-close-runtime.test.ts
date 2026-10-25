import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import type {ConvexHttpClient} from 'convex/browser';
import {makeFunctionReference} from 'convex/server';
import {businessFixture,binding} from './business-fixture';
import {createQBOCloseBridge} from '../../src/ap-system/quickbooks/close-runtime';
import {PrivateStore} from '../../src/ap-system/quickbooks/private-store';
import {CALLBACK} from '../../src/ap-system/quickbooks/oauth';
const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function setup(){
 const f=await businessFixture();
 const proposal=await f.t.mutation(makeFunctionReference<'mutation'>('apClose:propose'),{...f.controller,input:{idempotencyKey:'bridge-accrual',action:{kind:'accrual',accrual:{supplierId:f.supplier.supplierId,source:binding(f.input.documents[2]!),lineId:'receipt-line-1',sku:'KALE-24',unit:'case',description:'Unbilled receipt',quantity:'2',capacityQuantity:'2',unitPriceCents:3850,allocations:structuredClone(f.input.candidate!.lines[0]!.allocations),date:'2026-10-19',expectedInvoiceCaseId:null,quote:f.input.documents[2]!.extractedText,reason:'Retain actual receipt liability'}}}});
 for(const step of proposal.route){const who=step.groupId==='owner'?'owner':step.groupId==='govern'?'governor':'finance';await f.humans[who]!.mutation(makeFunctionReference<'mutation'>('apClose:vote'),{scope:f.scope,input:{actionId:proposal.actionId,actionHash:proposal.actionHash,idempotencyKey:`${proposal.actionId}-${who}`,outcome:'approved',reason:'Review exact source-backed accrual'}});}
 const request={actionId:proposal.actionId};return {...f,request};
}
const mappings={version:'fixture-v1',realmId:'123',country:'US',vendors:{'golden-state-produce':{id:'5',displayName:'Golden State'}},classes:{'sf-hayes-valley':{id:'9',name:'SF Hayes Valley'}},accounts:{'2000':{id:'33',name:'AP',type:'Accounts Payable'},'1000':{id:'35',name:'Bank',type:'Bank'},'2010':{id:'3',name:'Accrued liabilities',type:'Other Current Liability'},'5000':{id:'7',name:'Produce',type:'Expense'}},apAccount:'2000',bankAccount:'1000'};
it('checks current human close authority even when credentials are absent, with no provider calls',async()=>{
 const f=await setup(),fetcher=vi.fn(()=>{throw Error('Provider access forbidden');});vi.stubGlobal('fetch',fetcher);
 expect(await createQBOCloseBridge(f.humans.finance as unknown as ConvexHttpClient,f.scope,{}).status(f.request)).toMatchObject({configuration:'not_configured',externalWritesAllowed:false,grant:'authorization_required',receipts:[],externalVerification:'not_checked'});
 await expect(createQBOCloseBridge(f.t as unknown as ConvexHttpClient,f.scope,{}).status(f.request)).rejects.toThrow(/human/);
 expect(fetcher).not.toHaveBeenCalled();
});
it('derives preview from approved backend journal and rejects stale hashes and local external writes',async()=>{
 const f=await setup(),dir=await mkdtemp(join(tmpdir(),'qbo-close-runtime-'));dirs.push(dir);const store=new PrivateStore(dir);await store.write('mappings.json',mappings);
 const env={QBO_CLIENT_ID:'private-client',QBO_CLIENT_SECRET:'private-secret',QBO_REALM_ID:'123',QBO_REDIRECT_URI:CALLBACK,QBO_ENVIRONMENT:'sandbox',QBO_PRIVATE_DIR:dir};
 const bridge=createQBOCloseBridge(f.humans.finance as unknown as ConvexHttpClient,f.scope,env),fetcher=vi.fn(()=>{throw Error('Provider access forbidden');});vi.stubGlobal('fetch',fetcher);
 const preview=await bridge.preview(f.request);if(preview.hold)throw Error(preview.hold.code);
 expect(preview).toMatchObject({externalWrites:0,plan:{entity:'JournalEntry',payload:{Line:[{Amount:77,JournalEntryLineDetail:{PostingType:'Debit',ClassRef:{value:'9'},AccountRef:{value:'7'}}},{Amount:77,JournalEntryLineDetail:{PostingType:'Credit',AccountRef:{value:'3'}}}]}}});
 await expect(bridge.submit(f.request,'0'.repeat(64))).rejects.toThrow('preview_changed_before_write');
 await expect(bridge.submit(f.request,preview.planHash)).rejects.toThrow('increase_sandbox_export_required');
 await store.write('mappings.json',{...mappings,version:'fixture-v2'});await expect(bridge.submit(f.request,preview.planHash)).rejects.toThrow('preview_changed_before_write');
 await store.write('mappings.json',{...mappings,classes:{}});expect(await bridge.preview(f.request)).toMatchObject({externalWrites:0,hold:{code:'close_class_mapping_required'}});
 const status=await bridge.status(f.request);expect(status.holds).toHaveLength(1);expect(JSON.stringify(status)).not.toMatch(/private-client|private-secret/);
 await store.write('mappings.json',mappings);expect((await bridge.status(f.request)).holds).toEqual([]);
 expect((await readdir(dir)).filter(f=>f.startsWith('operation-'))).toEqual([]);expect(fetcher).not.toHaveBeenCalled();
});
