import {afterEach,expect,it,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import type {BusinessPolicy} from "../src/ap-system/domain-contracts";
import {taxPositionKey} from "../src/ap-system/tax-adjustment-contracts";
import {APTaxAdjustmentEditor} from "../console/src/APTaxAdjustment";
import {APTaxCreditEditor} from "../console/src/APTaxCreditReversal";
import {APTaxPolicyEditor,blankTaxRecovery} from "../console/src/APTaxPolicy";
import {buildTaxAdjustment,buildTaxReversal,reviewedTaxBuckets} from "../console/src/apTaxAdjustmentView";
import {citationDraft} from "../console/src/apTaxView";
import {apUIFixture} from "./ap-system-ui.fixture";
import {taxAdjustmentUIFixture} from "./ap-system-tax-adjustment-ui.fixture";
import raw from "../docs/ap-orchestration/evidence/D2-browser/data.json";
const fixture=()=>taxAdjustmentUIFixture(apUIFixture(),raw.governance.policies[0]!.policy as BusinessPolicy);
function input(){const f=fixture(),doc=f.adjustmentDocument;return{...f,attribution:[],targets:{"line-1":"4.25"},movements:[{bucket:taxPositionKey(f.state.buckets[0]!),account:f.cost.originalShares[0]!.account,amount:"4.25"}],citations:[citationDraft({source:{sourceId:doc.sourceId,revision:doc.revision,sha256:doc.sha256},page:1,start:0,end:doc.extractedText.trim().length,quote:doc.extractedText.trim(),rawValue:doc.extractedText.trim()})],documents:f.detail.sources,date:"2026-10-31",period:"2026-10",reason:"Synthetic independently supported eligibility change"};}
afterEach(()=>vi.restoreAllMocks());
it("leaves targets, movements, attribution, citations and confirmation blank in new tax workflows",()=>{
 const f=fixture(),html=renderToStaticMarkup(<APTaxAdjustmentEditor state={f.state} cost={f.cost} policy={f.policy} documents={f.detail.sources} period="2026-10" busy={false} onSubmit={async()=>true}/>);
 expect(html).not.toContain('checked=""');expect(html).not.toContain('value="4.25"');expect(html).toContain("Add independent eligibility citation");expect(html).toContain('disabled="">Propose tax adjustment');
 const policy=renderToStaticMarkup(<APTaxPolicyEditor value={blankTaxRecovery()} policy={f.policy} onChange={()=>{}} disabled={false}/>);expect(policy).toContain('value="" selected="">No adjustment policy enabled');
 const credit=renderToStaticMarkup(<APTaxCreditEditor state={{...f.state,adjusted:true}} items={[{originalLineId:"line-1",taxCents:0}]} context="one" busy={false} onChange={()=>{}}/>);expect(credit).not.toContain('checked=""');expect(credit).toContain("zero-tax credit still requires explicit review");expect(credit).toContain('disabled="">Use reviewed tax reversal');
});
it("binds exact cost/tax snapshots and immutable original dimensions, and moves only explicit cents",()=>{
 const f=input(),action=buildTaxAdjustment(f);expect(action).toMatchObject({kind:"tax_adjustment",originalEntryId:f.state.originalEntryId,originalApprovalId:f.state.originalApprovalId,costSnapshotHash:f.cost.snapshotHash,taxSnapshotHash:f.state.snapshotHash,initialAttribution:[],targets:[{originalLineId:"line-1",recoverableCents:425}],movements:[{from:{amountCents:425,department:"ops",project:null},toAccount:f.cost.originalShares[0]!.account}]});expect(action.eligibilityEvidence[0]!.source.sha256).toBe(f.adjustmentDocument.sha256);
 const changed=input();changed.cost.snapshotHash="d".repeat(64);expect(()=>buildTaxAdjustment(changed)).toThrow(/snapshots differ/);
 const stale=input();stale.date="2026-10-18";expect(()=>buildTaxAdjustment(stale)).toThrow(/latest included/);
 const mismatched=input();mismatched.targets["line-1"]="4.24";expect(()=>buildTaxAdjustment(mismatched)).toThrow(/explicit effective policy/);
 const incomplete=input();incomplete.movements[0]!.amount="4.24";expect(()=>buildTaxAdjustment(incomplete)).toThrow(/achieve every/);
});
it("refuses wrong source material, missing opt-in, duplicate bucket consumption and cross-dimension capacity",()=>{
 const wrong=input();wrong.citations[0]!.source=`${wrong.detail.sources[0]!.sourceId}:1:${wrong.detail.sources[0]!.sha256}`;expect(()=>buildTaxAdjustment(wrong)).toThrow();
 const missing=input();delete missing.policy.taxCodes[0]!.recovery!.adjustments;expect(()=>buildTaxAdjustment(missing)).toThrow(/explicit current/);
 const used=input();used.movements.push({...used.movements[0]!});used.movements[0]!.amount="5.00";expect(()=>buildTaxAdjustment(used)).toThrow(/existing bucket/);
 const dim=input();dim.cost.positions.find(p=>p.account==="1180")!.department="other";expect(()=>buildTaxAdjustment(dim)).toThrow(/posted account and dimension/);
 const span=input();span.citations[0]!.end=String(Number(span.citations[0]!.end)+1);expect(()=>buildTaxAdjustment(span)).toThrow(/exact retained text/);
});
it("requires exact original nonrecoverable attribution and preserves corrected cost lineage",()=>{
 const f=input();f.state.buckets[0]!.amountCents=425;f.state.lines[0]!.unattributedCostCents=425;f.cost.positions[0]!.balanceCents+=425;f.cost.positions[1]!.balanceCents-=425;
 expect(()=>reviewedTaxBuckets(f.state,f.cost,f.policy,[],f.documents,f.reason)).toThrow(/every remaining/);
 const result=reviewedTaxBuckets(f.state,f.cost,f.policy,[{share:0,account:f.cost.originalShares[0]!.account,amount:"4.25"}],f.documents,f.reason);expect(result.attribution[0]).toMatchObject({originalLineId:"line-1",allocationIndex:0,department:"ops",amountCents:425});
 expect(()=>reviewedTaxBuckets(f.state,f.cost,f.policy,[{share:0,account:"1200",amount:"4.25"}],f.documents,f.reason)).toThrow(/reachable/);
 f.state.adjusted=true;expect(()=>reviewedTaxBuckets(f.state,f.cost,f.policy,[{share:0,account:f.cost.originalShares[0]!.account,amount:"4.25"}],f.documents,f.reason)).toThrow(/immutable/);
});
it("requires explicit adjusted credit shares, exact cumulative rounding, and supports reviewed zero-tax plans",()=>{
 const f=fixture(),s=f.state;s.adjusted=true;s.buckets[0]!.amountCents=425;s.buckets.push({...s.buckets[0]!,account:f.cost.originalShares[0]!.account,treatment:"expense",amountCents:425});s.lines[0]!.creditBasisRecoverableCents=425;
 const tax=taxPositionKey(s.buckets[0]!),cost=taxPositionKey(s.buckets[1]!);const result=buildTaxReversal(s,[{originalLineId:"line-1",taxCents:101}],[{bucket:tax,amount:"0.51"},{bucket:cost,amount:"0.50"}],"Exact one-cent rounding reviewed");expect(result.allocations.map(a=>a.amountCents)).toEqual([51,50]);expect(result.snapshotHash).toBe(s.snapshotHash);
 expect(()=>buildTaxReversal(s,[{originalLineId:"line-1",taxCents:101}],[{bucket:tax,amount:"0.50"},{bucket:cost,amount:"0.51"}],"Wrong rounding")).toThrow(/cumulative rounding/);
 expect(buildTaxReversal(s,[{originalLineId:"line-1",taxCents:0}],[],"Reviewed empty tax allocation").allocations).toEqual([]);
 expect(()=>buildTaxReversal(s,[{originalLineId:"other",taxCents:0}],[{bucket:tax,amount:"0.01"}],"Wrong line")).toThrow(/credited line/);
 expect(()=>buildTaxReversal({...s,adjusted:false},[],[],"Wrong state")).toThrow(/no posted tax adjustment/);
});
