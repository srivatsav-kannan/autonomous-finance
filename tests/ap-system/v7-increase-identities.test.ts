import {createHmac} from 'node:crypto';
import {it,expect,vi} from 'vitest';
import {IncreaseSandboxBank,verifyIncreaseWebhook} from '../../src/integrations/banking/increase';
import {IncreaseSandboxHarness} from '../../scripts/testing/increase-sandbox-harness';
import {buildIncreaseRequestBody,commandRequestHash,type BankCommand,type BankScope} from '../../src/integrations/contracts';
import fixtures from '../../src/integrations/fixtures/increase/lifecycle.json';
const scope:BankScope={organizationId:'v7-independent',runId:'v7-independent',provider:'increase',environment:'sandbox',accountId:'sandbox_account_same'};
async function setup(){
 const saved:BankCommand={scope,commandId:'cmd_demo',amountCents:2500,currency:'USD',destination:{externalAccountId:'sandbox_external_account_same',version:'v1'},approvalVersion:'human-v1',idempotencyKey:'v7-original-key',requestHash:''};
 saved.providerRequest=buildIncreaseRequestBody(saved);saved.requestHash=await commandRequestHash(saved);
 const transfer={...fixtures.returned,id:'sandbox_ach_transfer_same',account_id:scope.accountId,external_account_id:saved.destination.externalAccountId,idempotency_key:saved.idempotencyKey,transaction_id:'sandbox_transaction_debit',return:{...fixtures.returned.return,transaction_id:'sandbox_transaction_return',transfer_id:'sandbox_ach_transfer_same'}};
 const debit={...fixtures.debit,id:'sandbox_transaction_debit',account_id:scope.accountId,source:{category:'ach_transfer_intention',ach_transfer_intention:{transfer_id:transfer.id}}};
 const credit={...fixtures.credit,id:'sandbox_transaction_return',account_id:scope.accountId,source:{category:'ach_transfer_return',ach_transfer_return:{transfer_id:transfer.id}}};
 const rows:Record<string,unknown>={[`/ach_transfers/${transfer.id}`]:transfer,[`/transactions/${debit.id}`]:debit,[`/transactions/${credit.id}`]:credit};
 const http=vi.fn<typeof fetch>(async(url,init)=>{expect(new URL(String(url)).origin).toBe('https://sandbox.increase.com');expect(init?.redirect).toBe('error');return Response.json(rows[new URL(String(url)).pathname]??{}, {status:rows[new URL(String(url)).pathname]?200:404});});
 const provider=new IncreaseSandboxBank({scope,apiKey:'synthetic-only-v7',resolveCommand:async()=>saved,fetch:http});
 return{saved,transfer,debit,credit,rows,http,provider};
}
it('retains distinct sandbox-prefixed debit/return identities and refuses a prefix-stripped alias in any financial link',async()=>{
 const f=await setup();expect(await f.provider.getTransfer(scope,f.transfer.id)).toMatchObject({status:'returned',originalTransactionId:f.debit.id,returnTransactionId:f.credit.id});
 for(const mutate of [()=>{f.credit.account_id='account_same';},()=>{f.credit.source.ach_transfer_return.transfer_id='ach_transfer_same';},()=>{f.credit.id='transaction_return';},()=>{f.credit.amount=-2500;}]){
  const copy=structuredClone(f.credit);mutate();await expect(f.provider.getTransfer(scope,f.transfer.id)).rejects.toThrow();Object.assign(f.credit,copy);
 }
 expect(f.http.mock.calls.every(([,i])=>i?.method==='GET')).toBe(true);expect(JSON.stringify(f.provider)).not.toContain('synthetic-only-v7');
});
it('does not normalize a scoped account prefix or rewrite an immutable body to permit sending',async()=>{
 const f=await setup();const altered={...f.saved,scope:{...scope,accountId:'account_same'}};altered.providerRequest=buildIncreaseRequestBody(altered);altered.requestHash=await commandRequestHash(altered);
 await expect(f.provider.createTransfer(altered)).rejects.toThrow();
 const body={...f.saved,providerRequest:f.saved.providerRequest!.replace('sandbox_external_account_same','external_account_same')};body.requestHash=await commandRequestHash(body);
 await expect(f.provider.createTransfer(body)).rejects.toThrow();expect(f.http).not.toHaveBeenCalled();
});
it('rejects path, repeated-prefix, cross-kind and control characters before transport',async()=>{
 const f=await setup();
 for(const suffix of ['','same/next','same?x=1','same%2fnext','same#x','same\\next','same\n','same\u0000']){
  await expect(f.provider.getTransfer(scope,`sandbox_ach_transfer_${suffix}`)).rejects.toThrow();
  await expect(f.provider.getTransaction(scope,`sandbox_transaction_${suffix}`)).rejects.toThrow();
 }
 for(const id of ['sandbox_sandbox_ach_transfer_same','sandbox_transaction_same','https://other.invalid'])await expect(f.provider.getTransfer(scope,id)).rejects.toThrow();
 for(const externalAccountId of ['sandbox_external_account_same/next','sandbox_sandbox_external_account_same','sandbox_account_same']){
  const c={...f.saved,destination:{...f.saved.destination,externalAccountId}};c.providerRequest=buildIncreaseRequestBody(c);c.requestHash=await commandRequestHash(c);await expect(f.provider.createTransfer(c)).rejects.toThrow();
 }
 expect(f.http).not.toHaveBeenCalled();
});
it('requires exact account ownership before sandbox simulation and keeps simulation on its pinned origin',async()=>{
 let account='account_same';const calls:Array<{url:string,init:RequestInit|undefined}>=[];
 const http:typeof fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({id:'sandbox_ach_transfer_same',account_id:account,status:'pending_submission'});};
 const harness=new IncreaseSandboxHarness({scope,apiKey:'synthetic-only',fetch:http});
 await expect(harness.submit('sandbox_ach_transfer_same')).rejects.toThrow();expect(calls).toHaveLength(1);expect(calls[0]!.init?.method).toBeUndefined();
 account=scope.accountId;await harness.submit('sandbox_ach_transfer_same');expect(calls).toHaveLength(3);expect(calls[2]!.init?.method).toBe('POST');
 expect(calls.every(c=>new URL(c.url).origin==='https://sandbox.increase.com'&&c.init?.redirect==='error')).toBe(true);
 expect(calls[2]!.url).toBe('https://sandbox.increase.com/simulations/ach_transfers/sandbox_ach_transfer_same/submit');
 expect(()=>new IncreaseSandboxHarness({scope:{...scope,environment:'production'} as unknown as BankScope,apiKey:'synthetic-only',fetch:http})).toThrow();
});
it('binds signature to exact prefixed event ID, raw body and time while rejecting another environment',()=>{
 const secret='v7-offline-signing',time=1792886400,event={...fixtures.event,id:'sandbox_event_same',associated_object_id:'sandbox_ach_transfer_same'};
 const body=Buffer.from(JSON.stringify(event));const sig=(id:string)=>createHmac('sha256',secret).update(`${id}.${time}.`).update(body).digest('base64');
 const args={rawBody:body,headers:{'webhook-id':event.id,'webhook-timestamp':String(time),'webhook-signature':`v1,${sig(event.id)}`},scope,signingSecret:secret,now:time*1000};
 expect(verifyIncreaseWebhook(args)).toMatchObject({id:event.id,transferId:event.associated_object_id});
 expect(()=>verifyIncreaseWebhook({...args,headers:{...args.headers,'webhook-id':'event_same','webhook-signature':`v1,${sig('event_same')}`}})).toThrow();
 expect(()=>verifyIncreaseWebhook({...args,now:(time+301)*1000})).toThrow();
 expect(()=>verifyIncreaseWebhook({...args,scope:{...scope,environment:'production'} as unknown as BankScope})).toThrow();
});
