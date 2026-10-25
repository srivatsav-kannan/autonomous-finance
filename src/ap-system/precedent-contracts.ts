import { z } from "zod";
import { sourceBindingSchema } from "./contracts";
const text = z.string().trim().min(1).max(2000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v), "Valid calendar date required");
export const precedentCodingSchema = z.object({
  accountCode: text,
  allocations: z.array(z.object({ dimension: z.literal("store"), code: text, basisPoints: z.number().int().positive().max(10000) })).min(1).max(20),
}).strict().refine(v => v.allocations.reduce((n, a) => n + a.basisPoints, 0) === 10000, "Allocations must total 10000 basis points").refine(v => new Set(v.allocations.map(a => `${a.dimension}:${a.code}`)).size === v.allocations.length, "Duplicate allocation");
export const precedentContextSchema = z.object({ supplierId: text, category: text, location: text, effectiveOn: date, currency: z.literal("USD"), amountCents: z.number().int().positive().safe() }).strict();
export const precedentScopeSchema = z.object({ supplierId: text, category: text, locations: z.array(text).min(1).max(20), effectiveFrom: date, effectiveUntil: date }).strict().refine(v => v.effectiveFrom <= v.effectiveUntil, "Invalid effective range").refine(v => new Set(v.locations).size === v.locations.length, "Duplicate location");
export const precedentSourceSchema = z.object({ ...sourceBindingSchema.shape, name: text, text: z.string().min(1).max(100000), provenance: z.enum(["synthetic", "imported"]) }).strict();
export const precedentHistorySchema = z.object({
  externalId: text, sourceCaseId: text, sourceCaseRevision: z.number().int().positive(), sourceCaseSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  context: precedentContextSchema, originalCoding: precedentCodingSchema, proposedCoding: precedentCodingSchema, finalCoding: precedentCodingSchema,
  correctionReason: text, sourceBindings: z.array(sourceBindingSchema).min(1), sources: z.array(precedentSourceSchema).min(1).max(20),
  contradictions: z.array(text).max(20), missingContext: z.array(text).max(20),
  provenance: z.enum(["synthetic", "imported"]),
}).strict();
export const precedentProposalSchema = z.object({ historyIds: z.array(text).min(1).max(50), scope: precedentScopeSchema, coding: precedentCodingSchema, reason: text }).strict();
export const precedentReviewSchema = z.object({ candidateId: text, expectedHash: z.string().regex(/^[a-f0-9]{64}$/), outcome: z.enum(["accept", "narrow", "reject"]), reason: text, narrowedScope: precedentScopeSchema.optional() }).strict();
export type PrecedentCoding = z.infer<typeof precedentCodingSchema>;
export type PrecedentContext = z.infer<typeof precedentContextSchema>;
export type PrecedentScope = z.infer<typeof precedentScopeSchema>;
export type PrecedentHistoryInput = z.infer<typeof precedentHistorySchema>;
export type PrecedentReviewInput = z.infer<typeof precedentReviewSchema>;
export type PrecedentHistory = PrecedentHistoryInput & { id: string; hash: string; importedAt: number; importedBy: string; recordPurpose: "non_posting_historical_evidence" };
export type PrecedentEvidence = { historyId: string; sourceCaseId: string; revision: number; sourceBindings: z.infer<typeof sourceBindingSchema>[]; reason: string };
export type PrecedentCandidate = {
  id: string; hash: string; scope: PrecedentScope; coding: PrecedentCoding; historyIds: string[]; reason: string; status: "proposed" | "approved" | "rejected" | "disabled";
  support: PrecedentEvidence[]; contradictions: PrecedentEvidence[]; missingContext: string[]; inferenceMode: "deterministic_demo"; proposedBy: string; createdAt: number;
  humanReview: null | { outcome: "accept" | "narrow" | "reject"; reason: string; reviewedAt: number; reviewer: string; policyHash: string; approvedScope: PrecedentScope | null };
};
export type PrecedentEvaluation = { id: string; context: PrecedentContext; status: "recommendation" | "held"; coding: PrecedentCoding | null; ruleIds: string[]; reason: string; requiresHumanReview: true; evaluatedAt: number; inferenceMode: "deterministic_demo" };
export type PrecedentOverview = { histories: PrecedentHistory[]; candidates: PrecedentCandidate[]; evaluations: PrecedentEvaluation[]; authority: { policyReady: boolean; reviewGroup: string | null }; demoCases: { key: "B" | "C"; context: PrecedentContext }[] };
export const PRECEDENT_DEMO_CASES: PrecedentOverview["demoCases"] = [
  { key: "B", context: { supplierId: "hyphenate-demo-cleaning", category: "routine_cleaning", location: "sf-hayes-valley", effectiveOn: "2026-10-25", currency: "USD", amountCents: 8500 } },
  { key: "C", context: { supplierId: "hyphenate-demo-cleaning", category: "capital_renovation", location: "sf-hayes-valley", effectiveOn: "2026-10-25", currency: "USD", amountCents: 250000 } },
];
export function precedentApplies(scope: PrecedentScope, context: PrecedentContext) { return scope.supplierId === context.supplierId && scope.category === context.category && scope.locations.includes(context.location) && scope.effectiveFrom <= context.effectiveOn && scope.effectiveUntil >= context.effectiveOn; }
export function precedentScopeIsNarrower(original: PrecedentScope, next: PrecedentScope) { return original.supplierId === next.supplierId && original.category === next.category && next.locations.every(v => original.locations.includes(v)) && next.effectiveFrom >= original.effectiveFrom && next.effectiveUntil <= original.effectiveUntil; }
