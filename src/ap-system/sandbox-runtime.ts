import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";
import { parseBankScope } from "../payments/domain/validation";
import { AP_CONTRACT_VERSION, AP_POLICY_VERSION, agentProgressSchema } from "./contracts";
import { createAPExternalAuthentication, parseAPAuth0Config } from "./auth";
import { createAPWorkspaceService } from "./service";
import { createDurableAPIntake } from "./intake-requests";
import { createIntakeProgress } from "./intake-progress";
import { combineUploads, renderPage } from "./ingestion";
import type { APWorkspaceService } from "./server";
const contextSchema=z.object({
 supplier:z.object({supplierId:z.string().trim().min(1),legalName:z.string().trim().min(1),aliases:z.array(z.string()).optional()}).strict(),
 coding:z.object({account:z.string().trim().min(1),store:z.string().nullable(),department:z.string().nullable(),project:z.string().nullable(),treatment:z.enum(["expense","inventory","prepayment","fixed_asset","tax"])}).strict(),
}).strict();
const required=(env:Record<string,string|undefined>,key:string)=>{const value=env[key]?.trim();if(!value)throw new Error(`Set ${key} in the private sandbox environment.`);return value;};
/** Parse before opening a port, creating files, or contacting a backend. No fake/test identity fallback. */
export function parseAPSandboxConfig(env:Record<string,string|undefined>,root=process.cwd()) {
 const auth=parseAPAuth0Config(env);
 const convexUrl=required(env,"AP_SANDBOX_CONVEX_URL");
 if(convexUrl!=="http://127.0.0.1:3252")throw new Error("Use the reserved sandbox Convex backend http://127.0.0.1:3252; the local FakeBank backend is separate.");
 const scope=parseBankScope(JSON.parse(required(env,"AP_BANK_SCOPE")));
 if(scope.provider!=="increase"||scope.environment!=="sandbox"||!/^ap97-[a-zA-Z0-9-]+$/.test(scope.runId))throw new Error("An explicit Increase sandbox account and owned ap97 run are required.");
 const apCredential={seatId:required(env,"AP_SANDBOX_AP_SEAT_ID"),token:required(env,"AP_SANDBOX_AP_SEAT_TOKEN")};
 const paymentsCredential={seatId:required(env,"AP_SANDBOX_PAYMENTS_SEAT_ID"),token:required(env,"AP_SANDBOX_PAYMENTS_SEAT_TOKEN")};
 if(apCredential.seatId===paymentsCredential.seatId||apCredential.token===paymentsCredential.token)throw new Error("AP intake and payments preparation require distinct scoped agent credentials.");
 const controllerCredential=env.AP_SANDBOX_CONTROLLER_SEAT_ID||env.AP_SANDBOX_CONTROLLER_SEAT_TOKEN?{seatId:required(env,"AP_SANDBOX_CONTROLLER_SEAT_ID"),token:required(env,"AP_SANDBOX_CONTROLLER_SEAT_TOKEN")}:undefined;
 if(controllerCredential&&[apCredential,paymentsCredential].some(c=>c.seatId===controllerCredential.seatId||c.token===controllerCredential.token))throw new Error("Controller proposals require a distinct scoped controller credential.");
 const context=contextSchema.parse(JSON.parse(required(env,"AP_SANDBOX_TRUSTED_CONTEXT")));
 const directory=path.join(root,"var","auth0-sandbox",scope.runId);
 return {auth,convexUrl,scope,apCredential,paymentsCredential,controllerCredential,context,directory,storageRoot:path.join(directory,"sources")};
}
export function createAPSandboxRuntime(config:ReturnType<typeof parseAPSandboxConfig>,env:Record<string,string|undefined>) {
 // This client carries agent credentials only as explicit mutation arguments. Never a human/admin token.
 const agent=new ConvexHttpClient(config.convexUrl);
 const progress=createIntakeProgress(config.directory);
 const runtime=()=>({contractVersion:AP_CONTRACT_VERSION,policyVersion:AP_POLICY_VERSION,identityMode:"authenticated_human",providerMode:"Increase sandbox",paymentExecution:"separate_worker",providerFileLoaded:Boolean(env.LLAMA_CLOUD_API_KEY),intakeProgress:true,ownerBindingConfigured:Boolean(config.auth.approvedSubject||config.auth.approvedSubjects?.length)});
 const auth=createAPExternalAuthentication({config:config.auth,convexUrl:config.convexUrl,
  authorize:async human=>{await human.query(makeFunctionReference<"query">("apIdentity:workspaceAccess"),{scope:config.scope});},
  service:human=>{
   // Intake reads existing cases through this request's verified human before revising them.
   const durableParse=createDurableAPIntake({directory:config.directory,loadCase:caseId=>service.detail(caseId),parse:input=>combineUploads({...input,storageRoot:config.storageRoot,context:config.context})});
   const parseUploads:APWorkspaceService["parseUploads"]=input=>progress.parse(input.idempotencyKey,()=>durableParse(input));
   const service=createAPWorkspaceService({...config,agent,human,parseUploads,renderPage:(source,page)=>renderPage({source,page,storageRoot:config.storageRoot}),runtime});
   const detail=service.detail;
   service.detail=async caseId=>{
    const value=await detail(caseId);
    // Older deployments expose their real work record through inspect rather than case detail.
    // Keep it read-only: no fabricated IDs or generations for newer control actions.
    try{
     const inspected=await human.query(makeFunctionReference<"query">("apCaseAgent:inspect"),{scope:config.scope,caseId});
     const result=agentProgressSchema.safeParse(inspected?.work);
     return result.success&&result.data.caseId===caseId?{...value,agentProgress:result.data}:value;
    }catch{return value;}
   };
   const ingest=service.ingest;
   service.ingest=input=>progress.ingest(input.idempotencyKey,()=>ingest(input));
   service.intakeStatus=key=>progress.status(key);
   return service;
  },
 });
 return {runtime,auth};
}
