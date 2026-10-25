import {useEffect,useRef,useState} from "react";
import type {SourceBinding} from "../../src/ap-system/contracts";
import type {BusinessPolicy} from "../../src/ap-system/domain-contracts";
import {costCorrectionSchema,type CostCorrection,type CostState} from "../../src/ap-system/cost-contracts";
import {apSystemApi,apError} from "./apSystemApi";
import {apMoney,apLabel,accountingAmountInput} from "./apSystemView";
export type CostReview={context:string;ready:boolean;correction?:CostCorrection};
export type CostSource=SourceBinding&{name:string};
export type CostDraftRow={share:number;account:string;amount:string};
const sourceKey=(s:SourceBinding)=>`${s.sourceId}:${s.revision}:${s.sha256}`;
export function reachableCostAccounts(state:CostState,share:CostState["originalShares"][number]){
 const accounts=new Set([share.account]);let changed=true;
 while(changed){changed=false;for(const edge of state.corrections)if(edge.store===share.store&&accounts.has(edge.fromAccount)&&!accounts.has(edge.toAccount)){accounts.add(edge.toAccount);changed=true;}}
 return accounts;
}
/** Original identity, side and store come only from the authenticated read model. */
export function buildCostCorrection(state:CostState,rows:CostDraftRow[],policy:BusinessPolicy,evidence:SourceBinding[],reason:string):CostCorrection{
 const used=new Map<number,number>(),seen=new Set<string>();
 const allocations=rows.map(row=>{
  const original=state.originalShares[row.share],account=policy.accounts.find(a=>a.account===row.account);
  if(!original||!account||!reachableCostAccounts(state,original).has(row.account))throw Error("Choose an original share and a reachable account from the current policy.");
  const amountCents=accountingAmountInput(row.amount);if(amountCents===undefined)throw Error("Enter the exact positive amount to reverse for every selected share.");
  const key=JSON.stringify([row.share,row.account]);if(seen.has(key))throw Error("Combine amounts for the same original share and account.");seen.add(key);
  const total=(used.get(row.share)??0)+amountCents;if(total>original.remainingCents)throw Error("The proposed shares exceed the remaining original capacity.");used.set(row.share,total);
  return {originalLineId:original.originalLineId,allocationIndex:original.allocationIndex,account:row.account,store:original.store,treatment:account.treatment,side:original.side,amountCents};
 });
 const signed=new Map<string,number>();
 for(const allocation of allocations){
  const key=JSON.stringify([allocation.account,allocation.store]);
  const amount=(signed.get(key)??0)+(allocation.side==="credit"?allocation.amountCents:-allocation.amountCents);
  if(!Number.isSafeInteger(amount))throw Error("Signed cost allocation exceeds safe cent precision.");
  signed.set(key,amount);
 }
 for(const [key,amount] of signed){
  const available=state.positions.find(p=>JSON.stringify([p.account,p.store])===key)?.balanceCents??0;
  if(!Number.isSafeInteger(available)||(amount>0&&available<amount)||(amount<0&&available>amount))throw Error("Signed shares exceed the current corrected cost balance for this account and store.");
 }
 return costCorrectionSchema.parse({snapshotHash:state.snapshotHash,allocations,evidence,reason});
}
type Props={originalEntryId?:string;context:string;policy?:BusinessPolicy;sources:CostSource[];busy:boolean;onChange:(review:CostReview)=>void};
export function APCostCorrection(props:Props){
 const[state,setState]=useState<CostState>(),[error,setError]=useState<string>();const callback=useRef(props.onChange);callback.current=props.onChange;
 useEffect(()=>{const abort=new AbortController();setState(undefined);setError(undefined);callback.current({context:props.context,ready:false});
  if(!props.originalEntryId){setError("Choose an original posted obligation or accrual first.");return;}
  apSystemApi.costState(props.originalEntryId,abort.signal).then(value=>{if(abort.signal.aborted)return;if(value.originalEntryId!==props.originalEntryId)throw Error("Cost evidence does not match the selected original journal.");setState(value);callback.current({context:props.context,ready:value.corrections.length===0});}).catch(e=>{if(!abort.signal.aborted)setError(apError(e));});return()=>abort.abort();
 },[props.originalEntryId,props.context]);
 return <section className="aps-cost-review" aria-label="Current cost allocation review"><h4>Current cost allocation review</h4>{error?<p className="aps-error" role="alert">Cost evidence unavailable: {error}</p>:!state?<p role="status">Loading exact original shares and approved corrections…</p>:<APCostCorrectionEditor key={`${props.context}:${state.snapshotHash}`} {...props} state={state}/>}</section>;
}
export function APCostCorrectionEditor({state,context,policy,sources,busy,onChange}:{state:CostState;context:string;policy?:BusinessPolicy;sources:CostSource[];busy:boolean;onChange:(review:CostReview)=>void}){
 const[rows,setRows]=useState<CostDraftRow[]>([]),[evidence,setEvidence]=useState<SourceBinding[]>([]),[reason,setReason]=useState(""),[confirmed,setConfirmed]=useState(false),[applied,setApplied]=useState(false),[error,setError]=useState<string>();
 const required=state.corrections.length>0;
 const invalidate=()=>{setConfirmed(false);setApplied(false);setError(undefined);onChange({context,ready:false});};
 const shares=state.originalShares.map((share,index)=>({share,index})).filter(({share})=>share.remainingCents>0);
 const update=(i:number,patch:Partial<CostDraftRow>)=>{invalidate();setRows(v=>v.map((r,j)=>i===j?{...r,...patch}:r));};
 return <><p className={required?"aps-notice":"aps-caption"}>{required?"Approved reclassifications affect this original. An explicit current cost plan is required before proposing its credit or reversal.":"No approved reclassification is recorded for this original. The backend can reverse the original shares; an alternative allocation still needs an explicit plan."} No approval is created here.</p><p className="aps-caption">Remaining capacity below is not a proposed reversal amount. Enter the exact shares for the selected credit or quantity, including signed discount reversals. The server checks proportional cents, source capacity and current balances again. Accounting date must be {state.latestDate} or later.</p>
 <div className="aps-table-wrap"><table><thead><tr><th>Original share</th><th>Original coding</th><th>Reversal side</th><th>Remaining / original</th></tr></thead><tbody>{state.originalShares.map((s,i)=><tr key={i}><td data-label="Original share">{s.originalLineId} / Allocation {s.allocationIndex+1}</td><td data-label="Original coding">{s.account}<small>{s.store??"No store"} / {s.period} / {apLabel(s.treatment)}</small></td><td data-label="Reversal side">{apLabel(s.side)}</td><td data-label="Remaining / original">{apMoney(s.remainingCents)} / {apMoney(s.amountCents)}</td></tr>)}</tbody></table></div>
 <details><summary>Current cost positions and approved correction history</summary><ul>{state.positions.map((p,i)=><li key={i}>{p.account} / {p.store??"No store"} / Signed balance {apMoney(p.balanceCents)}</li>)}</ul>{state.corrections.map(c=><p key={c.actionId}>{c.date} / {c.fromAccount} → {c.toAccount} / {c.store??"No store"} / {apMoney(c.amountCents)}<small>Approved action {c.actionId} / Journal {c.entryId}</small></p>)}<code>{state.snapshotHash}</code></details>
 <fieldset disabled={busy||!policy} className="aps-business-editor"><legend>Exact shares to reverse</legend>{!policy&&<p className="aps-notice">Current coding policy is unavailable. Refresh policy before reviewing a replacement cost plan.</p>}{rows.map((row,i)=>{const share=state.originalShares[row.share];return <fieldset key={i}><legend>Proposed share {i+1}</legend><div className="aps-form-grid"><label>Original allocation<select value={row.share} onChange={e=>update(i,{share:Number(e.target.value),account:""})}>{shares.map(({share:s,index})=><option key={index} value={index}>{s.originalLineId} / Allocation {s.allocationIndex+1} / {s.store??"No store"} / {apLabel(s.side)}</option>)}</select></label><label>Current reachable cost account<select value={row.account} onChange={e=>update(i,{account:e.target.value})}><option value="">Choose reviewed account</option>{policy?.accounts.filter(a=>share&&reachableCostAccounts(state,share).has(a.account)).map(a=><option key={a.account} value={a.account}>{a.account} / {apLabel(a.treatment)}</option>)}</select></label><label>Exact reversal amount (USD)<input inputMode="decimal" value={row.amount} onChange={e=>update(i,{amount:e.target.value})} placeholder="Enter exact share amount"/></label></div><p className="aps-caption">Preserved from original: {share?.store??"No store"} / {apLabel(share?.side??"")}. Add another row to split this same original share across approved accounts.</p><button onClick={()=>{invalidate();setRows(v=>v.filter((_,j)=>i!==j));}}>Remove proposed share</button></fieldset>;})}<button disabled={!shares.length} onClick={()=>{invalidate();setRows(v=>[...v,{share:shares[0]!.index,account:"",amount:""}]);}}>Add exact reversal share</button>
 <fieldset className="aps-evidence-picker"><legend>Supporting retained originals</legend>{sources.map(s=><label className="aps-check" key={sourceKey(s)}><input type="checkbox" checked={evidence.some(e=>sourceKey(e)===sourceKey(s))} onChange={e=>{invalidate();setEvidence(v=>e.target.checked?[...v,{sourceId:s.sourceId,revision:s.revision,sha256:s.sha256}]:v.filter(x=>sourceKey(x)!==sourceKey(s)));}}/>{s.name} / Revision {s.revision}</label>)}{!sources.length&&<p>No retained supporting original is available.</p>}</fieldset><label>Reason for these corrected shares<textarea value={reason} onChange={e=>{invalidate();setReason(e.target.value);}}/></label><label className="aps-check"><input type="checkbox" checked={confirmed} onChange={e=>{if(!e.target.checked)invalidate();else setConfirmed(true);}}/>I reviewed the exact original shares, current accounts, signed amounts and evidence.</label><button disabled={!confirmed||!rows.length||!reason.trim()||!evidence.length} onClick={()=>{try{if(!policy)return;const correction=buildCostCorrection(state,rows,policy,evidence,reason);setError(undefined);setApplied(true);onChange({context,ready:true,correction});}catch(e){setError(apError(e));}}}>Use reviewed cost allocation plan</button>{!required&&<button onClick={()=>{setRows([]);setEvidence([]);setReason("");setConfirmed(false);setApplied(false);setError(undefined);onChange({context,ready:true});}}>Use unchanged original cost shares</button>}</fieldset>{error&&<p className="aps-error" role="alert">{error}</p>}{applied&&<p className="aps-success" role="status">Exact cost plan added to the draft. Submit the business proposal separately for independent approval.</p>}</>;
}
