import {useEffect,useState,type ReactNode} from "react";
import {configureAPSession} from "./apAuthSession";
import {apSystemApi} from "./apSystemApi";
export type LocalActor={id:string;name:string};
export function APLocalSimulationBanner({actors,selected,busy,state,onSelect,onRetry}:{actors:LocalActor[];selected:string;busy:boolean;state:"idle"|"loading"|"ready"|"denied";onSelect:(id:string)=>void;onRetry:()=>void}){
 return <section className="ap-local-simulation aps-app" aria-label="Local multi-human simulation"><div><strong>Local multi-human simulation / FakeBank</strong><p>These are distinct simulated human seats on an isolated local backend. This is not an Auth0 login, a real person’s approval or an external bank authorization.</p></div><label>Simulated human<select value={selected} disabled={busy} onChange={e=>onSelect(e.target.value)}><option value="">Choose a simulated actor</option>{actors.map(actor=><option key={actor.id} value={actor.id}>{actor.name}</option>)}</select></label>{state==="loading"&&<p role="status">Opening a fresh session for the selected simulated actor…</p>}{state==="denied"&&<div role="alert"><p>This simulated actor has no current workspace binding, or the isolated backend is unavailable. Previous actor data is hidden.</p><button disabled={busy} onClick={onRetry}>Recheck simulated access</button></div>}{state==="ready"&&<p className="aps-caption">Acting as {actors.find(a=>a.id===selected)?.name}. Group membership, distinct-person quorum and stale-evidence checks still apply.</p>}</section>;
}
export function APLocalSimulationGate({actors,busy=false,children}:{actors:LocalActor[];busy?:boolean;children:ReactNode}){
 const[selected,setSelected]=useState(""),[attempt,setAttempt]=useState(0),[state,setState]=useState<"idle"|"loading"|"ready"|"denied">("idle");
 useEffect(()=>{
  configureAPSession(null);if(!selected){setState("idle");return;}let live=true;let timer:ReturnType<typeof setInterval>|undefined;
  const expired=()=>{if(timer)clearInterval(timer);configureAPSession(null);if(live)setState("denied");};
  const release=configureAPSession({mode:"local_simulation",actorId:selected,expired});setState("loading");
  const verify=async()=>{try{const identity=await apSystemApi.whoami();if(!live)return false;if(!identity.approved){expired();return false;}setState("ready");return true;}catch{if(live)expired();return false;}};
  void verify().then(ok=>{if(live&&ok)timer=setInterval(()=>void verify(),60000);});
  return()=>{live=false;release();if(timer)clearInterval(timer);};
 },[selected,attempt]);
 const select=(id:string)=>{if(busy||id&&!actors.some(a=>a.id===id))return;configureAPSession(null);setState(id?"loading":"idle");setSelected(id);};
 return <><APLocalSimulationBanner actors={actors} selected={selected} busy={busy} state={state} onSelect={select} onRetry={()=>{configureAPSession(null);setState("loading");setAttempt(n=>n+1);}}/>{state==="ready"&&<div key={`${selected}:${attempt}`}>{children}</div>}</>;
}
