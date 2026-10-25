import { query } from "./_generated/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import { requirePaymentHuman } from "./lib/demoAuth";
import { loadRecognizedBusinessExport } from "./lib/apSystem/businessExport";
/** Authenticated authoritative export for QBO integration; no browser-authored financial facts. */
export const current = query({args:{scope:scopeValidator,caseId:v.id("apCaseRecords")},handler:async(ctx,args)=>{
 const {subject}=await requirePaymentHuman(ctx,args.scope);
 return {version:"ap-business-export-v1" as const,exportedAt:Date.now(),authorizedSubject:subject,recognized:await loadRecognizedBusinessExport(ctx,args.scope,args.caseId)};
}});
