import { useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { APAuthStatus, type APAuthViewState } from "../../../../console/src/APAuthGate";
import "../../../../console/src/styles.css";
import "../../../../console/src/apSystem.css";
import tokens from "../../../../console/src/tokens.css?raw";
import "./fixture.css";
// Reuse the actual dark token declarations for an explicit fixture theme. This
// does not change the user's OS/browser theme or assert media-query verification.
const darkBlock=tokens.split("@media (prefers-color-scheme: dark)")[1] ?? "";
const dark=Object.fromEntries([...darkBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match=>[match[1],match[2]])) as CSSProperties;
function Fixture(){
 const[state,setState]=useState<APAuthViewState>("login"),[theme,setTheme]=useState("light"),[message,setMessage]=useState<string>();
 return <main className="auth-fixture" style={theme==="dark"?{...dark,colorScheme:"dark"}:undefined}>
  <div className="auth-fixture-controls"><strong>Synthetic Auth0 UI fixture</strong><p>No identity provider, user session or bank is connected. Buttons exercise presentation states only.</p>
  <label>Fixture state<select value={state} onChange={event=>{setState(event.target.value as APAuthViewState);setMessage(undefined);}}>{["login","loading","unapproved","unavailable","signing_out"].map(value=><option key={value}>{value}</option>)}</select></label>
  <label>Fixture palette<select value={theme} onChange={event=>setTheme(event.target.value)}><option>light</option><option>dark</option></select></label></div>
  <APAuthStatus state={state} message={message} identity={state==="unapproved"?"https://synthetic-fixture.us.auth0.com/|auth0|synthetic-reviewer":undefined} onLogin={()=>setMessage("Synthetic fixture: redirect login was requested. No Auth0 request was sent.")} onRetry={()=>setMessage("Synthetic fixture: access recheck was requested. No backend request was sent.")} onLogout={()=>setState("signing_out")}/>
 </main>;
}
const root=import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if(import.meta.hot){import.meta.hot.data.root=root;import.meta.hot.accept();}
root.render(<Fixture/>);
