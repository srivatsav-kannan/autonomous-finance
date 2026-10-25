import { defineTable } from "convex/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
/** Deliberately separate from payable, journal and payment tables: history is evidence only. */
export const apPrecedentTables = {
  apPrecedentHistory: defineTable({ scope: scopeValidator, externalId: v.string(), hash: v.string(), payload: v.any(), importedBy: v.string(), importedAt: v.number() }).index("by_run", ["scope.runId"]).index("by_external", ["scope.runId", "externalId"]),
  apPrecedentCandidates: defineTable({ scope: scopeValidator, hash: v.string(), proposal: v.any(), support: v.any(), contradictions: v.any(), missingContext: v.array(v.string()), status: v.union(v.literal("proposed"), v.literal("approved"), v.literal("rejected")), proposedBy: v.string(), createdAt: v.number(), review: v.optional(v.any()) }).index("by_run", ["scope.runId"]),
  apPrecedentReviews: defineTable({ scope: scopeValidator, candidateId: v.id("apPrecedentCandidates"), candidateHash: v.string(), payload: v.any(), reviewer: v.string(), reviewerSeatId: v.string(), policyHash: v.string(), reviewedAt: v.number() }).index("by_candidate", ["scope.runId", "candidateId"]),
  apPrecedentEvaluations: defineTable({ scope: scopeValidator, payload: v.any(), actor: v.string(), evaluatedAt: v.number() }).index("by_run", ["scope.runId"]),
};
