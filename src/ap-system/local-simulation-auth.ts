/** Public actor selection for the isolated FakeBank runtime only. This is not IdP authentication. */
import type { BankScope } from "../payments/contracts";
import { APHttpError, type APExternalAuthentication, type APWorkspaceService } from "./server";
export type APSimulationActor={id:string;name:string;subject:string};
const issuer="https://ap-demo.invalid";
export function createAPLocalSimulationAuthentication(options:{scope:BankScope;convexUrl:string;actors:APSimulationActor[];serviceForActor:(actorId:string)=>APWorkspaceService|Promise<APWorkspaceService>;authorizeActor?:(actorId:string)=>Promise<void|boolean>}):APExternalAuthentication{
 if(options.scope.provider!=="fake"||options.scope.environment!=="local"||!(["http://127.0.0.1:3250","http://127.0.0.1:3254"].includes(options.convexUrl)||(options.convexUrl==="http://127.0.0.1:3260"&&/^ap97-b3-guidance-/.test(options.scope.runId)))||!/^ap97-[a-zA-Z0-9-]+$/.test(options.scope.runId))throw new Error("Local multi-human simulation requires its isolated FakeBank backend on an explicitly owned loopback port and an owned ap97 run.");
 const actors=options.actors.map(a=>({...a,name:a.name.trim()}));
 if(!actors.length||actors.length>20||actors.some(a=>!/^[-a-z0-9]{1,80}$/.test(a.id)||!a.name||a.name.length>120||!a.subject.startsWith(issuer+"|")||a.subject.length<=issuer.length+1)||new Set(actors.map(a=>a.id)).size!==actors.length||new Set(actors.map(a=>a.subject)).size!==actors.length)throw new Error("Configure a distinct explicit local actor roster with simulated subjects.");
 const roster=new Map(actors.map(a=>[a.id,a]));
 return{
  publicConfig:{mode:"local_simulation",actors:actors.map(({id,name})=>({id,name}))},
  async authenticate(token){
   const actor=token.startsWith("local:")?roster.get(token.slice(6)):undefined;
   if(!actor)throw new APHttpError("authentication_required",401,"Choose a configured local simulated actor.");
   // No absent callback or remembered successful check grants current authority.
   let approved=false;if(options.authorizeActor){try{approved=(await options.authorizeActor(actor.id))!==false;}catch{approved=false;}}
   return{subject:actor.subject,issuer,approved,service:await options.serviceForActor(actor.id)};
  },
 };
}
