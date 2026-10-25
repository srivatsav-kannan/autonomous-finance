import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import type { BankScope } from "../src/integrations/contracts";
import { requirePaymentHuman, requirePaymentSeat, assertRowScope, auditDemo } from "./lib/demoAuth";
import { canonical, sha256Hex } from "./lib/kernel";
import { readAuth, deny, replay, receipt } from "./lib/apSystem/shared";
import { activeBusinessPolicy, requireBusinessPolicy, requireGroup, assertHumanSubject } from "./lib/apSystem/businessAuthority";
import {
  precedentHistorySchema, precedentProposalSchema, precedentReviewSchema, precedentContextSchema,
  precedentApplies, precedentScopeIsNarrower, PRECEDENT_DEMO_CASES,
  type PrecedentHistoryInput, type PrecedentScope, type PrecedentCoding, type PrecedentEvidence,
  type PrecedentOverview, type PrecedentCandidate, type PrecedentContext, type PrecedentEvaluation,
} from "../src/ap-system/precedent-contracts";
const agent = { scope: scopeValidator, seatId: v.string(), token: v.string() };
const reader = { scope: scopeValidator, seatId: v.optional(v.string()), token: v.optional(v.string()) };
const codingEqual = (a: PrecedentCoding, b: PrecedentCoding) => canonical({ ...a, allocations: [...a.allocations].sort((x,y)=>x.code.localeCompare(y.code)) }) === canonical({ ...b, allocations: [...b.allocations].sort((x,y)=>x.code.localeCompare(y.code)) });
async function histories(ctx: QueryCtx, scope: BankScope) {
  const rows = await ctx.db.query("apPrecedentHistory").withIndex("by_run", q => q.eq("scope.runId", scope.runId)).collect();
  for (const row of rows) assertRowScope(row, scope);
  return rows;
}
function evidenceFor(rows: Doc<"apPrecedentHistory">[], scope: PrecedentScope, coding: PrecedentCoding) {
  const support: PrecedentEvidence[] = [], contradictions: PrecedentEvidence[] = [], missingContext: string[] = [];
  for (const row of rows) {
    const h = precedentHistorySchema.parse(row.payload);
    if (!precedentApplies(scope, h.context)) continue;
    const item = { historyId: row._id, sourceCaseId: h.sourceCaseId, revision: h.sourceCaseRevision, sourceBindings: h.sourceBindings, reason: h.correctionReason };
    if (codingEqual(h.finalCoding, coding) && !h.contradictions.length) support.push(item);
    else contradictions.push({ ...item, reason: h.contradictions.join("; ") || "Historical final coding differs from this candidate" });
    for (const missing of h.missingContext) missingContext.push(`${h.sourceCaseId}: ${missing}`);
  }
  if (!support.length) missingContext.push("No retained historical outcome supports this exact supplier/category/location/date scope and coding");
  return { support, contradictions, missingContext: [...new Set(missingContext)] };
}
async function saveHistory(ctx: MutationCtx, scope: BankScope, actor: string, input: unknown) {
  const payload = precedentHistorySchema.parse(input);
  if (payload.provenance === "synthetic" && payload.sources.some(s => s.provenance !== "synthetic")) deny("provenance_mismatch", "Synthetic history must retain synthetic sources");
  const keys = new Set<string>();
  for (const source of payload.sources) {
    const key = `${source.sourceId}:${source.revision}`;
    if (keys.has(key) || await sha256Hex(source.text) !== source.sha256) deny("source_hash_mismatch", "Each retained source needs unique identity and an exact content hash");
    keys.add(key);
  }
  if (payload.sourceBindings.length !== keys.size || new Set(payload.sourceBindings.map(b => `${b.sourceId}:${b.revision}`)).size !== keys.size || payload.sourceBindings.some(b => !payload.sources.some(s => s.sourceId === b.sourceId && s.revision === b.revision && s.sha256 === b.sha256))) deny("source_binding_mismatch", "History must bind every retained source exactly once");
  const hash = await sha256Hex(canonical(payload));
  const old = await ctx.db.query("apPrecedentHistory").withIndex("by_external", q => q.eq("scope.runId", scope.runId).eq("externalId", payload.externalId)).unique();
  if (old) {
    assertRowScope(old, scope);
    if (old.hash !== hash) deny("history_immutable", "Historical records are immutable; import a separately identified revision");
    return old._id;
  }
  return ctx.db.insert("apPrecedentHistory", { scope, externalId: payload.externalId, hash, payload, importedBy: actor, importedAt: Date.now() });
}
async function saveCandidate(ctx: MutationCtx, scope: BankScope, actor: string, input: unknown) {
  const proposal = precedentProposalSchema.parse(input);
  const all = await histories(ctx, scope);
  if (proposal.historyIds.some(id => !all.some(h => h._id === id)) || new Set(proposal.historyIds).size !== proposal.historyIds.length) deny("history_missing", "Every proposed supporting record must belong to this scope");
  const evidence = evidenceFor(all, proposal.scope, proposal.coding);
  if (!proposal.historyIds.some(id => evidence.support.some(s => s.historyId === id))) deny("unsupported_precedent", "Candidate must cite a retained supporting outcome");
  const hash = await sha256Hex(canonical({ proposal, ...evidence, proposedBy: actor }));
  const candidateId = await ctx.db.insert("apPrecedentCandidates", { scope, hash, proposal, ...evidence, proposedBy: actor, status: "proposed", createdAt: Date.now() });
  await auditDemo(ctx, scope, actor, "coding_precedent_proposed", { candidateId, hash, inferenceMode: "deterministic_demo", authority: "recommendation_only" });
  return { candidateId, hash };
}
/** Importing history only writes evidence: never creates AP cases, bills, ledger entries or payments. */
export const importHistory = mutation({ args: { ...agent, idempotencyKey: v.string(), history: v.any() }, handler: async (ctx, args) => {
  const { seat } = await requirePaymentSeat(ctx, args, ["ap_clerk", "controller"]);
  const op = await replay(ctx, args.scope, `precedent-history:${args.idempotencyKey}`, { history: args.history, actor: seat.seatId });
  if (op.prior) return op.prior.result;
  const historyId = await saveHistory(ctx, args.scope, seat.seatId, args.history);
  const result = { historyId, recordPurpose: "non_posting_historical_evidence" };
  await receipt(ctx, args.scope, `precedent-history:${args.idempotencyKey}`, op.payloadHash, result);
  return result;
} });
export const proposeRule = mutation({ args: { ...agent, idempotencyKey: v.string(), proposal: v.any() }, handler: async (ctx, args) => {
  const { seat } = await requirePaymentSeat(ctx, args, ["ap_clerk", "controller"]);
  const op = await replay(ctx, args.scope, `precedent-proposal:${args.idempotencyKey}`, { proposal: args.proposal, actor: seat.seatId });
  if (op.prior) return op.prior.result;
  const result = await saveCandidate(ctx, args.scope, seat.seatId, args.proposal);
  await receipt(ctx, args.scope, `precedent-proposal:${args.idempotencyKey}`, op.payloadHash, result);
  return result;
} });
export const reviewRule = mutation({ args: { scope: scopeValidator, candidateId: v.string(), expectedHash: v.string(), outcome: v.union(v.literal("accept"), v.literal("narrow"), v.literal("reject")), reason: v.string(), narrowedScope: v.optional(v.any()) }, handler: async (ctx, args) => {
  const { seat, subject } = await requirePaymentHuman(ctx, args.scope);
  const policy = await requireBusinessPolicy(ctx, args.scope);
  requireGroup(policy.value, policy.value.supplierApprovalGroup, subject);
  const { scope: _scope, ...rawReview } = args;
  const review = precedentReviewSchema.parse(rawReview);
  const id = ctx.db.normalizeId("apPrecedentCandidates", review.candidateId);
  const row = id ? await ctx.db.get(id) : null;
  assertRowScope(row, args.scope);
  if (!row || row.hash !== review.expectedHash) deny("stale_precedent", "Review must bind the exact retained candidate hash");
  const proposal = precedentProposalSchema.parse(row.proposal);
  if (review.outcome === "narrow" && !review.narrowedScope) deny("narrowed_scope_required", "Record the exact narrower supplier/category/location/date scope");
  if (review.outcome !== "narrow" && review.narrowedScope) deny("unexpected_narrowing", "Only the narrow outcome can change the approved scope");
  const approvedScope = review.outcome === "reject" ? null : review.narrowedScope ?? proposal.scope;
  if (row.status !== "proposed") {
    // A lost response may replay the same immutable decision, never rewrite it or adopt another actor's review.
    const saved = row.review;
    if (saved && saved.reviewer === subject && saved.reviewerSeatId === seat.seatId &&
        canonical({ outcome: saved.outcome, reason: saved.reason, approvedScope: saved.approvedScope }) ===
        canonical({ outcome: review.outcome, reason: review.reason, approvedScope })) {
      return { candidateId: row._id, status: row.status };
    }
    deny("precedent_already_reviewed", "This immutable decision has already been recorded");
  }
  const all = await histories(ctx, args.scope);
  if (seat.seatId === row.proposedBy || all.some(h => proposal.historyIds.includes(h._id) && h.importedBy === seat.seatId)) deny("precedent_independent_review", "Source importer, proposer and final human reviewer must be independent");
  if (approvedScope && !precedentScopeIsNarrower(proposal.scope, approvedScope)) deny("scope_expansion_forbidden", "Review may only narrow the proposed scope");
  if (approvedScope) {
    const evidence = evidenceFor(all, approvedScope, proposal.coding);
    if (evidence.contradictions.length || evidence.missingContext.length) deny("unresolved_precedent_evidence", "Resolve contradictions and missing context or narrow the rule to supported evidence before approval");
    if (!policy.value.accounts.some(a => a.account === proposal.coding.accountCode) || proposal.coding.allocations.some(a => !policy.value.stores.includes(a.code)) || approvedScope.locations.some(s => !policy.value.stores.includes(s))) deny("precedent_policy_scope", "Coding accounts, allocations and locations must exist in the current approved business policy");
  }
  const decision = { outcome: review.outcome, reason: review.reason, reviewedAt: Date.now(), reviewer: subject, reviewerSeatId: seat.seatId, policyHash: policy.hash, approvedScope };
  await ctx.db.insert("apPrecedentReviews", { scope: args.scope, candidateId: row._id, candidateHash: row.hash, payload: decision, reviewer: subject, reviewerSeatId: seat.seatId, policyHash: policy.hash, reviewedAt: decision.reviewedAt });
  await ctx.db.patch(row._id, { status: approvedScope ? "approved" : "rejected", review: decision });
  await auditDemo(ctx, args.scope, subject, "coding_precedent_reviewed", { candidateId: row._id, hash: row.hash, outcome: decision.outcome, policyHash: policy.hash, authority: "recommendation_only" });
  return { candidateId: row._id, status: approvedScope ? "approved" : "rejected" };
} });
export async function recommendation(ctx: QueryCtx, scope: BankScope, context: PrecedentContext) {
  const policy = await activeBusinessPolicy(ctx, scope);
  const empty = (reason: string) => ({ status: "held" as const, coding: null, ruleIds: [] as string[], reason, requiresHumanReview: true as const, inferenceMode: "deterministic_demo" as const });
  if (!policy) return empty("No active independently approved business policy; coding precedent cannot supply authority");
  const rows = await ctx.db.query("apPrecedentCandidates").withIndex("by_run", q => q.eq("scope.runId", scope.runId)).collect();
  const all = await histories(ctx, scope);
  const applicable: { id: string; coding: PrecedentCoding }[] = [];
  for (const row of rows) {
    assertRowScope(row, scope);
    if (row.status !== "approved" || !row.review?.approvedScope) continue;
    const p = precedentProposalSchema.parse(row.proposal), review = row.review;
    if (!precedentApplies(review.approvedScope, context)) continue;
    if (review.policyHash !== policy.hash) return empty("Applicable rule was reviewed under an older policy; independent recertification required");
    try {
      requireGroup(policy.value, policy.value.supplierApprovalGroup, review.reviewer);
      const human = await assertHumanSubject(ctx, scope, review.reviewer);
      if (human.seatId !== review.reviewerSeatId || human.seatId === row.proposedBy) return empty("Reviewer identity changed; independent recertification required");
    } catch { return empty("Reviewer no longer has current business governance authority"); }
    const evidence = evidenceFor(all, review.approvedScope, p.coding);
    if (evidence.contradictions.length || evidence.missingContext.length) return empty("Retained history has unresolved contradictions or missing context; rule is held");
    applicable.push({ id: row._id, coding: p.coding });
  }
  if (!applicable.length) return empty("No currently approved rule matches this supplier, category, location and effective date; retain the human coding review");
  if (applicable.some(a => !codingEqual(a.coding, applicable[0]!.coding))) return empty("Conflicting approved rules match this case; human resolution required");
  return { status: "recommendation" as const, coding: applicable[0]!.coding, ruleIds: applicable.map(a => a.id), reason: "Current independently approved precedent matches exact scope. Coding is a recommendation; bill review and separate payment authorization remain required.", requiresHumanReview: true as const, inferenceMode: "deterministic_demo" as const };
}
export const evaluate = mutation({ args: { ...reader, context: v.any(), idempotencyKey: v.string() }, handler: async (ctx, args) => {
  const auth = await readAuth(ctx, args), context = precedentContextSchema.parse(args.context);
  const op = await replay(ctx, args.scope, `precedent-evaluation:${args.idempotencyKey}`, { context, actor: auth.seat.seatId });
  if (op.prior) return op.prior.result;
  const payload = { ...await recommendation(ctx, args.scope, context), context, evaluatedAt: Date.now() };
  const id = await ctx.db.insert("apPrecedentEvaluations", { scope: args.scope, payload, actor: auth.seat.seatId, evaluatedAt: payload.evaluatedAt });
  const result = { ...payload, id };
  await receipt(ctx, args.scope, `precedent-evaluation:${args.idempotencyKey}`, op.payloadHash, result);
  return result;
} });
export const overview = query({ args: reader, handler: async (ctx, args): Promise<PrecedentOverview> => {
  await readAuth(ctx, args);
  const policy = await activeBusinessPolicy(ctx, args.scope);
  const hs = await histories(ctx, args.scope);
  const cs = await ctx.db.query("apPrecedentCandidates").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect();
  const es = await ctx.db.query("apPrecedentEvaluations").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect();
  cs.forEach(r => assertRowScope(r, args.scope)); es.forEach(r => assertRowScope(r, args.scope));
  return {
    histories: hs.map(h => ({ ...precedentHistorySchema.parse(h.payload), id: h._id, hash: h.hash, importedAt: h.importedAt, importedBy: h.importedBy, recordPurpose: "non_posting_historical_evidence" })),
    candidates: cs.map(c => ({ ...precedentProposalSchema.parse(c.proposal), id: c._id, hash: c.hash, support: c.support, contradictions: c.contradictions, missingContext: c.missingContext, status: c.status, proposedBy: c.proposedBy, createdAt: c.createdAt, inferenceMode: "deterministic_demo", humanReview: c.review ?? null } satisfies PrecedentCandidate)),
    evaluations: es.map(e => ({ ...e.payload, id: e._id } as PrecedentEvaluation)),
    authority: { policyReady: !!policy, reviewGroup: policy?.value.supplierApprovalGroup ?? null }, demoCases: PRECEDENT_DEMO_CASES,
  };
} });
/** Small transparent teaching fixture. Does not create a policy or impersonate its human reviewer. */
export const seedDemo = mutation({ args: { ...agent, idempotencyKey: v.string() }, handler: async (ctx, args) => {
  const { seat } = await requirePaymentSeat(ctx, args, ["ap_clerk", "controller"]);
  const op = await replay(ctx, args.scope, `precedent-demo:${args.idempotencyKey}`, { fixture: "hyphenate-coding-v1", actor: seat.seatId });
  if (op.prior) return op.prior.result;
  const context = { ...PRECEDENT_DEMO_CASES[0]!.context, effectiveOn: "2026-10-20", amountCents: 8000 };
  const text = "SYNTHETIC TRAINING HISTORY A — not a payable. CleanCo routine store cleaning, SF Hayes Valley, 2026-10-20, USD 80.00. Original imported coding: inventory 1200, 100% SF Hayes Valley. Proposal and finalized historical outcome: expense 5000, 100% SF Hayes Valley. Reason: routine cleaning consumed in the current period; no inventory or capital improvement. This is a supplied synthetic correction example, not a real model inference or practitioner sign-off.";
  const source = { sourceId: "hyphenate-history-a-v1", revision: 1, sha256: await sha256Hex(text), name: "Synthetic history A — original and correction record.txt", text, provenance: "synthetic" as const };
  const binding = { sourceId: source.sourceId, revision: source.revision, sha256: source.sha256 };
  const allocation = [{ dimension: "store" as const, code: "sf-hayes-valley", basisPoints: 10000 }];
  const coding = { accountCode: "5000", allocations: allocation };
  const history: PrecedentHistoryInput = { externalId: "hyphenate-history-a-v1", sourceCaseId: "synthetic-historical-case-A", sourceCaseRevision: 1, sourceCaseSnapshotHash: await sha256Hex(canonical({ context, sourceBindings: [binding] })), context, originalCoding: { accountCode: "1200", allocations: allocation }, proposedCoding: coding, finalCoding: coding, correctionReason: "Routine cleaning is period expense rather than inventory; preserve the store allocation. Capital renovation is outside this rule.", sources: [source], sourceBindings: [binding], contradictions: [], missingContext: [], provenance: "synthetic" };
  const historyId = await saveHistory(ctx, args.scope, seat.seatId, history);
  const candidate = await saveCandidate(ctx, args.scope, seat.seatId, { historyIds: [historyId], scope: { supplierId: context.supplierId, category: context.category, locations: [context.location], effectiveFrom: "2026-10-01", effectiveUntil: "2026-12-31" }, coding, reason: "Deterministic candidate from synthetic correction A; independent human review required before reuse on held-out B. Counterexample C is capital renovation and must remain held." });
  const result = { historyId, ...candidate, inferenceMode: "deterministic_demo", createsPayable: false };
  await receipt(ctx, args.scope, `precedent-demo:${args.idempotencyKey}`, op.payloadHash, result);
  return result;
} });

/** Withdrawal is immediate; case-bound reads recheck this status before returning any saved advice. */
export const disableRule = mutation({args:{scope:scopeValidator,candidateId:v.string(),expectedHash:v.string(),reason:v.string()},handler:async(ctx,args)=>{
 const {subject}=await requirePaymentHuman(ctx,args.scope),policy=await requireBusinessPolicy(ctx,args.scope);
 requireGroup(policy.value,policy.value.supplierApprovalGroup,subject);
 const id=ctx.db.normalizeId("apPrecedentCandidates",args.candidateId),row=id?await ctx.db.get(id):null;
 assertRowScope(row,args.scope);
 if(!row||row.hash!==args.expectedHash)deny("stale_precedent","Exact rule hash required");
 if(!args.reason.trim())deny("reason_required","Withdrawal reason required");
 await ctx.db.patch(row._id,{status:"disabled"});
 await auditDemo(ctx,args.scope,subject,"coding_precedent_disabled",{candidateId:row._id,hash:row.hash,reason:args.reason});
 return {candidateId:row._id,status:"disabled"};
}});
