import type {APCaseDetail,SourceBinding} from "../../src/ap-system/contracts";
import type {PhysicalLineView,PhysicalAllocation} from "../../src/ap-system/physical-line-contracts";
import type {BusinessAcceptance,CreditPlan} from "../../src/ap-system/domain-contracts";
import {quantityMicros} from "../../src/ap-system/accounting";
export const physicalSourceKey=(s:SourceBinding)=>`${s.sourceId}:${s.revision}:${s.sha256}`;
export function currentPhysicalReviews(view:PhysicalLineView,detail:APCaseDetail,source:SourceBinding){return view.reviews.filter(r=>detail.currentSourceBindings.some(s=>physicalSourceKey(s)===physicalSourceKey(source))&&r.status==="approved"&&r.decision?.outcome==="approved"&&r.caseId===detail.caseId&&r.proposal.expectedRevision===detail.revision&&r.proposal.snapshotHash===detail.snapshotHash&&physicalSourceKey(r.proposal.source)===physicalSourceKey(source)&&view.catalogs.some(c=>c.catalogId===r.catalogId&&c.sourceHash===source.sha256));}
/** Validate the user-entered distribution, never infer a split from parser order. */
export function validatePhysicalAllocation(view:PhysicalLineView,detail:APCaseDetail,source:SourceBinding,parserLineId:string,quantity:string,identity:PhysicalAllocation|undefined){
 const catalog=view.catalogs.find(c=>c.sourceHash===source.sha256);if(!identity){if(catalog)throw Error("This original has a physical catalog. Select an approved current mapping and allocate the exact claimed quantity.");return;}
 const review=currentPhysicalReviews(view,detail,source).find(r=>r.reviewId===identity.reviewId);if(!review)throw Error("The physical mapping is not approved for this exact current case and original.");
 const links=review.proposal.links.filter(l=>l.parserLineId===parserLineId),seen=new Set<string>();let sum=0n;
 for(const allocation of identity.allocations){const link=links.find(l=>l.physicalLineId===allocation.physicalLineId),n=quantityMicros(allocation.quantity);if(!link||seen.has(allocation.physicalLineId)||n<=0n||n>quantityMicros(link.quantity))throw Error("Each physical allocation must be positive, unique and within this parser row's reviewed mapping.");seen.add(allocation.physicalLineId);sum+=n;}
 if(sum!==quantityMicros(quantity)||sum<=0n)throw Error("Physical quantities must exactly equal the claimed quantity; merged rows need an explicit distribution.");
}

export function validatePhysicalBusiness(view:PhysicalLineView,detail:APCaseDetail,input:{acceptance?:BusinessAcceptance;credit?:CreditPlan}){
 for(const line of input.acceptance?.lines??[]){
  if(line.agreement)validatePhysicalAllocation(view,detail,line.agreement.source,line.agreement.lineId,line.quantity,line.agreement.identity);
  for(const claim of line.receipts)validatePhysicalAllocation(view,detail,claim.source,claim.lineId,claim.quantity,claim.identity);
 }
 for(const line of input.credit?.lines??[]){
  if(!line.returnClaims?.length){if(line.returnEvidence.some(s=>view.catalogs.some(c=>c.sourceHash===s.sha256)))throw Error("This return original has a physical catalog. Enter explicit return line claims.");continue;}
  let total=0n;
  for(const claim of line.returnClaims){if(!line.returnEvidence.some(s=>physicalSourceKey(s)===physicalSourceKey(claim.source)))throw Error("Select every claimed return original in the supporting return evidence.");validatePhysicalAllocation(view,detail,claim.source,claim.lineId,claim.quantity,claim.identity);total+=quantityMicros(claim.quantity);}
  if(total!==quantityMicros(line.quantity))throw Error("Return line claims must exactly cover the credited quantity.");
 }
}
export function physicalAccrualChoices(view:PhysicalLineView,cases:APCaseDetail[],source:SourceBinding,supplierId:string){
 return cases.filter(c=>c.candidate?.supplierId===supplierId).flatMap(detail=>currentPhysicalReviews(view,detail,source).flatMap(review=>{
  const catalog=view.catalogs.find(c=>c.catalogId===review.catalogId&&c.supplierId===supplierId&&["receipt","service_acceptance"].includes(c.purpose));if(!catalog)return [];
  return review.proposal.links.flatMap(link=>{const physical=catalog.physicalLines.find(p=>p.physicalLineId===link.physicalLineId);return physical?[{key:`${review.reviewId}:${link.parserLineId}:${link.physicalLineId}`,detail,review,link,physical,capacity:catalog.capacities.find(c=>c.physicalLineId===link.physicalLineId)}]:[];});
 }));
}
