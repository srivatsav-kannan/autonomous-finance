import {afterEach,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {getFunctionName} from "convex/server";
import type {ConvexHttpClient} from "convex/browser";
import {APTaxPolicyEditor,blankTaxRecovery} from "../console/src/APTaxPolicy";
import {APTaxClaimEditor,APTaxClaimSummary} from "../console/src/APTaxClaim";
import {blankTaxDraft,buildTaxClaim,taxDraftFromClaim,taxSourceKey} from "../console/src/apTaxView";
import {APDimensionPolicy,APSettlementPreview,APPaymentDimensions,APExternalDimensions} from "../console/src/APDimensions";
import {buildCostCorrection,reachableCostAccounts} from "../console/src/APCostCorrection";
import {businessPolicySchema,type BusinessPolicy} from "../src/ap-system/domain-contracts";
import {recoverableTaxPolicySchema} from "../src/ap-system/tax-contracts";
import {apUIFixture,uiEvidence} from "./ap-system-ui.fixture";
import {taxEvidenceFixture} from "./ap-system/tax-fixture";
import {acceptanceDraft} from "../console/src/APSystemBusiness";
import {costUIFixture} from "./ap-system-cost-ui.fixture";
import {createAPWorkspaceService} from "../src/ap-system/service";
import {apSystemApi} from "../console/src/apSystemApi";
import {configureAPSession} from "../console/src/apAuthSession";
import raw from "../docs/ap-orchestration/evidence/D2-browser/data.json";
const policy=structuredClone(raw.governance.policies[0]!.policy) as BusinessPolicy;
function taxDetail(){const f=taxEvidenceFixture(),detail=apUIFixture();detail.sources=f.documents;detail.currentSourceBindings=f.documents.map(({sourceId,revision,sha256})=>({sourceId,revision,sha256}));detail.candidate!.lines[0]!.taxCents=770;detail.candidate!.evidence.push({...uiEvidence("tax","native","$7.70"),fieldPath:"lines.line-1.taxCents",source:f.original.source});return{...f,detail};}
afterEach(()=>{configureAPSession(null);vi.unstubAllGlobals();});
it("requires explicit recovery and settlement policy choices; defaults cannot enable either",()=>{
 expect(()=>recoverableTaxPolicySchema.parse(blankTaxRecovery())).toThrow();
 const tax=renderToStaticMarkup(<APTaxPolicyEditor policy={policy} value={blankTaxRecovery()} onChange={()=>{}} disabled={false}/>),dim=renderToStaticMarkup(<APDimensionPolicy onChange={()=>{}} disabled={false}/>);
 for(const html of [tax,dim])expect(html).not.toContain('checked=""');expect(tax).toContain("Review and choose rules");expect(tax).toContain('value="" selected=""');expect(dim).toContain("No dimension policy enabled");
 expect(()=>businessPolicySchema.parse({...policy,dimensions:{version:"ap-gl-dimensions-v1",scope:"cost_and_settlement",departments:["ops"],projects:[]}})).toThrow();
 expect(businessPolicySchema.parse({...policy,dimensions:{version:"ap-gl-dimensions-v1",scope:"cost_and_settlement",settlementDepartment:"homogeneous_approved_department",departments:["ops"],projects:[]}}).dimensions?.scope).toBe("cost_and_settlement");
});
it("keeps all new tax facts, rate, evidence and confirmation blank",()=>{
 const {detail,rule}=taxDetail(),html=renderToStaticMarkup(<APTaxClaimEditor detail={detail} lineId="line-1" netCents={7700} taxCents={770} rule={rule} onChange={()=>{}} disabled={false}/>);
 expect(html).not.toContain('checked=""');expect(html).toContain("Choose calculation");expect(html).toContain("No evidence entered");expect(html).toContain("separately retained");expect(blankTaxDraft().rate).toBe("");expect(blankTaxDraft().eligibility).toEqual([]);expect(()=>buildTaxClaim(blankTaxDraft(),detail,"line-1",770,rule)).toThrow();
});
it("builds only exact original facts and separate eligibility evidence, with no inferred rate",()=>{
 const {detail,rule,claim}=taxDetail(),draft=taxDraftFromClaim(claim);expect(buildTaxClaim(draft,detail,"line-1",770,rule)).toEqual(claim);
 const stated={...claim,calculation:"stated_amount" as const,rateBps:null,facts:{...claim.facts}};delete stated.facts.rate;const result=buildTaxClaim(taxDraftFromClaim(stated),detail,"line-1",770,rule);expect(result.rateBps).toBeNull();expect(result.facts.rate).toBeUndefined();
 draft.facts.tax.end=String(Number(draft.facts.tax.end)+1);expect(()=>buildTaxClaim(draft,detail,"line-1",770,rule)).toThrow(/exact retained text/);
 const wrong=taxDraftFromClaim(claim);wrong.eligibility[0]!.source=taxSourceKey(detail.sources[0]!);expect(()=>buildTaxClaim(wrong,detail,"line-1",770,rule)).toThrow(/exact current source/);
 const excess=taxDraftFromClaim(claim);excess.recoverable="7.71";expect(()=>buildTaxClaim(excess,detail,"line-1",770,rule)).toThrow(/tax_recovery_amount/);
 const stale=structuredClone(detail);stale.currentSourceBindings=[];expect(()=>buildTaxClaim(taxDraftFromClaim(claim),stale,"line-1",770,rule)).toThrow();
});
it("shows tax and cost pools separately and derives settlement only from homogeneous complete allocations",()=>{
 const {claim}=taxDetail(),html=renderToStaticMarkup(<APTaxClaimSummary claim={claim} netCents={7700} taxCents={770}/>);expect(html).toContain("$77.00 / $7.70");expect(html).toContain("separate eligibility citations");
 const a=acceptanceDraft(apUIFixture());a.lines.forEach(l=>l.allocations.forEach(x=>x.department="ops"));const p={...policy,dimensions:{version:"ap-gl-dimensions-v1" as const,scope:"cost_and_settlement" as const,settlementDepartment:"homogeneous_approved_department" as const,departments:["ops","other"],projects:[]}};
 expect(renderToStaticMarkup(<APSettlementPreview acceptance={a} policy={p}/>)).toContain("Department: ops");a.lines[1]!.allocations[0]!.department="other";expect(renderToStaticMarkup(<APSettlementPreview acceptance={a} policy={p}/>)).toContain("empty, mixed or outside");
 expect(renderToStaticMarkup(<APPaymentDimensions/>)).toContain("No department has been inferred");
});
it("preserves department and project on cost corrections and refuses cross-dimension capacity or routes",()=>{
 const state=costUIFixture();for(const rows of [state.originalShares,state.positions,state.corrections])rows.forEach(row=>Object.assign(row,{department:"ops",project:"project-a"}));
 const p={...policy,accounts:[{account:"6000",treatment:"expense" as const},{account:"1200",treatment:"inventory" as const}]};
 const built=buildCostCorrection(state,[{share:0,account:"1200",amount:"5"}],p,[apUIFixture().currentSourceBindings[0]!],"Exact shares");expect(built.allocations[0]).toMatchObject({department:"ops",project:"project-a"});
 state.positions[1]!.project="project-b";expect(()=>buildCostCorrection(state,[{share:0,account:"1200",amount:"5"}],p,[apUIFixture().currentSourceBindings[0]!],"Exact shares")).toThrow(/current corrected cost balance/);state.corrections[0]!.department="other";expect(reachableCostAccounts(state,state.originalShares[0]!)).not.toContain("1200");
});
it("renders returned provider references without inventing mappings or payment project dimensions",()=>{
 const html=renderToStaticMarkup(<APExternalDimensions payload={{DepartmentRef:{value:"location-1"},Line:[{ProjectRef:{value:"project-2"},AccountBasedExpenseLineDetail:{ClassRef:{value:"class-3"},CustomerRef:{value:"customer-4"},BillableStatus:"NotBillable"}}]}}/>);for(const id of ["location-1","project-2","class-3","customer-4"])expect(html).toContain(id);expect(html).toContain("no project is assigned to payment cash");
});
it("preserves opt-in tax and dimensions through controller proposal transport and current-human votes",async()=>{
 const {detail,rule,claim}=taxDetail(),p={...policy,accounts:[...policy.accounts,{account:"1180",treatment:"tax" as const}],groups:[...policy.groups,{groupId:rule.approvalGroupId,members:["tax-reviewer"]}],taxCodes:[{code:"TAX",mode:"recoverable" as const,recovery:rule}],dimensions:{version:"ap-gl-dimensions-v1" as const,scope:"cost_and_settlement" as const,settlementDepartment:"homogeneous_approved_department" as const,departments:["ops"],projects:[]}};
 const agent={mutation:vi.fn(async(_f:unknown,_a:unknown)=>({ok:true}))},human={query:vi.fn(),mutation:vi.fn(async(_f:unknown,_a:unknown)=>({ok:true}))};const service=createAPWorkspaceService({agent:agent as unknown as ConvexHttpClient,human:human as unknown as ConvexHttpClient,scope:detail.scope,apCredential:{seatId:"ap",token:"ap-private"},paymentsCredential:{seatId:"payments",token:"payment-private"},controllerCredential:{seatId:"controller",token:"controller-private"},parseUploads:vi.fn(),runtime:()=>({})});
 await service.domain!.execute("proposePolicy",{idempotencyKey:"tax-policy",policy:p});expect(agent.mutation.mock.calls[0]![1]).toMatchObject({seatId:"controller",scope:detail.scope,policy:p});
 const a=acceptanceDraft(detail);a.reason="Exact source-based treatment";a.lines.forEach(l=>l.taxCode="TAX");a.lines[0]!.tax=claim;a.lines[0]!.taxCode="TAX";await service.domain!.execute("propose",{caseId:detail.caseId,expectedRevision:detail.revision,snapshotHash:detail.snapshotHash,idempotencyKey:"tax-case",policyVersion:p.version,supplierRevision:1,acceptance:a});expect(agent.mutation.mock.calls[1]![1]).toMatchObject({scope:detail.scope,input:{acceptance:{lines:[expect.objectContaining({tax:claim}),expect.anything()]}}});
 const vote={proposalId:"proposal",proposalHash:"a".repeat(64),idempotencyKey:"vote",outcome:"approved" as const,reason:"Independent tax facts reviewed"};await service.domain!.execute("vote",vote);expect(getFunctionName(human.mutation.mock.calls[0]![0] as never)).toBe("apBusiness:vote");expect(human.mutation.mock.calls[0]![1]).toEqual({scope:detail.scope,input:vote});
 const fetcher=vi.fn(async()=>new Response("{}"));vi.stubGlobal("fetch",fetcher);configureAPSession({mode:"local"});await apSystemApi.business("proposePolicy",{idempotencyKey:"tax-policy",policy:p});expect(fetcher).toHaveBeenCalledTimes(1);expect(()=>apSystemApi.business("proposePolicy",{idempotencyKey:"tax-policy",policy:{...p,dimensions:{...p.dimensions,settlementDepartment:undefined}}})).toThrow();
});

it("keeps header bases derived from explicit shares and forbids fabricated printed base/gross facts",async()=>{
 const {taxUIFixture,taxUIText,taxUIHash,eligibilityUIText,eligibilityUIHash}=await import("./ap-system-tax-ui.fixture");const {createHash}=await import("node:crypto");const {validateTaxHeaders}=await import("../console/src/apTaxView");const {detail,claim,rule,acceptance}=taxUIFixture(apUIFixture());
 expect(createHash("sha256").update(taxUIText).digest("hex")).toBe(taxUIHash);expect(createHash("sha256").update(eligibilityUIText).digest("hex")).toBe(eligibilityUIHash);
 const built=buildTaxClaim(taxDraftFromClaim(claim),detail,"line-1",850,rule,acceptance.lines[0]!.headerAllocation);expect(built.taxableBaseCents).toBe(8500);expect(built.originalGrossCents).toBe(9350);expect(built.facts.net?.rawValue).toBe("$77.00");expect(built.facts.base).toBeUndefined();expect(built.facts.gross).toBeUndefined();
 const p={...policy,taxCodes:[{code:"SYNTHETIC-TAX",mode:"recoverable" as const,recovery:rule}]};expect(()=>validateTaxHeaders(detail,acceptance,p)).not.toThrow();acceptance.lines[0]!.headerAllocation!.acceptedFreightCents=999;expect(()=>validateTaxHeaders(detail,acceptance,p)).toThrow(/tax_header_allocation/);
 expect(()=>buildTaxClaim(taxDraftFromClaim(claim),detail,"line-1",850,rule)).toThrow(/explicit original/);
});
it("keeps initial header evidence and all line attribution blank, including explicit zero choices",async()=>{
 const {APTaxHeaderAllocation,APTaxHeaderEvidence,APCreditHeaderAllocation,buildHeaderEvidence}=await import("../console/src/APTaxHeaders"),{taxUIFixture}=await import("./ap-system-tax-ui.fixture");const {detail,acceptance}=taxUIFixture(apUIFixture());const onChange=()=>{};
 for(const html of [renderToStaticMarkup(<APTaxHeaderAllocation onChange={onChange} disabled={false}/>),renderToStaticMarkup(<APTaxHeaderEvidence detail={detail} onChange={onChange} disabled={false}/>),renderToStaticMarkup(<APCreditHeaderAllocation original={acceptance.lines[0]!.headerAllocation!} onChange={onChange} disabled={false}/>)]){expect(html).not.toContain('checked=""');expect(html).not.toContain('value="0.00"');}
 const {citationDraft}=await import("../console/src/apTaxView");const drafts={freight:citationDraft(acceptance.taxHeaderEvidence!.freight!),discount:citationDraft(acceptance.taxHeaderEvidence!.discount!)};
 expect(buildHeaderEvidence(detail,{freight:true,discount:true},drafts)).toEqual(acceptance.taxHeaderEvidence);expect(()=>buildHeaderEvidence(detail,{freight:false,discount:true},drafts)).toThrow(/original freight/);
});
