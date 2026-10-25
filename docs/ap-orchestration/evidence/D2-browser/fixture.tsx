import {taxAdjustmentUIFixture} from "../../../../tests/ap-system-tax-adjustment-ui.fixture";
import {APTaxAdjustment} from "../../../../console/src/APTaxAdjustment";
import {taxUIFixture,taxUIText,eligibilityUIText} from "../../../../tests/ap-system-tax-ui.fixture";
import {physicalUIFixture,physicalUIText} from "../../../../tests/ap-system-physical-ui.fixture";
import {contactUIFixture,withContactUIEvidence,contactUISourceText} from "../../../../tests/ap-system-contact-ui.fixture";
import type {GovernanceView} from "../../../../src/ap-system/domain-operations";
import {timingUIFixture} from "../../../../tests/ap-system-timing-ui.fixture";
import {costUIFixture} from "../../../../tests/ap-system-cost-ui.fixture";
import {useState,useEffect,type CSSProperties} from "react";
import {createRoot} from "react-dom/client";
import {APSystemWorkspace} from "../../../../console/src/APSystemWorkspace";
import {configureAPSession} from "../../../../console/src/apAuthSession";
import {caseDetailSchema} from "../../../../src/ap-system/contracts";
import {correctionUIFixture,correctionPlanFixture,creditApplicationUIFixture,creditCorrectionUIFixture,creditCorrectionPlanFixture} from "../../../../tests/ap-system-correction-ui.fixture";
import {closeUIFixture} from "../../../../tests/ap-system-close-ui.fixture";
import raw from "./data.json";
import "../../../../console/src/styles.css";
import "../../../../console/src/apSystem.css";
import tokens from "../../../../console/src/tokens.css?raw";
import "./fixture.css";
const fixtureMode=new URLSearchParams(location.search).get("apFixture"),creditMode=fixtureMode==="credit-allocation"||fixtureMode==="credit-review",correctionMode=creditMode||fixtureMode==="corrections"||fixtureMode==="correction-review";
const taxMode=fixtureMode?.startsWith("tax")??false;
const physicalMode=fixtureMode?.startsWith("physical")??false;
const contactMode=fixtureMode?.startsWith("contacts")??false;
const parsedCases=caseDetailSchema.array().parse(raw.cases),cases=contactMode?withContactUIEvidence(parsedCases):parsedCases,run=structuredClone(raw.run);
const governance=structuredClone(raw.governance) as unknown as GovernanceView;
if(contactMode)governance.policies.forEach(p=>p.policy.supplierContactEscalationGroup=p.policy.varianceApprovalGroup);
if(physicalMode)governance.policies.forEach(p=>p.policy.receiptIdentityApprovalGroup=p.policy.varianceApprovalGroup);
const physical=physicalUIFixture(cases[0]!,governance.policies[0]!.hash);
if(physicalMode){cases[0]=physical.detail;const domain=cases[0]!.domain!;domain.approvalStatus="not_proposed";domain.approvalId=null;domain.approvalHash=null;domain.acceptance=null;domain.route=[];domain.stage=0;domain.votes=[];}
if(fixtureMode==="physical-review"){const review=physical.view.reviews[0]!;review.status="proposed";review.decision=null;}
if(fixtureMode==="physical-initial"){const review=physical.view.reviews[0]!;review.status="proposed";review.decision=null;review.catalogId=null;review.proposal={...review.proposal,catalogId:undefined,physicalLines:physical.view.catalogs[0]!.physicalLines};physical.view.catalogs=[];}
if(taxMode){const tax=taxUIFixture(cases[0]!);cases[0]=tax.detail;const p=governance.policies[0]!.policy;p.accounts.push({account:"1180",treatment:"tax"});p.taxCodes=[...p.taxCodes.filter(t=>t.code!=="SYNTHETIC-TAX"),{code:"SYNTHETIC-TAX",mode:"recoverable",recovery:tax.rule}];p.groups.push({groupId:"synthetic-tax-review",members:["synthetic-tax-reviewer"]});p.dimensions={version:"ap-gl-dimensions-v1",scope:"cost_and_settlement",settlementDepartment:"homogeneous_approved_department",departments:["ops"],projects:["synthetic-project"]};const d=tax.detail.domain!;d.approvalStatus=fixtureMode==="tax-review"?"pending":"not_proposed";d.acceptance=fixtureMode==="tax-review"?tax.acceptance:null;d.approvalId=fixtureMode==="tax-review"?"synthetic-tax-proposal":null;d.approvalHash=fixtureMode==="tax-review"?"d".repeat(64):null;d.route=fixtureMode==="tax-review"?[{groupId:"synthetic-tax-review",quorum:1,escalationGroupId:null,escalateAfterMs:3600000}]:[];d.stage=0;d.votes=[];}
const taxChange=fixtureMode==="tax-adjustment"?taxAdjustmentUIFixture(cases[0]!,governance.policies[0]!.policy):undefined;
const taxChangeView=closeUIFixture();
if(taxChange){cases[0]=taxChange.detail;governance.policies[0]!.policy=taxChange.policy;taxChangeView.retainedSources=taxChange.detail.sources.map(({sourceId,revision,sha256,name,kind,pageStatus})=>({sourceId,revision,sha256,name,kind,pageStatus}));}
const contacts=contactMode?contactUIFixture(governance,cases):{changes:[],contacts:[],suppliers:[],controllerProposalAvailable:true};
if(contactMode&&["contacts-escalation","contacts-decision","contacts-rejected"].includes(fixtureMode!)){const c=contacts.changes[0]!;c.verification={method:"independent_reestablishment",performedAt:c.createdAt+60000,evidence:c.proposal.oldChannel.evidence,mode:"simulated",reason:"Synthetic verification example; no real communication",subject:"synthetic-verifier",seatId:"synthetic-verifier",recordedAt:c.createdAt+60000};if(fixtureMode==="contacts-decision")c.escalation={...c.verification,subject:"synthetic-escalator",seatId:"synthetic-escalator",reason:"Synthetic escalation example",performedAt:c.createdAt+120000,recordedAt:c.createdAt+120000};if(fixtureMode==="contacts-rejected"){c.status="rejected";c.decision={subject:"synthetic-approver",seatId:"synthetic-approver",outcome:"rejected",reason:"Synthetic rejection keeps the hold",recordedAt:c.createdAt+180000};}}
if(creditMode){const c=cases.find(c=>c.caseId==="synthetic-approved")!;if(c.domain)c.domain.creditApplications=[2500,2775].map((amountCents,i)=>({applicationId:`synthetic-application-${i===0?"a":"b"}`,billId:c.links.billId!,creditId:`synthetic-credit-${i}`,amountCents,actor:"synthetic-human",at:1792886400000}));}
let action="No fixture action yet.";
// This fixture owns its entire mocked transport. It never forwards requests.
configureAPSession({mode:"local"});
window.fetch=async(input,init)=>{
 const url=new URL(String(input),location.href),path=url.pathname.replace('/api/ap-system','');
 const reply=(value:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}}));
 if(taxChange&&path.startsWith("/sources/synthetic-tax-change-support/"))return new Response(taxChange.adjustmentDocument.extractedText,{headers:{"Content-Type":"text/plain"}});
 if(path.startsWith("/sources/synthetic-tax-invoice/"))return new Response(taxUIText,{headers:{"Content-Type":"text/plain"}});
 if(path.startsWith("/sources/synthetic-tax-eligibility/"))return new Response(eligibilityUIText,{headers:{"Content-Type":"text/plain"}});
 if(taxMode&&init?.method==="POST"&&path.startsWith("/business/"))return reply({error:{code:"fixture_review_only",reason:"Synthetic tax form only. No policy, tax eligibility or approval was recorded."}},409);
 if(path.startsWith("/sources/synthetic-physical-receipt/"))return new Response(physicalUIText,{headers:{"Content-Type":"text/plain"}});
 if(path==="/physical-lines"&&init?.method!=="POST")return reply(physicalMode?{...physical.view,reviews:physical.view.reviews.filter(r=>!url.searchParams.get("caseId")||r.caseId===url.searchParams.get("caseId"))}:{catalogs:[],reviews:[],controllerProposalAvailable:true});
 if(path.startsWith("/physical-lines/"))return reply({error:{code:"fixture_review_stage",reason:"Synthetic stage example only. No identity decision or capacity was created. Use physical, physical-review or physical-initial to inspect a stage."}},409);
 if(path.startsWith("/sources/synthetic-contact-evidence/"))return new Response(contactUISourceText,{headers:{"Content-Type":"text/plain"}});
 if(path==="/supplier-contacts"&&init?.method!=="POST")return reply(contacts);
 if(path.startsWith("/supplier-contacts/")){action=`Synthetic fixture only: ${path}. No backend or supplier communication.`;window.dispatchEvent(new Event("fixture-action"));return reply({error:{code:"fixture_review_stage",reason:"This presentation fixture keeps immutable stage examples. Use contacts-escalation, contacts-decision or contacts-rejected to inspect another stage; no decision was recorded."}},409);}
 if(path.startsWith("/close/accounting/")){
  const selection=JSON.parse(String(init?.body??"{}"));
  if(path.endsWith("/status"))return reply({externalWritesAllowed:false,configuration:"configured",grant:"authorization_required",mappings:"configured",exportId:"accrual:synthetic-accrual-journal",receipts:[],holds:[],complete:true,externalVerification:"not_checked"});
  if(path.endsWith("/preview")){const plan=correctionPlanFixture();plan.links={...plan.links,caseId:null,billId:null,correctionId:undefined,closeExportId:"accrual:synthetic-accrual-journal",closeJournalId:"synthetic-accrual-journal",closeActionId:selection.request?.actionId};plan.payload={TxnDate:"2026-10-18",Line:[{Amount:20,JournalEntryLineDetail:{PostingType:"Debit",AccountRef:{value:"synthetic-cost"}}},{Amount:20,JournalEntryLineDetail:{PostingType:"Credit",AccountRef:{value:"synthetic-accrued-liability"}}}]};return reply({plan,planHash:"8".repeat(64),externalWrites:0});}
  return reply({error:{code:"fixture_no_external_write",reason:"Synthetic fixture external writes and readback are disabled."}},403);
 }
 if(taxMode&&init?.method==="POST"&&path.startsWith("/close/"))return reply({error:{code:"fixture_review_only",reason:"Synthetic tax component only. No proposal or approval was recorded."}},409);
 if(init?.method==="POST"){action=`Synthetic only: ${path}. No backend or external request sent.`;window.dispatchEvent(new Event("fixture-action"));if(path==="/payment-runs")return reply({runId:run.runId,snapshotHash:run.snapshotHash});if(path.endsWith("/authorize")){run.items.forEach(i=>i.payment.status="queued");return reply({commandIds:["synthetic-command-a","synthetic-command-b"]});}if(path.endsWith("/cancel")){run.items.forEach(i=>i.payment.status="cancelled");return reply({ok:true});}if(path.startsWith("/business/")||path.startsWith("/close/")||path.includes("/corrections/"))return reply({ok:true});if(correctionMode&&path.endsWith("/accounting/preview"))return reply({plan:creditMode?creditCorrectionPlanFixture(path.split("/")[2]):correctionPlanFixture(path.split("/")[2]),planHash:"f".repeat(64),externalWrites:0});return reply({error:{code:"fixture_read_only",reason:"This fixture does not simulate accounting or bank writes."}},409);}
 if(path.startsWith("/close/tax-state/"))return taxChange?reply(taxChange.state):reply({error:{code:"fixture_unavailable",reason:"No tax adjustment state in this fixture."}},503);
 if(taxChange&&path.startsWith("/close/cost-state/"))return reply(taxChange.cost);
 if(path.startsWith("/close/cost-state/"))return reply(costUIFixture(decodeURIComponent(path.split("/").at(-1)!)));
 if(path.startsWith("/close/")){const close=closeUIFixture();if(physicalMode){const source=physical.detail.sources.find(s=>s.sourceId==="synthetic-physical-receipt")!;close.retainedSources.push({sourceId:source.sourceId,revision:source.revision,sha256:source.sha256,name:source.name,kind:source.kind,pageStatus:source.pageStatus});}return reply(close);}
 if(path==="/cases")return reply(cases);
 if(path==="/metrics")return reply(timingUIFixture(cases));
 if(path==="/business")return reply({...governance,policies:governance.policies.map(p=>({...p,policy:{...p.policy,accounts:[...p.policy.accounts,{account:"6000",treatment:"expense"},{account:"1200",treatment:"inventory"}]}}))});
 if(path==="/payment-runs")return reply([{runId:run.runId,snapshotHash:run.snapshotHash,caseIds:run.items.map(i=>i.caseId),executionDate:run.executionDate,createdAt:run.createdAt}]);
 if(path===`/payment-runs/${run.runId}`)return reply(run);
 if(path.includes("/credit-applications/"))return reply(creditApplicationUIFixture(cases.find(c=>c.caseId===path.split("/")[2])?.links.billId??"missing"));
 if(path.endsWith("/corrections")){const proposal=correctionUIFixture(path.split("/")[2]);return reply({proposals:creditMode?[{...proposal,status:"approved"},{...creditCorrectionUIFixture(path.split("/")[2]),status:fixtureMode==="credit-allocation"?"approved":"pending"}]:correctionMode?[{...proposal,status:fixtureMode==="corrections"?"approved":"pending"}]:[],controllerProposalAvailable:true});}
 if(path.endsWith("/accounting"))return reply({provider:"QuickBooks Online",environment:"sandbox",configuration:correctionMode?"configured":"not_configured",grant:"authorization_required",mappings:correctionMode?"configured":"missing",externalVerification:"not_checked",receipts:[],holds:[],authority:correctionMode?"verified":"not_recognized",complete:true,externalWritesAllowed:false});
 const c=cases.find(c=>path===`/cases/${c.caseId}`);if(c)return reply(c);
 return reply({error:{code:"fixture_unavailable",reason:"This synthetic fixture does not provide original raster or external provider data."}},503);
};
const darkBlock=tokens.split("@media (prefers-color-scheme: dark)")[1]??"",dark=Object.fromEntries([...darkBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m=>[m[1],m[2]])) as CSSProperties;
function Fixture(){const[theme,setTheme]=useState("light"),[last,setLast]=useState(action);useEffect(()=>{const update=()=>setLast(action);window.addEventListener("fixture-action",update);return()=>window.removeEventListener("fixture-action",update);},[]);return <main className="d2-fixture" style={theme==="dark"?{...dark,colorScheme:"dark"}:undefined}><header className="d2-fixture-controls"><strong>Synthetic D2 business UI fixture</strong><p>All cases, human identities, approvals, bank destinations and requests on this page are synthetic. No backend, identity provider, bank or QuickBooks action is connected.</p><label>Fixture palette<select value={theme} onChange={e=>setTheme(e.target.value)}><option>light</option><option>dark</option></select></label><p role="status">{last}</p></header><>{taxChange?<section className="aps-app aps-section"><h2>Synthetic tax adjustment component</h2><p>No complete economic case or approval journey is claimed.</p><APTaxAdjustment view={taxChangeView} cases={[taxChange.detail]} policy={taxChange.policy} busy={false} onSubmit={async()=>{action="Synthetic component only: proposal not recorded.";window.dispatchEvent(new Event("fixture-action"));return false;}}/></section>:<APSystemWorkspace/>}</></main>;}
const root=import.meta.hot?.data.root??createRoot(document.getElementById("root")!);if(import.meta.hot){import.meta.hot.data.root=root;import.meta.hot.accept();}root.render(<Fixture/>);
