/** Explicitly simulated multi-human runtime, isolated from I1 and every external bank. */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";
import { AP_POLICY_VERSION } from "./contracts";
import { PAYMENT_EXECUTOR_VERSION, type BankScope } from "../payments/contracts";
const URL="http://127.0.0.1:3254",ISSUER="https://ap-demo.invalid";
const actorIds=["verifier","governor","owner-a","owner-b","finance"] as const;
export const localB3Actors=actorIds.map(id=>({id,name:`Simulated ${id.replaceAll("-"," ")}`,subject:`${ISSUER}|ap97-b3-${id}`}));
const secret=()=>randomBytes(32).toString("hex"),hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const schema=z.object({scope:z.object({organizationId:z.literal("ap97-b3-synthetic-company"),runId:z.string().regex(/^ap97-b3-[a-zA-Z0-9-]+$/),provider:z.literal("fake"),environment:z.literal("local"),accountId:z.literal("ap97-b3-usd-operating")}).strict(),apToken:z.string().length(64),controllerToken:z.string().length(64),paymentToken:z.string().length(64),dispatchToken:z.string().length(64),evidenceToken:z.string().length(64),createdAt:z.string()}).strict();
export function assertLocalB3Deployment(input:unknown){return z.object({ports:z.object({cloud:z.literal(3254),site:z.literal(3255)}),adminKey:z.string().min(1)}).parse(input);}
export async function prepareLocalB3Runtime(root=process.cwd()){
 const runId=process.env.AP_B3_RUN_ID??"ap97-b3-live-20261025";
 if(!/^ap97-b3-[a-zA-Z0-9-]+$/.test(runId))throw Error("Owned B3 local simulation run required");
 const deployment=assertLocalB3Deployment(JSON.parse(readFileSync(path.join(root,".convex/local/default/config.json"),"utf8")));
 const admin=process.env.KERNEL_ADMIN_SECRET;if(!admin)throw Error("Private isolated KERNEL_ADMIN_SECRET required");
 const directory=path.join(root,"var",runId);mkdirSync(directory,{recursive:true,mode:0o700});
 const file=path.join(directory,"runtime.local.json");
 if(!existsSync(file))writeFileSync(file,JSON.stringify({scope:{organizationId:"ap97-b3-synthetic-company",runId,provider:"fake",environment:"local",accountId:"ap97-b3-usd-operating"},apToken:secret(),controllerToken:secret(),paymentToken:secret(),dispatchToken:secret(),evidenceToken:secret(),createdAt:new Date().toISOString()},null,2),{mode:0o600,flag:"wx"});
 if(statSync(file).mode&0o077)throw Error("Local simulation runtime must remain private (0600)");
 const saved=schema.parse(JSON.parse(readFileSync(file,"utf8")));
 if(saved.scope.runId!==runId)throw Error("Owned runtime identity mismatch");
 if(new Set([saved.apToken,saved.controllerToken,saved.paymentToken,saved.dispatchToken,saved.evidenceToken]).size!==5)throw Error("Distinct local agent and worker credentials required");
 const changes=Object.entries({KERNEL_ADMIN_SECRET:admin,AP_DISPATCH_SECRET:saved.dispatchToken,AP_EVIDENCE_SECRET:saved.evidenceToken,AP_BANK_SCOPE:JSON.stringify(saved.scope),AP_HUMAN_AUTH_ISSUER:ISSUER,AP_HUMAN_AUTH_AUDIENCE:"ap-b3-local"}).map(([name,value])=>({name,value}));
 const configured=await fetch(URL+"/api/update_environment_variables",{method:"POST",redirect:"error",headers:{Authorization:`Convex ${deployment.adminKey}`,"Content-Type":"application/json"},body:JSON.stringify({changes})});
 if(!configured.ok)throw Error("Isolated local backend environment configuration failed");
 const agent=new ConvexHttpClient(URL);
 const seats=[{seatId:"ap97-b3-ap",role:"ap_clerk",name:"B3 AP extraction",kind:"agent",tokenHash:hash(saved.apToken)},{seatId:"ap97-b3-controller",role:"controller",name:"B3 controller proposals",kind:"agent",tokenHash:hash(saved.controllerToken)},{seatId:"ap97-b3-payments",role:"payments",name:"B3 payment proposals",kind:"agent",tokenHash:hash(saved.paymentToken)},...localB3Actors.map(a=>({seatId:`ap97-b3-${a.id}`,role:"human_cfo",name:a.name,kind:"human",tokenHash:hash(secret())}))];
 const created=await agent.mutation(makeFunctionReference<"mutation">("admin:createRun"),{secret:admin,runId,label:"Isolated multi-human B3 local simulation",company:"Synthetic Golden State AP",simDate:"2026-10-25",seats,periods:["2026-10","2026-11"]});
 if(!created.ok&&created.code!=="exists")throw Error("Isolated local run creation failed");
 const scope:BankScope=saved.scope;
 const configuration={scope,secret:admin,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,beneficiary:{vendor:"golden-state-produce",externalAccountId:"ap97-b3-golden-state-beneficiary",version:"trusted-b3-synthetic-v1"},policyVersion:AP_POLICY_VERSION,controllerLimitCents:5_000_000,humanSubjects:localB3Actors.map(a=>({subject:a.subject,seatId:`ap97-b3-${a.id}`}))};
 // configure is idempotent only for exactly the same immutable configuration; no broad catch.
 await agent.mutation(makeFunctionReference<"mutation">("demoPayments:configure"),configuration);
 const humanForActor=(actorId:string)=>{
  const actor=localB3Actors.find(a=>a.id===actorId);if(!actor)throw Error("Unknown simulated actor");
  const human=new ConvexHttpClient(URL);
  (human as unknown as {setAdminAuth:(key:string,identity:Record<string,string>)=>void}).setAdminAuth(deployment.adminKey,{issuer:ISSUER,subject:`ap97-b3-${actorId}`,tokenIdentifier:actor.subject});
  return human;
 };
 await humanForActor("finance").query(makeFunctionReference<"query">("apIdentity:workspaceAccess"),{scope});
 return {scope,agent,convexUrl:URL,directory,storageRoot:path.join(directory,"sources"),actors:localB3Actors,humanForActor,apCredential:{seatId:"ap97-b3-ap",token:saved.apToken},controllerCredential:{seatId:"ap97-b3-controller",token:saved.controllerToken},paymentsCredential:{seatId:"ap97-b3-payments",token:saved.paymentToken},dispatchToken:saved.dispatchToken,evidenceToken:saved.evidenceToken,identityMode:"simulated_human" as const};
}
