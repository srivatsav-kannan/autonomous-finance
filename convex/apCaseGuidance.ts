import { mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import { assertRowScope } from "./lib/demoAuth";
import { caseRow, readAuth, deny } from "./lib/apSystem/shared";
import { canonical, sha256Hex } from "./lib/kernel";
import { intakeSchema } from "../src/ap-system/contracts";
import { caseGuidanceContext, type CaseGuidance } from "../src/ap-system/case-guidance";
import { recommendation } from "./apPrecedents";
import { activeBusinessPolicy } from "./lib/apSystem/businessAuthority";
import type { Doc } from "./_generated/dataModel";
const reader={scope:scopeValidator,seatId:v.optional(v.string()),token:v.optional(v.string())};
async function decision(ctx:QueryCtx,row:Doc<"apCaseRecords">) {
  const input=intakeSchema.parse(row.intake), facts=caseGuidanceContext(input);
  const candidates=await ctx.db.query("apPrecedentCandidates").withIndex("by_run",q=>q.eq("scope.runId",row.scope.runId)).collect();
  const histories=await ctx.db.query("apPrecedentHistory").withIndex("by_run",q=>q.eq("scope.runId",row.scope.runId)).collect();
  candidates.forEach(c=>assertRowScope(c,row.scope)); histories.forEach(h=>assertRowScope(h,row.scope));
  const policy=await activeBusinessPolicy(ctx,row.scope);
  const result=facts.context?await recommendation(ctx,row.scope,facts.context):{status:"held" as const,coding:null,ruleIds:[],reason:facts.reasons.join("; ")};
  const rules=candidates.map(c=>({id:c._id,version:"1",hash:c.hash,status:c.status,scope:c.review?.approvedScope??c.proposal.scope,review:c.review??null,histories:histories.filter(h=>c.proposal.historyIds.includes(h._id)).map(h=>({id:h._id,hash:h.hash,...h.payload,provenance:h.payload.provenance}))}));
  const mismatches=result.status==="held"&&facts.context?rules.filter(r=>r.status==="approved").flatMap(r=>{const s=r.scope as {supplierId:string;category:string;locations:string[];effectiveFrom:string;effectiveUntil:string},c=facts.context!;return [s.supplierId!==c.supplierId?`supplierId: ${c.supplierId} differs from ${s.supplierId}`:null,s.category!==c.category?`category: ${c.category} differs from approved ${s.category}`:null,!s.locations.includes(c.location)?`location: ${c.location} outside ${s.locations.join(", ")}`:null,c.effectiveOn<s.effectiveFrom||c.effectiveOn>s.effectiveUntil?`date: ${c.effectiveOn} outside ${s.effectiveFrom} to ${s.effectiveUntil}`:null].filter(Boolean);}):[];
  const payload={caseId:row._id,caseRevision:row.currentRevision,snapshotHash:row.snapshotHash,sourceBindings:input.documents.map(({sourceId,revision,sha256})=>({sourceId,revision,sha256})),status:result.status,coding:result.coding,reason:[result.reason,...mismatches].join("; "),owner:"field-reviewer",nextAction:result.status==="held"?"Inspect the original and obtain a supported service classification; submit corrected evidence for a new revision and independent coding review.":"Review the source and suggested coding. Field review, bill approval and separate payment authorization remain required.",context:facts.context,matches:facts.matches,rules:result.status==="recommendation"?rules.filter(r=>result.ruleIds.includes(r.id)):rules,requiresHumanReview:true as const,inferenceMode:"deterministic_demo" as const};
  return {...payload,fingerprint:await sha256Hex(canonical({payload,policy:policy?.hash??null}))};
}
export async function saveCaseGuidance(ctx:MutationCtx,row:Doc<"apCaseRecords">,actor:string) {
  const payload=await decision(ctx,row);
  const rows=await ctx.db.query("apCaseGuidance").withIndex("by_case",q=>q.eq("scope.runId",row.scope.runId).eq("caseId",row._id)).collect();
  const old=rows.find(r=>r.fingerprint===payload.fingerprint);
  if(old)return {...old.payload,id:old._id} as CaseGuidance;
  const evaluatedAt=Date.now();
  const id=await ctx.db.insert("apCaseGuidance",{scope:row.scope,caseId:row._id,fingerprint:payload.fingerprint,payload:{...payload,evaluatedAt},actor,evaluatedAt});
  return {...payload,evaluatedAt,id} as CaseGuidance;
}
export const evaluate=mutation({args:{...reader,caseId:v.string(),expectedRevision:v.number(),snapshotHash:v.string()},handler:async(ctx,args)=>{
  const auth=await readAuth(ctx,args),row=await caseRow(ctx,args.scope,args.caseId);
  if(row.currentRevision!==args.expectedRevision||row.snapshotHash!==args.snapshotHash)deny("stale_guidance","Guidance must bind the current case revision and snapshot");
  return saveCaseGuidance(ctx,row,auth.seat.seatId);
}});
export const current=query({args:{...reader,caseId:v.string()},handler:async(ctx,args)=>{
  await readAuth(ctx,args); const row=await caseRow(ctx,args.scope,args.caseId),fresh=await decision(ctx,row);
  const rows=await ctx.db.query("apCaseGuidance").withIndex("by_case",q=>q.eq("scope.runId",args.scope.runId).eq("caseId",row._id)).collect();
  const saved=rows.find(r=>r.fingerprint===fresh.fingerprint);
  return saved?{...saved.payload,id:saved._id} as CaseGuidance:null;
}});
