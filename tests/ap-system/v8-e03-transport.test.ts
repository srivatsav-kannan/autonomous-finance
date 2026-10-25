import {afterEach,expect,it,vi} from 'vitest';
import {getFunctionName,makeFunctionReference} from 'convex/server';
import type {ConvexHttpClient} from 'convex/browser';
import type {AddressInfo} from 'node:net';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {businessFixture} from './business-fixture';
import {createAPSystemServer,APHttpError,type APWorkspaceService} from '../../src/ap-system/server';
import {createAPWorkspaceService} from '../../src/ap-system/service';
import {ContactReviewForm,ContactChangeRecord,contactChangeCurrent,buildContactProposal} from '../../console/src/APSystemContacts';
import {contactUIFixture,withContactUIEvidence} from '../ap-system-contact-ui.fixture';
import {apUIFixture} from '../ap-system-ui.fixture';
import type {GovernanceView} from '../../src/ap-system/domain-operations';
import raw from '../../docs/ap-orchestration/evidence/D2-browser/data.json';

const servers:ReturnType<typeof createAPSystemServer>[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
it('carries each request-bound synthetic identity through real HTTP/service/Convex-test contact mutations; no browser authority overrides',async()=>{
 const f=await businessFixture(),origin='http://127.0.0.1:5192';
 const calls:{actor:string;fn:string}[]=[];
 const service=(name:string)=>createAPWorkspaceService({agent:f.t as unknown as ConvexHttpClient,human:{query:async(ref:unknown,args:unknown)=>{calls.push({actor:name,fn:getFunctionName(ref as never)});return (f.humans[name]!.query as (ref:unknown,args:unknown)=>Promise<unknown>)(ref,args);},mutation:async(ref:unknown,args:unknown)=>{calls.push({actor:name,fn:getFunctionName(ref as never)});return (f.humans[name]!.mutation as (ref:unknown,args:unknown)=>Promise<unknown>)(ref,args);}} as unknown as ConvexHttpClient,scope:f.scope,apCredential:{seatId:'ap_clerk',token:'token-ap'},paymentsCredential:{seatId:'payments',token:'token-payments'},controllerCredential:{seatId:'controller',token:'token-controller'},parseUploads:async()=>{throw new Error('No provider allowed');},runtime:()=>({})});
 const server=createAPSystemServer({runtime:()=>({})} as APWorkspaceService,{port:0,runId:f.scope.runId,storageRoot:'/private/tmp',allowedOrigins:[origin],auth:{publicConfig:{mode:'auth0',domain:'synthetic.invalid',clientId:'synthetic-only'},authenticate:async token=>{if(!['owner','verifier','governor'].includes(token))throw new APHttpError('authentication_required',401,'Synthetic identity unavailable');return{subject:`synthetic|${token}`,issuer:'synthetic',approved:true,service:service(token)};}}});servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ap-system`;
 async function session(name:string){const r=await fetch(base+'/cases',{headers:{Authorization:`Bearer ${name}`}});expect(r.status).toBe(200);return{Authorization:`Bearer ${name}`,cookie:r.headers.get('set-cookie')!.split(';')[0]!,origin,'Content-Type':'application/json','X-AP-System-Session':'1'};}
 const owner=await session('owner'),verifier=await session('verifier'),governor=await session('governor');
 const post=(op:string,input:unknown,headers=owner)=>fetch(base+`/supplier-contacts/${op}`,{method:'POST',headers,body:JSON.stringify(input)});
 const result=await post('propose',{idempotencyKey:'v8-http',proposal:{supplierId:f.supplier.supplierId,expectedRevision:1,oldContactId:f.supplier.contactId,newContactId:f.supplier.contactId,resolution:'retain_current',oldChannel:{status:'available',evidence:f.proof,reason:'Synthetic old-channel recheck'},reason:'Independent HTTP restoration'}});expect(result.status).toBe(200);const c=await result.json() as {changeId:string;hash:string};
 const state=await f.humans.governor!.query(makeFunctionReference<'query'>('apSupplierContacts:view'),{scope:f.scope});
 const verify={changeId:c.changeId,expectedHash:c.hash,attestation:{method:'old_channel_confirmation',performedAt:state.changes[0].createdAt,evidence:f.proof,mode:'simulated',reason:'Synthetic independent verifier'}};
 expect((await post('verify',verify,owner)).ok).toBe(false);
 expect((await post('verify',{...verify,scope:{...f.scope,accountId:'foreign'}},verifier)).status).toBe(400);
 expect((await post('verify',verify,{...verifier,Authorization:'Bearer governor'})).status).toBe(403);
 const before=await f.t.run(ctx=>ctx.db.query('apSupplierContactChanges').first());expect(before!.verification).toBeUndefined();
 expect((await post('verify',verify,verifier)).status).toBe(200);
 const decision={changeId:c.changeId,expectedHash:c.hash,outcome:'approved',reason:'Independent synthetic final review'};
 expect((await post('decide',decision,verifier)).ok).toBe(false);expect((await post('decide',decision,governor)).status).toBe(200);expect((await post('decide',decision,governor)).status).toBe(200);
 const view=await fetch(base+'/supplier-contacts',{headers:governor}),text=await view.text();expect(view.status).toBe(200);expect(text).not.toMatch(/token-controller|token-ap|originalBase64|originalRef/);expect(JSON.parse(text).changes[0]).toMatchObject({status:'approved',verification:{subject:'https://ap-demo.invalid|verifier'},decision:{subject:'https://ap-demo.invalid|governor'}});
 expect(calls).toContainEqual({actor:'verifier',fn:'apSupplierContacts:verify'});expect(calls).toContainEqual({actor:'governor',fn:'apSupplierContacts:decide'});expect(await f.t.run(ctx=>ctx.db.query('journalEntries').collect())).toHaveLength(0);expect(await f.t.run(ctx=>ctx.db.query('demoCommands').collect())).toHaveLength(0);
});
it('presents the only allowed verification method for each immutable old-channel/resolution combination',()=>{
 const governance=raw.governance as unknown as GovernanceView,cases=withContactUIEvidence([apUIFixture()]),view=contactUIFixture(governance,cases);
 for(const unavailable of [false,true])for(const retain of [false,true]){
  const row=structuredClone(view.changes[0]!);row.proposal.oldChannel.status=unavailable?'unavailable':'available';row.proposal.resolution=retain?'retain_current':'replace';if(retain)row.proposal.newContactId=row.proposal.oldContactId;
  const html=renderToStaticMarkup(createElement(ContactReviewForm,{row,operation:'verify',cases,busy:false,save:async()=>true}));
  expect(html).toContain(`value="${unavailable&&!retain?'independent_reestablishment':'old_channel_confirmation'}"`);expect(html).not.toContain(`value="${unavailable&&!retain?'old_channel_confirmation':'independent_reestablishment'}"`);expect(html).not.toContain('checked=""');
 }
});
it('withholds review controls for stale contact/revision/policy state and cannot silently supersede a current proposal',()=>{
 const governance=raw.governance as unknown as GovernanceView,cases=withContactUIEvidence([apUIFixture()]),view=contactUIFixture(governance,cases),row=view.changes[0]!;
 for(const stale of [{...row,hash:row.hash,policyHash:(row.policyHash==='0'.repeat(64)?'1':'0').repeat(64)},{...row,supplierHash:(row.supplierHash==='0'.repeat(64)?'1':'0').repeat(64)},{...row,status:'superseded' as const}]){
  expect(contactChangeCurrent(stale,view,governance)).toBe(false);const html=renderToStaticMarkup(createElement(ContactChangeRecord,{row:stale,view,governance,cases,busy:false,save:async()=>true}));expect(html).not.toContain('Record independent verification');expect(html).not.toContain('Record final decision');
 }
 const draft={supplierId:view.suppliers[0]!.supplierId,resolution:'retain_current' as const,newContactId:'attempted-contact-override',oldStatus:'available' as const,evidence:cases[0]!.currentSourceBindings,oldReason:'Recovered original channel',reason:'Explicit restore',supersede:false};expect(()=>buildContactProposal(draft,view,governance)).toThrow();const restore=buildContactProposal({...draft,supersede:true},view,governance);expect(restore.newContactId).toBe(restore.oldContactId);expect(restore.supersedesChangeId).toBe(row.changeId);
});
