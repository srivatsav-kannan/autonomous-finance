import {makeFunctionReference} from 'convex/server';
import {taxBusinessFixture} from './tax-business-fixture';
import {cr} from './business-fixture';
import type {Id} from '../../convex/_generated/dataModel';
import type {TaxAdjustment,TaxShare,TaxState} from '../../src/ap-system/tax-adjustment-contracts';
export const closeVote=makeFunctionReference<'mutation'>('apClose:vote');
export const taxRead=makeFunctionReference<'query'>('apClose:taxState');
export async function adjustmentFixture(initial=10000){
  const f=await taxBusinessFixture({recoveryBps:initial}),original=await f.propose(f.detail,f.a);await f.approve(original);
  const entry=(await f.state()).journals[0]!;let serial=0;
  const taxState=()=>f.humans.finance!.query(taxRead,{scope:f.scope,originalEntryId:entry._id}) as Promise<TaxState>;
  async function changePolicy(bps:number){
    f.policy.version=`v13-adjusted-policy-${++serial}`;
    Object.assign(f.policy.taxCodes.find(t=>t.code==='TEST')!.recovery!,{recoverableBps:bps,adjustments:{mode:'reviewed_remaining_tax',attribution:'explicit_original_allocation',creditRounding:'half_up_cumulative_latest_adjustment'}});
    const p=await f.t.mutation(cr.proposePolicy!,{...f.controller,idempotencyKey:f.policy.version,policy:f.policy});
    const row=(await f.t.run(ctx=>ctx.db.get(p.policyId as Id<'apBusinessPolicies'>)))!;
    await f.humans.governor!.mutation(cr.activatePolicy!,{scope:f.scope,policyId:p.policyId,expectedHash:row.hash,reason:'Independent synthetic remaining-tax policy approval'});
  }
  async function action(target:number,movements:TaxAdjustment['movements'],initialAttribution?:TaxShare[]):Promise<TaxAdjustment>{
    const s=await taxState();return {kind:'tax_adjustment',originalEntryId:entry._id,originalApprovalId:original.proposalId,costSnapshotHash:s.costSnapshotHash,taxSnapshotHash:s.snapshotHash,targets:[{originalLineId:'line-1',recoverableCents:target}],movements,date:'2026-10-19',eligibilityEvidence:f.a.lines[0]!.tax!.eligibilityEvidence,reason:'Independent remaining-tax adjustment',...initialAttribution?{initialAttribution}:{}};
  }
  const proposeTax=(action:TaxAdjustment)=>f.t.mutation(f.close,{...f.controller,input:{idempotencyKey:`v13-tax-${++serial}`,action}});
  const voteTax=(p:any,who:string)=>f.humans[who]!.mutation(closeVote,{scope:f.scope,input:{actionId:p.actionId,actionHash:p.actionHash,idempotencyKey:`v13-vote-${p.actionId}-${who}`,outcome:'approved',reason:'Independent exact tax state and original attribution'}});
  async function approveTax(p:any){let result:any;for(const stage of p.route)result=await voteTax(p,stage.groupId==='tax-review'?'second':stage.groupId);return result;}
  return {...f,original,entry,taxState,changePolicy,action,proposeTax,voteTax,approveTax};
}
