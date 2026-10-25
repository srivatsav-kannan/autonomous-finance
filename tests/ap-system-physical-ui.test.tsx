import {createHash} from "node:crypto";
import {afterEach,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {PhysicalCatalog,PhysicalMappingEditor,PhysicalReview} from "../console/src/APSystemPhysicalLines";
import {APPhysicalAllocation,APPhysicalAccrualPicker,APPhysicalReturnClaims} from "../console/src/APPhysicalClaims";
import {currentPhysicalReviews,physicalAccrualChoices,validatePhysicalAllocation,validatePhysicalBusiness} from "../console/src/apPhysicalView";
import {APPolicySummary} from "../console/src/APSystemGovernance";
import {acceptanceDraft} from "../console/src/APSystemBusiness";
import {apSystemApi} from "../console/src/apSystemApi";
import {configureAPSession} from "../console/src/apAuthSession";
import {physicalLineOperationSchemas} from "../src/ap-system/physical-line-contracts";
import type {CreditPlan} from "../src/ap-system/domain-contracts";
import {apUIFixture} from "./ap-system-ui.fixture";
import {physicalUIFixture,physicalUIText,physicalUIHash} from "./ap-system-physical-ui.fixture";
import raw from "../docs/ap-orchestration/evidence/D2-browser/data.json";
import type {BusinessPolicy} from "../src/ap-system/domain-contracts";
const {detail,view,source}=physicalUIFixture(apUIFixture()),review=view.reviews[0]!,save=async()=>true;
const identity={reviewId:review.reviewId,allocations:[{physicalLineId:"bin-a",quantity:"0.4"},{physicalLineId:"bin-b",quantity:"0.6"}]};
afterEach(()=>{configureAPSession(null);vi.unstubAllGlobals();});
it("binds synthetic locators to exact bytes and displays immutable capacity separately from use",()=>{
 expect(createHash("sha256").update(physicalUIText).digest("hex")).toBe(physicalUIHash);
 for(const p of view.catalogs[0]!.physicalLines)expect(physicalUIText.slice(p.locator.start,p.locator.end)).toBe(p.locator.quote);
 const html=renderToStaticMarkup(<PhysicalCatalog catalog={view.catalogs[0]!}/>);
 expect(html).toContain(physicalUIHash);expect(html).toContain("not a reservation");expect(html).toContain("Bin A: KALE-24 1 case at USD 38.50");expect(html).toContain("Consumed 0");expect(html).toContain("$38.50");
});
it("keeps proposal evidence, choice and confirmation blank and gates missing authority",()=>{
 const html=renderToStaticMarkup(<PhysicalMappingEditor detail={detail} view={view} group="reviewers" busy={false} save={save}/>);
 expect(html).not.toContain('checked=""');expect(html).toContain("Select a current original");expect(html).toContain("Submit controller mapping proposal");expect(html).toContain('disabled=""');
 const unavailable=renderToStaticMarkup(<PhysicalMappingEditor detail={detail} view={{...view,controllerProposalAvailable:false}} busy={false} save={save}/>);
 expect(unavailable).toContain("separate controller agent is required");expect(unavailable).toContain("physical line reviewer group");
});
it("separates the independent identity decision and hides stale policy/revision decisions",()=>{
 const pending={...review,status:"proposed",decision:null};
 const html=renderToStaticMarkup(<PhysicalReview review={pending} detail={detail} view={view} group="reviewers" policyHash={review.policyHash} busy={false} save={save}/>);
 expect(html).toContain("Choose a decision");expect(html).not.toContain('checked=""');expect(html).toContain("not an observation of delivery or a bill approval");
 for(const changed of [{...detail,revision:detail.revision+1},{...detail,snapshotHash:"0".repeat(64)}])expect(renderToStaticMarkup(<PhysicalReview review={pending} detail={changed} view={view} group="reviewers" policyHash={review.policyHash} busy={false} save={save}/>)).not.toContain("Record independent identity decision");
 expect(renderToStaticMarkup(<PhysicalReview review={pending} detail={detail} view={view} group="reviewers" policyHash="changed" busy={false} save={save}/>)).toContain("historical or not current");
 const approved=renderToStaticMarkup(<PhysicalReview review={review} detail={detail} view={view} group="reviewers" busy={false} save={save}/>);expect(approved).toContain("Recorded decision");expect(approved).not.toContain("Choose a decision");
});
it("requires an exact explicit split for a partial merged row without consuming remaining capacity in the UI",()=>{
 expect(()=>validatePhysicalAllocation(view,detail,source,"merged-receipt","1",identity)).not.toThrow();
 for(const bad of [undefined,{...identity,allocations:[]},{...identity,allocations:[{physicalLineId:"bin-a",quantity:"1.1"}]},{...identity,allocations:[{physicalLineId:"bin-a",quantity:"0.5"},{physicalLineId:"bin-a",quantity:"0.5"}]},{...identity,allocations:[{physicalLineId:"bin-a",quantity:"0.4"},{physicalLineId:"bin-b",quantity:"0.5"}]},{...identity,allocations:[{physicalLineId:"foreign",quantity:"1"}]}])expect(()=>validatePhysicalAllocation(view,detail,source,"merged-receipt","1",bad)).toThrow();
 const html=renderToStaticMarkup(<APPhysicalAllocation view={view} detail={detail} source={source} lineId="merged-receipt" quantity="1" value={{reviewId:review.reviewId,allocations:[]}} onChange={()=>{}}/>);
 expect(html.match(/inputMode="decimal" value=""/g)).toHaveLength(2);expect(html).toContain("No merged-row split is inferred");
 const changed=structuredClone(view);changed.catalogs[0]!.capacities.forEach(c=>c.remainingQuantity="0");expect(()=>validatePhysicalAllocation(changed,detail,source,"merged-receipt","1",identity)).not.toThrow(); // explicit accrual reversal is revalidated at posting
});
it("never offers rejected, foreign-case, stale-revision or wrong-source mappings",()=>{
 for(const patch of [{status:"rejected"},{caseId:"other"},{proposal:{...review.proposal,expectedRevision:2}},{proposal:{...review.proposal,snapshotHash:"b".repeat(64)}},{proposal:{...review.proposal,source:{...source,sha256:"0".repeat(64)}}}]){const changed={...view,reviews:[{...review,...patch}]};expect(currentPhysicalReviews(changed,detail,source)).toHaveLength(0);expect(()=>validatePhysicalAllocation(changed,detail,source,"merged-receipt","1",identity)).toThrow();}
});
it("validates agreement/receipt claims and requires exact declared return originals",()=>{
 const acceptance=acceptanceDraft(detail);acceptance.lines[0]!.quantity="1";acceptance.lines[0]!.receipts=[{source,lineId:"merged-receipt",quantity:"1",identity}];expect(()=>validatePhysicalBusiness(view,detail,{acceptance})).not.toThrow();acceptance.lines[0]!.receipts[0]!.identity=undefined;expect(()=>validatePhysicalBusiness(view,detail,{acceptance})).toThrow();
 const credit:CreditPlan={originalCaseId:"invoice",originalApprovalId:"approval",freightCents:0,discountCents:0,reason:"Synthetic return",lines:[{creditLineId:"credit",originalLineId:"original",basis:"quantity_return",quantity:"1",netCents:3850,taxCents:0,returnEvidence:[source],returnClaims:[{source,lineId:"merged-receipt",quantity:"1",identity}]}]};expect(()=>validatePhysicalBusiness(view,detail,{credit})).not.toThrow();credit.lines[0]!.returnEvidence=[];expect(()=>validatePhysicalBusiness(view,detail,{credit})).toThrow(/supporting return evidence/);credit.lines[0]!.returnEvidence=[source];credit.lines[0]!.returnClaims=undefined;expect(()=>validatePhysicalBusiness(view,detail,{credit})).toThrow(/explicit return line claims/);
 const html=renderToStaticMarkup(<APPhysicalReturnClaims detail={detail} view={view} value={credit.lines[0]!} onChange={()=>{}} disabled={false}/>);expect(html).not.toContain('checked=""');expect(html).toContain("This does not create receiving capacity");
});
it("discovers explicit accrual choices with separate parser and physical IDs and no default quantity",()=>{
 const choices=physicalAccrualChoices(view,[detail],source,detail.candidate!.supplierId!);expect(choices).toHaveLength(2);expect(choices[0]!.link.parserLineId).toBe("merged-receipt");expect(choices[0]!.physical.physicalLineId).toBe("bin-a");expect(physicalAccrualChoices(view,[detail],source,"other-supplier")).toHaveLength(0);
 const html=renderToStaticMarkup(<APPhysicalAccrualPicker view={view} cases={[detail]} source={source} supplierId={detail.candidate!.supplierId!} value="" onChange={()=>{}} disabled={false}/>);expect(html).toContain('value="" selected=""');expect(html).not.toContain('checked=""');expect(html).toContain("standalone unreviewed evidence cannot create another capacity pool");
 const policy={...raw.governance.policies[0]!.policy,receiptIdentityApprovalGroup:"physical-reviewers"} as BusinessPolicy;expect(renderToStaticMarkup(<APPolicySummary policy={policy}/>)).toContain("physical-reviewers");
});
it("validates shapes before sending and encodes only the case selector, never caller authority",async()=>{
 const fetcher=vi.fn(async(_input:unknown,_init?:RequestInit)=>new Response("{}"));vi.stubGlobal("fetch",fetcher);configureAPSession({mode:"local"});await apSystemApi.physicalLines("case/a");expect(String(fetcher.mock.calls[0]![0])).toContain("caseId=case%2Fa");await apSystemApi.physicalLine("decide",{reviewId:review.reviewId,expectedHash:review.hash,outcome:"rejected",reason:"Exact map rejected"});
 expect(()=>apSystemApi.physicalLine("decide",{reviewId:review.reviewId,expectedHash:review.hash,outcome:"rejected",reason:"Exact map rejected",subject:"forged"} as never)).toThrow();expect(fetcher).toHaveBeenCalledTimes(2);
 expect(()=>physicalLineOperationSchemas.propose.parse({idempotencyKey:"key",proposal:{...review.proposal,physicalLines:view.catalogs[0]!.physicalLines}})).toThrow();
});
