import {useEffect,useState,type CSSProperties} from "react";
import {createRoot} from "react-dom/client";
import {APSystemCloseQuickBooks} from "../../../../console/src/APSystemCloseQuickBooks";
import {configureAPSession} from "../../../../console/src/apAuthSession";
import {taxReceiptFixtureResponse,taxReceiptUIFixture,type TaxReceiptScenario} from "../../../../tests/ap-system-tax-receipt-ui.fixture";
import "../../../../console/src/styles.css";
import "../../../../console/src/apSystem.css";
import tokens from "../../../../console/src/tokens.css?raw";
import "./fixture.css";
const params=new URLSearchParams(location.search);
let active:TaxReceiptScenario={authority:params.get("authority")==="current"?"current":"historical_receipt_only",state:(["prepared","sending","unknown","succeeded"].includes(params.get("state")??"")?params.get("state"):"unknown") as TaxReceiptScenario["state"],reads:params.get("reads")!=="false"};
let last="No fixture request yet.";
configureAPSession({mode:"local"});
window.fetch=async(input,init)=>{
 const url=new URL(String(input),location.href);let body:unknown;try{body=JSON.parse(String(init?.body??"{}"));}catch{body=undefined;}
 const result=taxReceiptFixtureResponse(active,url.pathname,init?.method??"GET",body);
 last=`Local fixture intercepted ${init?.method??"GET"} ${url.pathname}. Returned ${result.status}. No request was forwarded.`;window.dispatchEvent(new Event("tax-receipt-fixture-request"));
 return new Response(JSON.stringify(result.value),{status:result.status,headers:{"Content-Type":"application/json"}});
};
const darkBlock=tokens.split("@media (prefers-color-scheme: dark)")[1]??"",dark=Object.fromEntries([...darkBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m=>[m[1],m[2]])) as CSSProperties;
function Fixture(){
 const[scenario,setScenario]=useState(active),[theme,setTheme]=useState(params.get("theme")==="dark"?"dark":"light"),[busy,setBusy]=useState(false),[request,setRequest]=useState(last);
 const fixture=taxReceiptUIFixture(scenario),key=JSON.stringify(scenario);
 useEffect(()=>{const update=()=>setRequest(last);window.addEventListener("tax-receipt-fixture-request",update);return()=>window.removeEventListener("tax-receipt-fixture-request",update);},[]);
 useEffect(()=>{const p=new URLSearchParams({authority:scenario.authority,state:scenario.state,reads:String(scenario.reads),theme});history.replaceState(null,"",`${location.pathname}?${p}`);},[scenario,theme]);
 const change=(patch:Partial<TaxReceiptScenario>)=>{active={...scenario,...patch};setScenario(active);setBusy(false);setRequest("Scenario changed. Select the synthetic approved journal to load its local status.");};
 return <main className="d2-fixture" style={theme==="dark"?{...dark,colorScheme:"dark"}:undefined}><header className="d2-fixture-controls"><h1>Synthetic historical tax receipt UI</h1><p>Desktop component fixture only. All authority, journals, approvals and receipts below are synthetic. Every fetch is intercepted locally. No backend, provider read, journal submission or financial action is possible.</p><div className="aps-form-grid"><label>Authority<select value={scenario.authority} disabled={busy} onChange={e=>change({authority:e.target.value as TaxReceiptScenario["authority"]})}><option value="current">Current write authority</option><option value="historical_receipt_only">Historical receipt only</option></select></label><label>Saved receipt state<select value={scenario.state} disabled={busy} onChange={e=>change({state:e.target.value as TaxReceiptScenario["state"]})}>{["prepared","sending","unknown","succeeded"].map(s=><option key={s}>{s}</option>)}</select></label><label>Explicit external read permission<select value={String(scenario.reads)} disabled={busy} onChange={e=>change({reads:e.target.value==="true"})}><option value="false">False</option><option value="true">True</option></select></label><label>Fixture palette<select value={theme} onChange={e=>setTheme(e.target.value)}><option>light</option><option>dark</option></select></label></div><p>After a scenario change, select “Tax adjustment / $4.25” below. Historical mode must disable preview and submission. Prepared receipts never offer recovery; sending/unknown receipts offer recovery only when reads are explicitly allowed. Verify/recover clicks show an explicit fixture-only result and preserve the receipt.</p><p role="status">{request}</p></header><section className="aps-app"><APSystemCloseQuickBooks key={key} view={fixture.view} busy={busy} onBusy={setBusy}/></section></main>;
}
const root=import.meta.hot?.data.root??createRoot(document.getElementById("root")!);if(import.meta.hot){import.meta.hot.data.root=root;import.meta.hot.accept();}root.render(<Fixture/>);
