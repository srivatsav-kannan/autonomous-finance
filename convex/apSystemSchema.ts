import { defineTable } from "convex/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";

/** Shared payloads are validated with ap-evidence-v1 before storage. */
export const apSystemTables = {
  apCaseRecords: defineTable({
    scope: scopeValidator,
    obligationKey: v.optional(v.string()),
    primaryHash: v.string(),
    currentRevision: v.number(),
    snapshotHash: v.string(),
    intake: v.any(),
    createdBy: v.string(),
    documentStatus: v.union(
      v.literal("review_required"),
      v.literal("reviewed"),
      v.literal("failed"),
    ),
    businessStatus: v.union(
      v.literal("unreviewed"),
      v.literal("held"),
      v.literal("approved"),
      v.literal("rejected"),
    ),
    fieldReviewId: v.optional(v.string()),
    billId: v.optional(v.id("demoBills")),
    acceptedCents: v.optional(v.number()),
    identityMode: v.union(
      v.literal("simulated_human"),
      v.literal("authenticated_human"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_run", ["scope.runId"])
    .index("by_obligation", ["scope.runId", "obligationKey"])
    .index("by_hash", ["scope.runId", "primaryHash"])
    .index("by_bill", ["scope.runId", "billId"]),
  apCaseRevisions: defineTable({
    scope: scopeValidator,
    caseId: v.id("apCaseRecords"),
    revision: v.number(),
    intake: v.any(),
    snapshotHash: v.string(),
    actor: v.string(),
    at: v.number(),
  }).index("by_case", ["scope.runId", "caseId", "revision"]),
  apCaseSources: defineTable({
    scope: scopeValidator,
    sourceId: v.string(),
    revision: v.number(),
    sha256: v.string(),
    document: v.any(),
  }).index("by_source", ["scope.runId", "sourceId", "revision"]),
  apCaseSourceChunks: defineTable({
    scope: scopeValidator,
    sourceId: v.string(),
    revision: v.number(),
    sha256: v.string(),
    index: v.number(),
    content: v.string(),
  }).index("by_source", ["scope.runId", "sourceId", "revision", "index"]),
  apCaseDeliveries: defineTable({
    scope: scopeValidator,
    caseId: v.id("apCaseRecords"),
    deliveryId: v.string(),
    sourceId: v.string(),
    revision: v.number(),
    sha256: v.string(),
    name: v.string(),
    at: v.number(),
  })
    .index("by_delivery", ["scope.runId", "deliveryId"])
    .index("by_case", ["scope.runId", "caseId"]),
  apCaseDecisions: defineTable({
    scope: scopeValidator,
    caseId: v.id("apCaseRecords"),
    decision: v.any(),
  }).index("by_case", ["scope.runId", "caseId"]),
  apCaseOperations: defineTable({
    scope: scopeValidator,
    key: v.string(),
    payloadHash: v.string(),
    result: v.any(),
  }).index("by_key", ["scope.runId", "key"]),
};
