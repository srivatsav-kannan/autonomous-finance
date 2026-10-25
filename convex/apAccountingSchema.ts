import { defineTable } from "convex/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
/** Immutable proposals for replicating existing verified journals; never money execution. */
export const apAccountingTables = {
  apAccountingCorrections: defineTable({
    scope: scopeValidator,
    caseId: v.id("apCaseRecords"),
    identity: v.string(),
    request: v.any(),
    payload: v.any(),
    hash: v.string(),
    policyHash: v.string(),
    supplierHash: v.string(),
    amountCents: v.number(),
    route: v.any(),
    stage: v.number(),
    stageStartedAt: v.number(),
    votes: v.any(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
    ),
    proposedBy: v.string(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_case", ["scope.runId", "caseId"])
    .index("by_identity", ["scope.runId", "identity"]),
};
