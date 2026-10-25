import {CHART} from "../../src/core/accounts";
import {sameCoordinates,dimensionPolicyProblem} from "../../src/ap-system/gl-dimensions";
import type {SourceDocument} from "../../src/ap-system/contracts";
import type {BusinessPolicy} from "../../src/ap-system/domain-contracts";
import type {CostState} from "../../src/ap-system/cost-contracts";
import {taxAdjustmentSchema,taxPositionKey,taxReversalSchema,type TaxState,type TaxShare} from "../../src/ap-system/tax-adjustment-contracts";
import {taxCitationSchema} from "../../src/ap-system/tax-contracts";
import {taxProportion} from "../../src/ap-system/tax-policy";
import {buildCostCorrection,type CostDraftRow} from "./APCostCorrection";
import {buildTaxCitation,type CitationDraft} from "./apTaxView";
import {accountingAmountInput} from "./apSystemView";
export type TaxMovementDraft={bucket:string;account:string;amount:string};
const sum=(values:number[])=>{const n=values.reduce((n,v)=>n+BigInt(v),0n);if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw Error("Tax amount is outside exact cent precision.");return Number(n);};
const money=(v:string,zero=false)=>{const n=accountingAmountInput(v,zero);if(n===undefined)throw Error("Enter every exact tax amount, including explicit zero targets.");return n;};
export function reviewedTaxBuckets(state:TaxState,cost:CostState,policy:BusinessPolicy,rows:CostDraftRow[],evidence:SourceDocument[],reason:string){
 if(state.originalEntryId!==cost.originalEntryId||state.costSnapshotHash!==cost.snapshotHash)throw Error("Tax and cost snapshots differ. Refresh both before reviewing.");
 if(state.adjusted&&rows.length)throw Error("Initial tax attribution is already immutable.");
 const attribution=rows.length?buildCostCorrection(cost,rows,policy,evidence.map(({sourceId,revision,sha256})=>({sourceId,revision,sha256})),reason).allocations.map(a=>{
  if(a.side!=="credit")throw Error("Attribute tax only to an original non-tax debit lineage.");
  return {originalLineId:a.originalLineId,allocationIndex:a.allocationIndex,account:a.account,treatment:a.treatment,store:a.store,department:a.department??null,project:a.project??null,amountCents:a.amountCents};
 }):[];
 if(!state.adjusted)for(const line of state.lines)if(sum(attribution.filter(a=>a.originalLineId===line.originalLineId).map(a=>a.amountCents))!==line.unattributedCostCents)throw Error(`Attribute every remaining nonrecoverable tax cent for ${line.originalLineId}.`);
 if(attribution.some(a=>!state.lines.some(l=>l.originalLineId===a.originalLineId)))throw Error("Tax attribution must belong to an original tax line.");
 return {attribution,buckets:[...state.buckets,...attribution]};
}
export function requiredTaxTarget(state:TaxState,lineId:string,policy:BusinessPolicy,date:string){
 const line=state.lines.find(l=>l.originalLineId===lineId),rule=policy.taxCodes.find(t=>t.code===line?.taxCode&&t.mode==="recoverable")?.recovery;
 if(!line||!rule?.adjustments||rule.jurisdiction!==line.jurisdiction||!rule.priceBases.includes(line.priceBasis)||date<rule.effectiveFrom||date>rule.effectiveThrough)throw Error("An explicit current recovery-adjustment policy is required for every original tax line and the selected date.");
 return taxProportion(line.remainingTaxCents,rule.recoverableBps,10000);
}
export function buildTaxAdjustment(input:{state:TaxState;cost:CostState;policy:BusinessPolicy;attribution:CostDraftRow[];targets:Record<string,string>;movements:TaxMovementDraft[];citations:CitationDraft[];documents:SourceDocument[];date:string;period:string;reason:string}){
 const {state,cost,policy,date,period,reason}=input;
 if(date<state.latestDate||date.slice(0,7)!==period)throw Error("Choose an accounting date in the selected period, on or after the latest included event.");
 const documents=input.documents.filter(d=>["other","contract","correction"].includes(d.kind)),eligibilityEvidence=input.citations.map(c=>taxCitationSchema.parse(buildTaxCitation(c,documents,false)));
 const {attribution,buckets}=reviewedTaxBuckets(state,cost,policy,input.attribution,documents,reason),used=new Map<string,number>(),balances=new Map(buckets.map(b=>[taxPositionKey(b),b.amountCents]));
 const targets=state.lines.map(l=>{const recoverableCents=money(input.targets[l.originalLineId]??"",true);if(recoverableCents!==requiredTaxTarget(state,l.originalLineId,policy,date))throw Error("Each entered recovery target must equal the explicit effective policy for remaining tax.");return {originalLineId:l.originalLineId,recoverableCents};});
 const positions=cost.positions.map(p=>({...p}));
 const movements=input.movements.map(d=>{const b=buckets.find(b=>taxPositionKey(b)===d.bucket),account=policy.accounts.find(a=>a.account===d.account);if(!b||!account)throw Error("Choose an exact existing tax bucket and supported destination account.");const amountCents=money(d.amount),from={...b,amountCents},key=taxPositionKey(from),total=sum([used.get(key)??0,amountCents]);if(total>b.amountCents)throw Error("Movement exceeds the existing bucket; intermediate destinations cannot be reused.");used.set(key,total);
  if(from.account===account.account&&from.treatment===account.treatment)throw Error("Choose a different destination for this tax movement.");
  const line=state.lines.find(l=>l.originalLineId===from.originalLineId),rule=policy.taxCodes.find(t=>t.code===line?.taxCode)?.recovery;if(account.treatment==="tax"&&account.account!==rule?.receivableAccount)throw Error("Tax recovery must use the explicit policy receivable.");
  for(const a of [from,{...from,account:account.account,treatment:account.treatment}]){const chart=CHART.find(c=>c.code===a.account);if(!chart||chart.cash||!["expense","asset"].includes(chart.type)||!policy.accounts.some(p=>p.account===a.account&&p.treatment===a.treatment)||dimensionPolicyProblem(a,policy)||(a.store!==null&&!policy.stores.includes(a.store))||(a.treatment==="expense"?chart.type!=="expense":chart.type!=="asset"))throw Error("Tax movement requires supported noncash accounts and exact approved dimensions.");}
  const position=positions.find(p=>p.account===from.account&&sameCoordinates(p,from));if(!position||position.balanceCents<amountCents)throw Error("Tax movement exceeds the current posted account and dimension balance.");position.balanceCents-=amountCents;const toPosition=positions.find(p=>p.account===account.account&&sameCoordinates(p,from));if(toPosition){const n=toPosition.balanceCents+amountCents;if(!Number.isSafeInteger(n))throw Error("Tax destination exceeds exact cent precision.");toPosition.balanceCents=n;}else positions.push({account:account.account,store:from.store,department:from.department,project:from.project,balanceCents:amountCents});
  balances.set(key,(balances.get(key)??0)-amountCents);const dest=taxPositionKey({...from,account:account.account,treatment:account.treatment});balances.set(dest,sum([balances.get(dest)??0,amountCents]));return {from,toAccount:account.account,toTreatment:account.treatment};
 });
 const final=buckets.map(b=>({...b,amountCents:balances.get(taxPositionKey(b))??0}));for(const m of movements){const dest={...m.from,account:m.toAccount,treatment:m.toTreatment};if(!final.some(b=>taxPositionKey(b)===taxPositionKey(dest)))final.push({...dest,amountCents:balances.get(taxPositionKey(dest))??0});}
 const signature=(rows:TaxShare[])=>JSON.stringify(rows.filter(b=>b.amountCents>0).map(b=>[taxPositionKey(b),b.amountCents]).sort());if(signature(buckets)===signature(final))throw Error("Tax movements must change the remaining allocation.");
 for(const t of targets)if(sum(final.filter(b=>b.originalLineId===t.originalLineId&&b.treatment==="tax").map(b=>b.amountCents))!==t.recoverableCents)throw Error("Exact movements do not achieve every entered recovery target.");
 return taxAdjustmentSchema.parse({kind:"tax_adjustment",originalEntryId:state.originalEntryId,originalApprovalId:state.originalApprovalId,costSnapshotHash:cost.snapshotHash,taxSnapshotHash:state.snapshotHash,...(!state.adjusted?{initialAttribution:attribution}:{}),targets,movements,date,eligibilityEvidence,reason});
}
export type TaxReversalDraft={bucket:string;amount:string};
export function buildTaxReversal(state:TaxState,items:{originalLineId:string;taxCents:number}[],rows:TaxReversalDraft[],reason:string){
 if(!state.adjusted)throw Error("This original has no posted tax adjustment; its original tax rules apply.");
 const seen=new Set<string>();const allocations:TaxShare[]=rows.map(r=>{if(seen.has(r.bucket))throw Error("Combine repeated amounts for the same tax bucket.");seen.add(r.bucket);const b=state.buckets.find(b=>taxPositionKey(b)===r.bucket);if(!b)throw Error("Choose a current exact tax bucket.");const amountCents=money(r.amount);if(amountCents>b.amountCents)throw Error("Credit exceeds the remaining tax bucket.");return {...b,amountCents};});
 if(allocations.some(a=>!items.some(i=>i.originalLineId===a.originalLineId)))throw Error("Tax reversal must belong to a credited line.");
 for(const item of items){const line=state.lines.find(l=>l.originalLineId===item.originalLineId),actual=allocations.filter(a=>a.originalLineId===item.originalLineId);if(sum(actual.map(a=>a.amountCents))!==(line?item.taxCents:0))throw Error("Allocate every credited tax cent exactly once.");if(line){if(item.taxCents>line.remainingTaxCents)throw Error("Credited tax exceeds the remaining original tax.");const expected=line.creditBasisTaxCents?taxProportion(line.creditBasisRecoverableCents,line.creditedTaxCents+item.taxCents,line.creditBasisTaxCents)-line.creditedRecoverableCents:0;if(sum(actual.filter(a=>a.treatment==="tax").map(a=>a.amountCents))!==expected)throw Error("Tax credit must preserve the current recovery proportion and cumulative rounding.");}}
 return taxReversalSchema.parse({snapshotHash:state.snapshotHash,allocations,reason});
}
