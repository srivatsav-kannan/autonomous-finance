import fs from "node:fs";
import path from "node:path";
import {createHash,randomBytes} from "node:crypto";
import {execFileSync} from "node:child_process";
import {ConvexHttpClient} from "convex/browser";
import {makeFunctionReference} from "convex/server";
import {AP_POLICY_VERSION} from "./contracts";
import type {BankScope} from "../payments/contracts";
import {PAYMENT_EXECUTOR_VERSION} from "../payments/contracts";
export const localAPActors=[{id:"field-reviewer",name:"Simulated field reviewer",subject:"https://ap-demo.invalid|ap97-field-reviewer"},{id:"bill-approver",name:"Simulated bill approver",subject:"https://ap-demo.invalid|ap97-local-human"},{id:"payer",name:"Simulated payment authorizer",subject:"https://ap-demo.invalid|ap97-payer"}];
const secret=()=>randomBytes(32).toString("hex");
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
type SavedRuntime={scope:BankScope;apToken:string;paymentToken:string;dispatchToken:string;evidenceToken:string;humanSubject:string;createdAt:string};
/** Explicitly local/simulated identity. Never use admin impersonation for an external bank. */
export async function prepareLocalAPRuntime(root=process.cwd()){
 const runId=process.env.AP_RUN_ID??"ap97-usd-controls-v2";
 if(!/^ap97-[a-zA-Z0-9-]+$/.test(runId))throw Error("AP goal-specific run ID required");
 const directory=path.join(root,"var",runId);fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const file=path.join(directory,"runtime.local.json");
 const saved:SavedRuntime=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{scope:{organizationId:"ap97-synthetic-company",runId,provider:"fake",environment:"local",accountId:"ap97-usd-operating"},apToken:secret(),paymentToken:secret(),dispatchToken:secret(),evidenceToken:secret(),humanSubject:"https://ap-demo.invalid|ap97-local-human",createdAt:new Date().toISOString()};
 if(saved.scope.provider!=="fake"||saved.scope.environment!=="local"||saved.scope.runId!==runId)throw Error("Only owned local FakeBank scope accepted");
 if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify(saved,null,2),{mode:0o600});
 const deployment=JSON.parse(fs.readFileSync(path.join(root,".convex/local/default/config.json"),"utf8"));
 if(deployment.ports.cloud!==3250||deployment.ports.site!==3251)throw Error("Refusing another preview/backend");
 const url="http://127.0.0.1:3250";const admin=process.env.KERNEL_ADMIN_SECRET;if(!admin)throw Error("Explicit local KERNEL_ADMIN_SECRET required");
 const response=await fetch(url+"/api/update_environment_variables",{method:"POST",redirect:"error",headers:{Authorization:`Convex ${deployment.adminKey}`,"Content-Type":"application/json"},body:JSON.stringify({changes:Object.entries({KERNEL_ADMIN_SECRET:admin,AP_DISPATCH_SECRET:saved.dispatchToken,AP_EVIDENCE_SECRET:saved.evidenceToken,AP_BANK_SCOPE:JSON.stringify(saved.scope),AP_HUMAN_AUTH_ISSUER:"https://ap-demo.invalid",AP_HUMAN_AUTH_AUDIENCE:"ap-demo"}).map(([name,value])=>({name,value}))})});
 if(!response.ok)throw Error("Owned backend configuration failed");
 const client=new ConvexHttpClient(url);const human=new ConvexHttpClient(url);
 (human as unknown as {setAdminAuth(key:string,identity:Record<string,string>):void}).setAdminAuth(deployment.adminKey,{issuer:"https://ap-demo.invalid",subject:"ap97-local-human",tokenIdentifier:saved.humanSubject});
 const humanForActor=(id:string)=>{const actor=localAPActors.find(a=>a.id===id);if(!actor)throw Error("Unknown local actor");const c=new ConvexHttpClient(url);(c as unknown as {setAdminAuth(key:string,identity:Record<string,string>):void}).setAdminAuth(deployment.adminKey,{issuer:"https://ap-demo.invalid",subject:actor.subject.split("|")[1]!,tokenIdentifier:actor.subject});return c;};
 const seats=[{seatId:"ap97-ap",role:"ap_clerk",name:"AP extraction",kind:"agent",tokenHash:hash(saved.apToken)},{seatId:"ap97-payments",role:"payments",name:"Payments preparation",kind:"agent",tokenHash:hash(saved.paymentToken)},...localAPActors.map(a=>({seatId:`ap97-${a.id}`,role:"human_cfo",name:a.name,kind:"human",tokenHash:hash(secret())}))];
 const created=await client.mutation(makeFunctionReference<"mutation">("admin:createRun"),{secret:admin,runId,label:"Evidence-backed AP implementation",company:"Synthetic Golden State AP",simDate:"2026-10-25",seats,periods:["2026-10","2026-11"]});
 if(!created.ok&&created.code!=="exists")throw Error("AP run creation failed");
 try{await client.mutation(makeFunctionReference<"mutation">("demoPayments:configure"),{scope:saved.scope,secret:admin,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,beneficiary:{vendor:"golden-state-produce",externalAccountId:"ap97-golden-state-beneficiary",version:"trusted-synthetic-v1"},policyVersion:AP_POLICY_VERSION,controllerLimitCents:5_000_000,humanSubjects:localAPActors.map(a=>({subject:a.subject,seatId:`ap97-${a.id}`})),paymentAuthorizers:[{subject:"https://ap-demo.invalid|ap97-payer",maxCents:5_000_000}]});}
 catch(e){if(!(e instanceof Error)||!e.message.includes("immutable"))throw e;}
 const review=await human.query(makeFunctionReference<"query">("demoPayments:humanReview"),{scope:saved.scope});
 if(review.policyVersion!==AP_POLICY_VERSION||review.beneficiary.vendor!=="golden-state-produce"||review.beneficiary.version!=="trusted-synthetic-v1")throw Error("Existing run configuration mismatch");
 let revision:string|null=null;try{revision=execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();}catch{}
 return {client,human,humanForActor,actors:localAPActors,convexUrl:url,scope:saved.scope,directory,storageRoot:path.join(directory,"sources"),apCredential:{seatId:"ap97-ap",token:saved.apToken},paymentsCredential:{seatId:"ap97-payments",token:saved.paymentToken},dispatchToken:saved.dispatchToken,evidenceToken:saved.evidenceToken,revision,identityMode:"simulated_human" as const};
}
