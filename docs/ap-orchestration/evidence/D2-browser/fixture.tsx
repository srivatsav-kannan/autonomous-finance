import {useState,useEffect,type CSSProperties} from "react";
import {createRoot} from "react-dom/client";
import {APSystemWorkspace} from "../../../../console/src/APSystemWorkspace";
import {configureAPSession} from "../../../../console/src/apAuthSession";
import {caseDetailSchema} from "../../../../src/ap-system/contracts";
import {correctionUIFixture,correctionPlanFixture} from "../../../../tests/ap-system-correction-ui.fixture";
import {closeUIFixture} from "../../../../tests/ap-system-close-ui.fixture";
import raw from "./data.json";
import "../../../../console/src/styles.css";
import "../../../../console/src/apSystem.css";
import tokens from "../../../../console/src/tokens.css?raw";
import "./fixture.css";
const fixtureMode=new URLSearchParams(location.search).get("apFixture"),correctionMode=fixtureMode==="corrections"||fixtureMode==="correction-review";
const cases=caseDetailSchema.array().parse(raw.cases),run=structuredClone(raw.run);
let action="No fixture action yet.";
// This fixture owns its entire mocked transport. It never forwards requests.
configureAPSession({mode:"local"});
window.fetch=async(input,init)=>{
 const url=new URL(String(input),location.href),path=url.pathname.replace('/api/ap-system','');
 const reply=(value:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}}));
 if(init?.method==="POST"){action=`Synthetic only: ${path}. No backend or external request sent.`;window.dispatchEvent(new Event("fixture-action"));if(path==="/payment-runs")return reply({runId:run.runId,snapshotHash:run.snapshotHash});if(path.endsWith("/authorize")){run.items.forEach(i=>i.payment.status="queued");return reply({commandIds:["synthetic-command-a","synthetic-command-b"]});}if(path.endsWith("/cancel")){run.items.forEach(i=>i.payment.status="cancelled");return reply({ok:true});}if(path.startsWith("/business/")||path.startsWith("/close/")||path.includes("/corrections/"))return reply({ok:true});if(correctionMode&&path.endsWith("/accounting/preview"))return reply({plan:correctionPlanFixture(path.split("/")[2]),planHash:"f".repeat(64),externalWrites:0});return reply({error:{code:"fixture_read_only",reason:"This fixture does not simulate accounting or bank writes."}},409);}
 if(path.startsWith("/close/"))return reply(closeUIFixture());
 if(path==="/cases")return reply(cases);
 if(path==="/business")return reply(raw.governance);
 if(path==="/payment-runs")return reply([{runId:run.runId,snapshotHash:run.snapshotHash,caseIds:run.items.map(i=>i.caseId),executionDate:run.executionDate,createdAt:run.createdAt}]);
 if(path===`/payment-runs/${run.runId}`)return reply(run);
 if(path.endsWith("/corrections")){const proposal=correctionUIFixture(path.split("/")[2]);return reply({proposals:correctionMode?[{...proposal,status:fixtureMode==="corrections"?"approved":"pending"}]:[],controllerProposalAvailable:true});}
 if(path.endsWith("/accounting"))return reply({provider:"QuickBooks Online",environment:"sandbox",configuration:correctionMode?"configured":"not_configured",grant:"authorization_required",mappings:correctionMode?"configured":"missing",externalVerification:"not_checked",receipts:[],holds:[],authority:correctionMode?"verified":"not_recognized",complete:true,externalWritesAllowed:false});
 const c=cases.find(c=>path===`/cases/${c.caseId}`);if(c)return reply(c);
 return reply({error:{code:"fixture_unavailable",reason:"This synthetic fixture does not provide original raster or external provider data."}},503);
};
const darkBlock=tokens.split("@media (prefers-color-scheme: dark)")[1]??"",dark=Object.fromEntries([...darkBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m=>[m[1],m[2]])) as CSSProperties;
function Fixture(){const[theme,setTheme]=useState("light"),[last,setLast]=useState(action);useEffect(()=>{const update=()=>setLast(action);window.addEventListener("fixture-action",update);return()=>window.removeEventListener("fixture-action",update);},[]);return <main className="d2-fixture" style={theme==="dark"?{...dark,colorScheme:"dark"}:undefined}><header className="d2-fixture-controls"><strong>Synthetic D2 business UI fixture</strong><p>All cases, human identities, approvals, bank destinations and requests on this page are synthetic. No backend, identity provider, bank or QuickBooks action is connected.</p><label>Fixture palette<select value={theme} onChange={e=>setTheme(e.target.value)}><option>light</option><option>dark</option></select></label><p role="status">{last}</p></header><APSystemWorkspace/></main>;}
const root=import.meta.hot?.data.root??createRoot(document.getElementById("root")!);if(import.meta.hot){import.meta.hot.data.root=root;import.meta.hot.accept();}root.render(<Fixture/>);
