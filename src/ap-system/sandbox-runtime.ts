import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";
import { parseBankScope } from "../payments/domain/validation";
import { AP_CONTRACT_VERSION, AP_POLICY_VERSION } from "./contracts";
import { createAPExternalAuthentication, parseAPAuth0Config } from "./auth";
import { createAPWorkspaceService } from "./service";
import { createDurableAPIntake } from "./intake-requests";
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
 const context=contextSchema.parse(JSON.parse(required(env,"AP_SANDBOX_TRUSTED_CONTEXT")));
 const directory=path.join(root,"var","auth0-sandbox",scope.runId);
 return {auth,convexUrl,scope,apCredential,paymentsCredential,context,directory,storageRoot:path.join(directory,"sources")};
}
export function createAPSandboxRuntime(config:ReturnType<typeof parseAPSandboxConfig>,env:Record<string,string|undefined>) {
 // This client carries agent credentials only as explicit mutation arguments. Never a human/admin token.
 const agent=new ConvexHttpClient(config.convexUrl);
 const runtime=()=>({contractVersion:AP_CONTRACT_VERSION,policyVersion:AP_POLICY_VERSION,identityMode:"authenticated_human",providerMode:"Increase sandbox",paymentExecution:"separate_worker",providerFileLoaded:Boolean(env.LLAMA_CLOUD_API_KEY),ownerBindingConfigured:Boolean(config.auth.approvedSubject||config.auth.approvedSubjects?.length)});
 const auth=createAPExternalAuthentication({config:config.auth,convexUrl:config.convexUrl,
  authorize:async human=>{await human.query(makeFunctionReference<"query">("apIdentity:workspaceAccess"),{scope:config.scope});},
  service:human=>{
   // Intake reads existing cases through this request's verified human before revising them.
   const parseUploads:APWorkspaceService["parseUploads"]=createDurableAPIntake({directory:config.directory,loadCase:caseId=>service.detail(caseId),parse:input=>combineUploads({...input,storageRoot:config.storageRoot,context:config.context})});
   const service=createAPWorkspaceService({...config,agent,human,parseUploads,renderPage:(source,page)=>renderPage({source,page,storageRoot:config.storageRoot}),runtime});
   return service;
  },
 });
 return {runtime,auth};
}
