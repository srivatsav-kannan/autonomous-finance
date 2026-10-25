import type { Id } from "../../convex/_generated/dataModel";
import { createHash } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import { fixture, packet, refs } from "./accounting-fixture";
import type { APIntake, APCaseDetail, SourceDocument } from "../../src/ap-system/contracts";
import type { BusinessPolicy, BusinessAcceptance, SupplierProposal } from "../../src/ap-system/domain-contracts";
export const br = Object.fromEntries(["propose", "vote", "applyCredits", "proposals"].map((n) => [n, makeFunctionReference<"mutation">(`apBusiness:${n}`)]));
export const cr = Object.fromEntries(["proposePolicy", "activatePolicy", "registerTrustedContact", "proposeSupplier", "verifySupplier", "approveSupplier", "delegate", "revokeDelegation", "view"].map((n) => [n, makeFunctionReference<"mutation">(`apBusinessConfig:${n}`)]));
export const subject = (name: string) => `https://ap-demo.invalid|${name}`;
export const binding = (d: SourceDocument) => ({sourceId:d.sourceId,revision:d.revision,sha256:d.sha256});
export function policy(): BusinessPolicy { return {version:"business-test-v1",groups:[{groupId:"verify",members:[subject("verifier")]},{groupId:"govern",members:[subject("governor")]},{groupId:"owner",members:[subject("owner"),subject("second")]},{groupId:"finance",members:[subject("finance")]},{groupId:"escalation",members:[subject("escalation")]}],supplierVerificationGroup:"verify",supplierApprovalGroup:"govern",varianceApprovalGroup:"finance",bands:[{upToCents:5000,steps:[{groupId:"owner",quorum:1,escalateAfterMs:60000,escalationGroupId:"escalation"}]},{upToCents:Number.MAX_SAFE_INTEGER,steps:[{groupId:"owner",quorum:1,escalateAfterMs:60000,escalationGroupId:"escalation"},{groupId:"finance",quorum:1,escalateAfterMs:60000,escalationGroupId:null}]}],accounts:[{account:"5000",treatment:"expense"},{account:"1200",treatment:"inventory"},{account:"1300",treatment:"prepayment"},{account:"1500",treatment:"fixed_asset"}],stores:["sf-hayes-valley"],taxCodes:[{code:"NONE",mode:"none"},{code:"COST",mode:"nonrecoverable"},{code:"VAT",mode:"recoverable"}],maxPriceVarianceBps:0,maxDelegationMs:86400000}; }
export function acceptance(input: APIntake, quantity = "2"): BusinessAcceptance {
 const c=input.candidate!, net=Number(quantity)*c.lines[0]!.unitPriceCents, tax=Math.round(c.lines[0]!.taxCents*Number(quantity)/Number(c.lines[0]!.quantity.decimal));
 return {lines:[{lineId:"line-1",quantity,netCents:net,taxCents:tax,taxCode:tax?"COST":"NONE",allocations:[{...c.lines[0]!.allocations[0]!,amountCents:net+tax}],procurement:input.purchasingEvidence[0]!.kind==="contract"?"non_po":"po",agreement:{source:input.purchasingEvidence[0]!.source,lineId:input.purchasingEvidence[0]!.lines[0]!.lineId},receipts:[{source:input.purchasingEvidence[1]!.source,lineId:input.purchasingEvidence[1]!.lines[0]!.lineId,quantity}]}],freightCents:0,freightAllocations:[],discountCents:0,discountAllocations:[],reason:"Explicit supported portion; balance remains disputed",resolutions:[]};
}
export function syncPrimary(input: APIntake) {
 const c=input.candidate!, doc=input.documents[0]!;
 const values: Record<string,string|number>={extractedSupplierName:c.extractedSupplierName,invoiceNumber:c.invoiceNumber,invoiceDate:c.invoiceDate,totalCents:c.totalCents};
 for(const l of c.lines) for(const [k,v] of Object.entries({sku:l.sku!,description:l.description,quantity:l.quantity.decimal,unitPriceCents:l.unitPriceCents,amountCents:l.amountCents,...(l.taxCents?{taxCents:l.taxCents}:{})})) values[`lines.${l.lineId}.${k}`]=v;
 const body=Object.entries(values).map(([k,v])=>`${k} ${v}`).join("\n"); doc.extractedText=body;doc.originalBase64=Buffer.from(body).toString("base64");doc.byteLength=Buffer.byteLength(body);doc.sha256=createHash("sha256").update(body).digest("hex");
 const template=c.evidence[0]!; c.evidence=Object.entries(values).map(([fieldPath,value])=>({...structuredClone(template),evidenceId:`field-${fieldPath}`,source:binding(doc),fieldPath,rawValue:String(value),normalizedValue:value,quote:String(value)})); c.sources=input.documents.map(binding); c.lines.forEach((l)=>l.evidenceIds=c.evidence.filter((e)=>e.fieldPath.startsWith(`lines.${l.lineId}.`)).map((e)=>e.evidenceId));input.extraction.evidence=c.evidence;return input;
}
export async function businessFixture(options: {policy?: BusinessPolicy; input?: APIntake; onboard?:boolean}={}) {
 const f=await fixture();
 const names=["verifier","governor","owner","second","finance","escalation","delegate"];
 const humans=Object.fromEntries(names.map((name)=>[name,f.t.withIdentity({issuer:"https://ap-demo.invalid",subject:name,tokenIdentifier:subject(name)})]));
 await f.t.run(async(ctx)=>{const seat=(await ctx.db.query("seats").collect()).find((s)=>s.seatId==="human_cfo")!;const {_id,_creationTime,...base}=seat;for(const name of names)await ctx.db.insert("seats",{...base,seatId:`human-${name}`,name});const config=(await ctx.db.query("demoConfigs").collect())[0]!;await ctx.db.patch(config._id,{humanSubjects:[...config.humanSubjects,...names.map((n)=>({subject:subject(n),seatId:`human-${n}`}))]});});
 const input=options.input??packet(); const d=await f.reviewed(input); const p=options.policy??policy();
 const controller={scope:f.scope,seatId:"controller",token:"token-controller"};
 const proposed=await f.t.mutation(cr.proposePolicy!,{...controller,idempotencyKey:"policy",policy:p});
 const stored=await f.t.run((ctx)=>ctx.db.get(proposed.policyId as Id<"apBusinessPolicies">));await humans.governor!.mutation(cr.activatePolicy!,{scope:f.scope,policyId:proposed.policyId,expectedHash:stored!.hash,reason:"Approve explicit synthetic company policy"});
 const proof=[binding(input.documents[1]!)];
 const contact=await humans.verifier!.mutation(cr.registerTrustedContact!,{scope:f.scope,idempotencyKey:"contact",supplierId:input.candidate!.supplierId!,phone:"+14155550123",evidence:proof,mode:"simulated"});
 const proposal: SupplierProposal={supplierId:input.candidate!.supplierId!,legalName:input.candidate!.extractedSupplierName,aliases:[],contactId:contact.contactId,expectedRevision:0,externalAccountId:"external-supplier-v1",currency:"USD",catalog:[{sku:"KALE-24",unit:"case",unitPriceCents:3850}],evidence:proof,reason:"Onboard from independently retained contact and contract"};
 async function onboard(value=proposal,key="supplier"){
 const r=await f.t.mutation(cr.proposeSupplier!,{...f.ap,idempotencyKey:key,proposal:value});const created=await f.t.run((ctx)=>ctx.db.get(r.revisionId as Id<"apSupplierRevisions">));await humans.verifier!.mutation(cr.verifySupplier!,{scope:f.scope,revisionId:r.revisionId,verification:{contactId:value.contactId,method:"callback_previously_held_contact",result:"confirmed",performedAt:created!.createdAt,evidence:proof,mode:"simulated",reason:"Synthetic callback test; no actual call"}});const rr=await f.t.run((ctx)=>ctx.db.get(r.revisionId as Id<"apSupplierRevisions">));await humans.governor!.mutation(cr.approveSupplier!,{scope:f.scope,revisionId:r.revisionId,expectedHash:rr!.hash,reason:"Independent supplier destination approval"});return r; }
 if(options.onboard!==false)await onboard();
 async function propose(detail: APCaseDetail=d,a=acceptance(input),key=`propose-${detail.caseId}`,supplierRevision=1){return f.t.mutation(br.propose!,{...f.ap,input:{caseId:detail.caseId,expectedRevision:detail.revision,snapshotHash:detail.snapshotHash,idempotencyKey:key,policyVersion:p.version,supplierRevision,acceptance:a}});}
 async function vote(prop: {proposalId:string;proposalHash:string},name="owner",key=`vote-${prop.proposalId}-${name}`,extra:Record<string,unknown>={}){return humans[name]!.mutation(br.vote!,{scope:f.scope,input:{...prop,idempotencyKey:key,outcome:"approved",reason:"Compared approved source/amount/allocation",...extra}});}
 async function recognize(detail=d,a=acceptance(input),key=`approve-${detail.caseId}`){const prop=await propose(detail,a,key);let r=await vote(prop);if(r.status==="pending")r=await vote(prop,"finance");return {...r,proposal:prop};}
 async function reviewed(next: APIntake){const r=await f.t.mutation(refs.ingest,{...f.ap,input:next});const detail=await f.get(r.caseId);await f.human.mutation(refs.review,{scope:f.scope,input:f.request(detail,`review-${detail.caseId}-${detail.revision}`)});return f.get(r.caseId);}
 return {...f,reviewed,humans,controller,input,detail:d,policy:p,supplier:proposal,proof,onboard,propose,vote,recognize};
}
