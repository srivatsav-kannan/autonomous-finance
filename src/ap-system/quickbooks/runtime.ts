/** Optional request-bound bridge. No JWT input UI, secrets, or provider payload supplied by callers. */
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { BankScope } from "../../payments/contracts";
import type { APCaseDetail } from "../contracts";
import { OAuth, configFromEnv } from "./oauth";
import { PrivateStore, QboError, hash, safeError } from "./private-store";
import { QboClient } from "./client";
import { QuickBooksDispatcher, SyncJournal } from "./sync";
import { validateMappings } from "./plans";
import type { AccountingExport, ExportRequest, Mappings, Operation } from "./types";

export type QBOReceipt = Pick<Operation,"entity"|"requestId"|"state"|"externalId"|"syncToken"|"links"|"updatedAt"|"lastError">;
export type QBOStatus = {provider:"QuickBooks Online";environment:"sandbox";configuration:"not_configured"|"incomplete"|"configured";grant:"authorization_required"|"available";mappings:"missing"|"configured";externalVerification:"not_checked";receipts:QBOReceipt[];complete:boolean;reason?:string};
const receipt=(o:Operation):QBOReceipt=>({entity:o.entity,requestId:o.requestId,state:o.state,externalId:o.externalId,syncToken:o.syncToken,links:o.links,updatedAt:o.updatedAt,lastError:o.lastError});
export type QBOBridge = ReturnType<typeof createQBOBridge>;
/** Call only with the human client created and verified for the current AP request. */
export function createQBOBridge(human:ConvexHttpClient,scope:BankScope,env:NodeJS.ProcessEnv=process.env) {
 const supplied=["QBO_CLIENT_ID","QBO_CLIENT_SECRET","QBO_REALM_ID","QBO_REDIRECT_URI","QBO_ENVIRONMENT"].some(k=>Boolean(env[k]));
 let config:ReturnType<typeof configFromEnv>|undefined;
 try {if(supplied)config=configFromEnv(env);} catch {/* Readiness explains incomplete private configuration; no credential values leave the server. */}
 const store=config?new PrivateStore(resolve(env.QBO_PRIVATE_DIR??"var/quickbooks-private")):undefined;
 const client=config&&store?new QboClient(new OAuth(config,store)):undefined;
 const authorizeCase=async(caseId:string)=>await human.query(makeFunctionReference<"query">("apCases:detail"),{scope,caseId}) as APCaseDetail;
 const load=async(request:ExportRequest)=>await human.query(makeFunctionReference<"query">("apAccountingExport:current"),{scope,...request}) as AccountingExport;
 const mapping=async()=>{if(!config||!store||!client)throw new QboError("qbo_sandbox_configuration_required");const m=await store.read<Mappings>("mappings.json");if(!m)throw new QboError("accounting_mappings_required");validateMappings(m,config.realmId);return m;};
 const dispatcher=async()=>{const m=await mapping();return new QuickBooksDispatcher(load,m,new SyncJournal(store!,client!));};
 return {
  async status(caseId:string):Promise<QBOStatus>{
   // Even readiness/receipt inspection has the same current human/case boundary as originals.
   await authorizeCase(caseId);
   const result:QBOStatus={provider:"QuickBooks Online",environment:"sandbox",configuration:config?"configured":supplied?"incomplete":"not_configured",grant:"authorization_required",mappings:"missing",externalVerification:"not_checked",receipts:[],complete:true};
   if(!store||!config)return result;
   try {
    const token=await store.read<{realmId:string;clientHash:string;blocked:boolean;refreshUntil:number;hardUntil:number|null}>("tokens.json");
    if(token&&!token.blocked&&token.realmId===config.realmId&&token.clientHash===hash(config.clientId)&&token.refreshUntil>Date.now()&&(token.hardUntil===null||token.hardUntil>Date.now()))result.grant="available";
    try{await mapping();result.mappings="configured";}catch(e){result.reason=safeError(e);}
    const keys=(await readdir(store.root)).filter(k=>/^operation-[a-f0-9]{64}\.json$/.test(k)).sort();result.complete=keys.length<=1000;
    for(const key of keys.slice(0,1000)){const op=await store.read<Operation>(key);if(op?.realmId===config.realmId&&op.links?.caseId===caseId)result.receipts.push(receipt(op));}
    return result;
   }catch(e){return {...result,reason:safeError(e),complete:false};}
  },
  async preview(request:ExportRequest){const d=await dispatcher();const result=await d.run(request,"dry-run");if(!("plan" in result)||!result.plan)throw new QboError("plan_required");return {plan:result.plan,planHash:hash(result.plan),externalWrites:0 as const};},
  async submit(request:ExportRequest,expectedPlanHash:string){
   if(!/^[a-f0-9]{64}$/.test(expectedPlanHash))throw new QboError("approved_preview_required");
   const d=await dispatcher();const result=await d.run(request,"submit",{expectedPlanHash});if(!("operation" in result)||!result.operation)throw new QboError("operation_required");return {operation:receipt(result.operation)};
  },
  async verify(request:ExportRequest){
   const d=await dispatcher();const result=await d.run(request,"dry-run");if(!("plan" in result)||!result.plan)throw new QboError("plan_required");
   const op=await d.journal.get(result.plan);if(!op||op.state!=="succeeded")throw new QboError("successful_operation_required");
   await d.journal.client.verify(op);return {operation:receipt(op),verifiedAt:Date.now()};
  },
 };
}
