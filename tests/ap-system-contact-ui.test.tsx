import {createHash} from "node:crypto";
import {afterEach,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {ContactRegistration,ContactProposalEditor,ContactReviewForm,ContactChangeRecord,buildContactProposal,contactChangeCurrent,contactEvidenceCases} from "../console/src/APSystemContacts";
import {APPolicySummary} from "../console/src/APSystemGovernance";
import {apSystemApi} from "../console/src/apSystemApi";
import {configureAPSession} from "../console/src/apAuthSession";
import {apUIFixture} from "./ap-system-ui.fixture";
import {contactUIFixture,withContactUIEvidence,contactUISourceHash,contactUISourceText} from "./ap-system-contact-ui.fixture";
import type {GovernanceView} from "../src/ap-system/domain-operations";
import raw from "../docs/ap-orchestration/evidence/D2-browser/data.json";
const governance=raw.governance as unknown as GovernanceView,cases=withContactUIEvidence([apUIFixture()]),view=contactUIFixture(governance,cases),save=async()=>true;
afterEach(()=>{configureAPSession(null);vi.unstubAllGlobals();});
it("starts registration, verification and final decisions without preselected evidence, dates or confirmation",()=>{
 const registration=renderToStaticMarkup(<ContactRegistration cases={cases} busy={false} save={save}/>),review=renderToStaticMarkup(<ContactReviewForm row={view.changes[0]!} operation="verify" cases={cases} busy={false} save={save}/>),record=renderToStaticMarkup(<ContactChangeRecord row={view.changes[0]!} view={view} governance={governance} cases={cases} busy={false} save={save}/>);
 for(const html of [registration,review,record])expect(html).not.toContain('checked=""');
 expect(registration).toContain("Legacy onboarding only");expect(registration).toContain("cannot establish a replacement");expect(review).toContain('value=""');expect(review).toContain("Choose the action actually performed");expect(review).toContain("Local simulation only");expect(record).toContain("Approval waits for verification");expect(record).toContain("Reject and retain the hold");expect(record).toContain("No final decision recorded");
});
it("binds proposals to the current supplier/contact and requires explicit supersession for restoration",()=>{
 const draft={supplierId:view.suppliers[0]!.supplierId,resolution:"retain_current" as const,newContactId:"ignored",oldStatus:"available" as const,evidence:[cases[0]!.currentSourceBindings[0]!],oldReason:"Old channel independently confirmed",reason:"Restore after rejected request",supersede:false};
 expect(()=>buildContactProposal(draft,view,governance)).toThrow(/Explicitly confirm/);const proposal=buildContactProposal({...draft,supersede:true},view,governance);expect(proposal.oldContactId).toBe(proposal.newContactId);expect(proposal.supersedesChangeId).toBe("synthetic-contact-change");expect(proposal.expectedRevision).toBe(view.suppliers[0]!.activeRevision);
 expect(contactChangeCurrent(view.changes[0]!,view,governance)).toBe(true);expect(contactChangeCurrent({...view.changes[0]!,policyHash:"f".repeat(64)},view,governance)).toBe(false);
 const html=renderToStaticMarkup(<ContactProposalEditor view={{...view,controllerProposalAvailable:false}} governance={governance} cases={cases} busy={false} save={save}/>);expect(html).toContain("controller agent is not configured");expect(html).not.toContain('checked=""');
});
it("excludes invoice/credit originals and same-hash relabeling from evidence pickers",()=>{
 const c=apUIFixture(),source=c.sources[0]!;c.sources.push({...source,sourceId:"renamed",kind:"contract"});expect(contactEvidenceCases([c])[0]!.sources).toEqual([]);
});
it("keeps rejection holds, approval recertification and no-transfer implications explicit",()=>{
 const rejected=renderToStaticMarkup(<ContactChangeRecord row={{...view.changes[0]!,status:"rejected"}} view={view} governance={governance} cases={cases} busy={false} save={save}/>),approved=renderToStaticMarkup(<ContactChangeRecord row={{...view.changes[0]!,status:"approved"}} view={view} governance={governance} cases={cases} busy={false} save={save}/>);
 expect(rejected).toContain("Rejection keeps the hold");expect(approved).toContain("A new supplier revision still needs independent verification");expect(approved).toContain("Possible sends keep their original reconciliation path");expect(renderToStaticMarkup(<APPolicySummary policy={governance.policies[0]!.policy}/>)).toContain("Contact escalation group");
});
it("uses authenticated endpoints and validates operation bodies before any request",async()=>{
 const fetcher=vi.fn(async()=>new Response("{}"));vi.stubGlobal("fetch",fetcher);configureAPSession({mode:"local"});await apSystemApi.supplierContacts();await apSystemApi.contactChange("decide",{changeId:"change",expectedHash:"a".repeat(64),outcome:"rejected",reason:"Exact proposal rejected"});expect(fetcher.mock.calls).toHaveLength(2);expect(()=>apSystemApi.contactChange("decide",{changeId:"change",expectedHash:"a".repeat(64),outcome:"rejected",reason:"Rejected",subject:"forged"} as never)).toThrow();expect(fetcher.mock.calls).toHaveLength(2);
});

it("uses exact synthetic evidence bytes and separates verification, escalation and final approval stages",()=>{
 expect(createHash("sha256").update(contactUISourceText).digest("hex")).toBe(contactUISourceHash);expect(contactUISourceText).toContain(view.contacts[1]!.phone);
 const pending=view.changes[0]!,review={method:"independent_reestablishment" as const,performedAt:pending.createdAt+60000,evidence:pending.proposal.oldChannel.evidence,mode:"simulated" as const,reason:"Synthetic recorded review",subject:"synthetic-verifier",seatId:"synthetic-verifier",recordedAt:pending.createdAt+60000};
 const html=renderToStaticMarkup(<ContactChangeRecord row={{...pending,verification:review}} view={view} governance={governance} cases={cases} busy={false} save={save}/>);expect(html).toContain("Record separate escalation review");expect(html).not.toContain("Record independent verification");expect(html).toContain("Approval waits for verification and any required separate escalation");expect(html).not.toContain('checked=""');
});
