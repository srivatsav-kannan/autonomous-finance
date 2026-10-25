import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {convexTest} from 'convex-test';
import {makeFunctionReference} from 'convex/server';
import schema from '../../convex/schema';
import {bootstrapSandbox,type BootstrapTransport} from '../../src/ap-system/sandbox-bootstrap';
const modules=import.meta.glob('../../convex/**/*.ts'),dirs:string[]=[],issuer='https://v6-independent.us.auth0.com/';
const input=():Record<string,string>=>({AP_SANDBOX_CONVEX_URL:'http://127.0.0.1:3252',AP_HUMAN_AUTH_ISSUER:issuer,AP_HUMAN_AUTH_AUDIENCE:'IndependentSyntheticClient0001',AP_BANK_SCOPE:JSON.stringify({organizationId:'v6-org',runId:'ap97-v6-independent',provider:'increase',environment:'sandbox',accountId:'account_v6'}),AP_SANDBOX_BENEFICIARY:JSON.stringify({vendor:'supplier-v6',externalAccountId:'external_account_v6',version:'v1'}),AP_SANDBOX_TRUSTED_CONTEXT:JSON.stringify({supplier:{supplierId:'supplier-v6',legalName:'Independent synthetic supplier'},coding:{account:'5000',store:null,department:null,project:null,treatment:'expense'}}),AP_BOOTSTRAP_DATE:'2026-10-25',AP_BOOTSTRAP_PERIODS:'["2026-10"]',AP_CONTROLLER_LIMIT_CENTS:'50000',AP_SANDBOX_ACTIVITY_SINCE:'2026-10-25T00:00:00.000Z'});
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){
 const root=await mkdtemp('/private/tmp/ap97-v6-bootstrap-');dirs.push(root);const config=path.join(root,'.convex/local/default');await mkdir(config,{recursive:true});await writeFile(path.join(config,'config.json'),JSON.stringify({ports:{cloud:3252,site:3253},deploymentName:'v6-independent',adminKey:'synthetic-deployment-key'}),{mode:0o600});
 const t=convexTest(schema,modules),env:Record<string,string>={},calls:string[]=[];let lose='',before=false;
 const remote:BootstrapTransport={instance:async()=> 'v6-independent',environment:async()=>({...env}),update:async values=>{calls.push('update');Object.assign(env,values);for(const[k,v]of Object.entries(values))vi.stubEnv(k,v);if(lose==='update'){lose='';throw Error('lost response');}},inspect:(secret,runId)=>t.query(makeFunctionReference<'query'>('apSandboxBootstrap:inspect'),{secret,runId}),mutate:async(name,args)=>{calls.push(name);if(lose===name&&before){lose='';throw Error('before commit');}const result=await t.mutation(makeFunctionReference<'mutation'>(name),args);if(lose===name){lose='';throw Error('lost response');}return result;}};
 const bind={...input(),AP_HUMAN_SUBJECTS:JSON.stringify([issuer+'|auth0|two',issuer+'|auth0|one'])},read=(name:string)=>readFile(path.join(root,'var/auth0-bootstrap',name),'utf8').then(JSON.parse);
 return{root,t,env,calls,remote,bind,read,run:(mode:'prepare'|'bind',e=input())=>bootstrapSandbox(mode,e,root,remote),lose:(name:string,b=false)=>{lose=name;before=b;}};
}
describe('V6 independent offline bootstrap authority',()=>{
 it('reconciles a lost environment-update reply without enrollment, even with explicit human subjects in prepare',async()=>{
  const f=await fixture();f.lose('update');await expect(f.run('prepare',f.bind)).rejects.toThrow('lost response');expect((await f.read('state.json')).prepared).toBe(false);
  await f.run('prepare',f.bind);expect(f.calls).toEqual(['update']);expect(await f.t.run(ctx=>ctx.db.query('seats').collect())).toEqual([]);expect((await f.read('gateway.json')).AP_HUMAN_SUBJECTS).toBe('[]');
  const state=await f.read('state.json'),gateway=await f.read('gateway.json');for(const role of ['admin','dispatch','evidence'])expect(JSON.stringify(gateway)).not.toContain(state.secrets[role]);expect(JSON.stringify(gateway)).not.toContain('synthetic-deployment-key');
 });
 it('binds an exact deduplicated subject set once and rejects issuer, run and subject drift without mutations',async()=>{
  const f=await fixture();await f.run('prepare');await f.run('bind',f.bind);const before=await f.read('state.json'),count=f.calls.length;
  await f.run('bind',{...f.bind,AP_HUMAN_SUBJECTS:JSON.stringify([issuer+'|auth0|one',issuer+'|auth0|two',issuer+'|auth0|one'])});expect(await f.read('state.json')).toEqual(before);expect(f.calls).toHaveLength(count);
  for(const override of [{AP_HUMAN_SUBJECTS:JSON.stringify([issuer+'|auth0|one'])},{AP_HUMAN_SUBJECTS:'["https://other.us.auth0.com/|auth0|one"]'},{AP_BANK_SCOPE:JSON.stringify({...JSON.parse(input().AP_BANK_SCOPE!),runId:'ap97-other'})}] as Record<string,string>[])await expect(f.run('bind',{...f.bind,...override})).rejects.toThrow();expect(f.calls).toHaveLength(count);
  const scope=JSON.parse(input().AP_BANK_SCOPE!);for(const subject of ['auth0|one','auth0|two'])expect(await f.t.withIdentity({issuer,subject,tokenIdentifier:issuer+'|'+subject}).query(makeFunctionReference<'query'>('apIdentity:workspaceAccess'),{scope})).toEqual({authorized:true});
  await expect(f.t.withIdentity({issuer,subject:'auth0|other',tokenIdentifier:issuer+'|auth0|other'}).query(makeFunctionReference<'query'>('apIdentity:workspaceAccess'),{scope})).rejects.toThrow();
 });
 it('does not repeat a successful create after lost reply, and refuses changed human-seat authority during recovery',async()=>{
  const f=await fixture();await f.run('prepare');f.lose('admin:createRun');await expect(f.run('bind',f.bind)).rejects.toThrow('lost response');
  await f.t.run(async ctx=>{const seat=(await ctx.db.query('seats').collect()).find(s=>s.kind==='human')!;await ctx.db.patch(seat._id,{status:'retired'});});
  await expect(f.run('bind',f.bind)).rejects.toThrow('bootstrap_existing_run_conflict');expect(f.calls.filter(x=>x==='admin:createRun')).toHaveLength(1);expect(f.calls).not.toContain('demoPayments:configure');expect((await f.read('gateway.json')).AP_HUMAN_SUBJECTS).toBe('[]');
 });
 it('fails closed on unknown create without observed run; recovers lost configure exactly once without new credentials',async()=>{
  const f=await fixture();await f.run('prepare');f.lose('admin:createRun',true);await expect(f.run('bind',f.bind)).rejects.toThrow('before commit');await expect(f.run('bind',f.bind)).rejects.toThrow('bootstrap_missing_previous_run');expect(f.calls.filter(x=>x==='admin:createRun')).toHaveLength(1);
  const g=await fixture();await g.run('prepare');g.lose('demoPayments:configure');await expect(g.run('bind',g.bind)).rejects.toThrow('lost response');const prior=await g.read('state.json');expect((await g.read('gateway.json')).AP_HUMAN_SUBJECTS).toBe('[]');await g.run('bind',g.bind);expect((await g.read('state.json')).secrets).toEqual(prior.secrets);expect(g.calls.filter(x=>x==='demoPayments:configure')).toHaveLength(1);expect(g.calls.filter(x=>x==='admin:createRun')).toHaveLength(1);
 });
 it('sends no deployment credential before exact instance verification and rejects a redirect without following it',async()=>{
  const f=await fixture(),calls:Array<{url:string;init:RequestInit}>=[];
  vi.stubGlobal('fetch',async(url:unknown,init:RequestInit)=>{calls.push({url:String(url),init});return new Response('different-instance');});
  await expect(bootstrapSandbox('prepare',input(),f.root)).rejects.toThrow('bootstrap_backend_identity_mismatch');expect(calls).toHaveLength(1);expect(calls[0]!.url).toBe('http://127.0.0.1:3252/instance_name');expect(new Headers(calls[0]!.init.headers).has('Authorization')).toBe(false);expect(calls[0]!.init.redirect).toBe('error');
  calls.length=0;vi.stubGlobal('fetch',async(url:unknown,init:RequestInit)=>{calls.push({url:String(url),init});return new Response('',{status:302,headers:{location:'https://other.invalid/exfil'}});});await expect(bootstrapSandbox('prepare',input(),f.root)).rejects.toThrow('bootstrap_backend_request_failed');expect(calls).toHaveLength(1);expect(calls[0]!.init.redirect).toBe('error');
 });
 it('actual launcher filters inherited admin, worker and human-token authority from gateway child configuration',async()=>{
  const f=await fixture();await f.run('prepare');const preload=path.join(f.root,'capture.mjs'),capture=path.join(f.root,'capture.json');
  await writeFile(preload,`import child from 'node:child_process';import{syncBuiltinESMExports}from'node:module';import{writeFileSync}from'node:fs';import{EventEmitter}from'node:events';child.spawn=(bin,args,options)=>{writeFileSync(${JSON.stringify(capture)},JSON.stringify({bin,args,env:options.env}));return Object.assign(new EventEmitter(),{kill(){}});};syncBuiltinESMExports();`);
  const repo=fileURLToPath(new URL('../..',import.meta.url));await promisify(execFile)(process.execPath,['--import',path.join(repo,'node_modules/tsx/dist/loader.mjs'),'--import',preload,path.join(repo,'scripts/ap-system/sandbox-bootstrap-env.ts'),'gateway'],{cwd:f.root,env:{...process.env,KERNEL_ADMIN_SECRET:'inherited-admin',AP_DISPATCH_SECRET:'inherited-dispatch',AP_EVIDENCE_SECRET:'inherited-evidence',AP_HUMAN_JWT:'inherited-human-token',INCREASE_SANDBOX_API_KEY:'inherited-bank-key',AP_SANDBOX_CONVEX_URL:'https://other.invalid',QBO_CLIENT_SECRET:'allowed-private-accounting-secret'},timeout:15000});
  const spawned=JSON.parse(await readFile(capture,'utf8'));for(const k of ['KERNEL_ADMIN_SECRET','AP_DISPATCH_SECRET','AP_EVIDENCE_SECRET','AP_HUMAN_JWT','INCREASE_SANDBOX_API_KEY'])expect(spawned.env[k]).toBe('');expect(spawned.env.AP_SANDBOX_CONVEX_URL).toBe('http://127.0.0.1:3252');expect(spawned.env.QBO_CLIENT_SECRET).toBe('allowed-private-accounting-secret');expect(spawned.env.NODE_OPTIONS).toBeUndefined();expect(spawned.args).toContain('scripts/ap-system/sandbox-server.ts');
 });
});
