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
const contactMode=fixtureMode?.startsWith("contacts")??false;
const parsedCases=caseDetailSchema.array().parse(raw.cases),cases=contactMode?withContactUIEvidence(parsedCases):parsedCases,run=structuredClone(raw.run);
const governance=structuredClone(raw.governance) as unknown as GovernanceView;
if(contactMode)governance.policies.forEach(p=>p.policy.supplierContactEscalationGroup=p.policy.varianceApprovalGroup);
const contacts=contactMode?contactUIFixture(governance,cases):{changes:[],contacts:[],suppliers:[],controllerProposalAvailable:true};
if(contactMode&&["contacts-escalation","contacts-decision","contacts-rejected"].includes(fixtureMode!)){const c=contacts.changes[0]!;c.verification={method:"independent_reestablishment",performedAt:c.createdAt+60000,evidence:c.proposal.oldChannel.evidence,mode:"simulated",reason:"Synthetic verification example; no real communication",subject:"synthetic-verifier",seatId:"synthetic-verifier",recordedAt:c.createdAt+60000};if(fixtureMode==="contacts-decision")c.escalation={...c.verification,subject:"synthetic-escalator",seatId:"synthetic-escalator",reason:"Synthetic escalation example",performedAt:c.createdAt+120000,recordedAt:c.createdAt+120000};if(fixtureMode==="contacts-rejected"){c.status="rejected";c.decision={subject:"synthetic-approver",seatId:"synthetic-approver",outcome:"rejected",reason:"Synthetic rejection keeps the hold",recordedAt:c.createdAt+180000};}}
if(creditMode){const c=cases.find(c=>c.caseId==="synthetic-approved")!;if(c.domain)c.domain.creditApplications=[2500,2775].map((amountCents,i)=>({applicationId:`synthetic-application-${i===0?"a":"b"}`,billId:c.links.billId!,creditId:`synthetic-credit-${i}`,amountCents,actor:"synthetic-human",at:1792886400000}));}
let action="No fixture action yet.";
// This fixture owns its entire mocked transport. It never forwards requests.
configureAPSession({mode:"local"});
window.fetch=async(input,init)=>{
 const url=new URL(String(input),location.href),path=url.pathname.replace('/api/ap-system','');
 const reply=(value:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}}));
 if(path.startsWith("/sources/synthetic-contact-evidence/"))return new Response(contactUISourceText,{headers:{"Content-Type":"text/plain"}});
 if(path==="/supplier-contacts"&&init?.method!=="POST")return reply(contacts);
 if(path.startsWith("/supplier-contacts/")){action=`Synthetic fixture only: ${path}. No backend or supplier communication.`;window.dispatchEvent(new Event("fixture-action"));return reply({error:{code:"fixture_review_stage",reason:"This presentation fixture keeps immutable stage examples. Use contacts-escalation, contacts-decision or contacts-rejected to inspect another stage; no decision was recorded."}},409);}
 if(path.startsWith("/close/accounting/")){
  const selection=JSON.parse(String(init?.body??"{}"));
  if(path.endsWith("/status"))return reply({externalWritesAllowed:false,configuration:"configured",grant:"authorization_required",mappings:"configured",exportId:"accrual:synthetic-accrual-journal",receipts:[],holds:[],complete:true,externalVerification:"not_checked"});
  if(path.endsWith("/preview")){const plan=correctionPlanFixture();plan.links={...plan.links,caseId:null,billId:null,correctionId:undefined,closeExportId:"accrual:synthetic-accrual-journal",closeJournalId:"synthetic-accrual-journal",closeActionId:selection.request?.actionId};plan.payload={TxnDate:"2026-10-18",Line:[{Amount:20,JournalEntryLineDetail:{PostingType:"Debit",AccountRef:{value:"synthetic-cost"}}},{Amount:20,JournalEntryLineDetail:{PostingType:"Credit",AccountRef:{value:"synthetic-accrued-liability"}}}]};return reply({plan,planHash:"8".repeat(64),externalWrites:0});}
  return reply({error:{code:"fixture_no_external_write",reason:"Synthetic fixture external writes and readback are disabled."}},403);
 }
 if(init?.method==="POST"){action=`Synthetic only: ${path}. No backend or external request sent.`;window.dispatchEvent(new Event("fixture-action"));if(path==="/payment-runs")return reply({runId:run.runId,snapshotHash:run.snapshotHash});if(path.endsWith("/authorize")){run.items.forEach(i=>i.payment.status="queued");return reply({commandIds:["synthetic-command-a","synthetic-command-b"]});}if(path.endsWith("/cancel")){run.items.forEach(i=>i.payment.status="cancelled");return reply({ok:true});}if(path.startsWith("/business/")||path.startsWith("/close/")||path.includes("/corrections/"))return reply({ok:true});if(correctionMode&&path.endsWith("/accounting/preview"))return reply({plan:creditMode?creditCorrectionPlanFixture(path.split("/")[2]):correctionPlanFixture(path.split("/")[2]),planHash:"f".repeat(64),externalWrites:0});return reply({error:{code:"fixture_read_only",reason:"This fixture does not simulate accounting or bank writes."}},409);}
 if(path.startsWith("/close/cost-state/"))return reply(costUIFixture(decodeURIComponent(path.split("/").at(-1)!)));
 if(path.startsWith("/close/"))return reply(closeUIFixture());
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
function Fixture(){const[theme,setTheme]=useState("light"),[last,setLast]=useState(action);useEffect(()=>{const update=()=>setLast(action);window.addEventListener("fixture-action",update);return()=>window.removeEventListener("fixture-action",update);},[]);return <main className="d2-fixture" style={theme==="dark"?{...dark,colorScheme:"dark"}:undefined}><header className="d2-fixture-controls"><strong>Synthetic D2 business UI fixture</strong><p>All cases, human identities, approvals, bank destinations and requests on this page are synthetic. No backend, identity provider, bank or QuickBooks action is connected.</p><label>Fixture palette<select value={theme} onChange={e=>setTheme(e.target.value)}><option>light</option><option>dark</option></select></label><p role="status">{last}</p></header><APSystemWorkspace/></main>;}
const root=import.meta.hot?.data.root??createRoot(document.getElementById("root")!);if(import.meta.hot){import.meta.hot.data.root=root;import.meta.hot.accept();}root.render(<Fixture/>);
