import { defineTable } from "convex/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";

/** Shared payloads are validated with ap-evidence-v1 before storage. */
export const apSystemTables = {
  apCreditApplications: defineTable({
    scope: scopeValidator,
    caseId: v.id("apCaseRecords"),
    billId: v.id("demoBills"),
    creditId: v.id("demoCredits"),
    amountCents: v.number(),
    requestKey: v.string(),
    actor: v.string(),
    at: v.number(),
  }).index("by_bill", ["scope.runId", "billId"]),
  apBusinessPolicies: defineTable({
    scope: scopeValidator,
    version: v.string(),
    hash: v.string(),
    policy: v.any(),
    status: v.string(),
    proposedBy: v.string(),
    approvedBy: v.optional(v.string()),
    createdAt: v.number(),
    approvedAt: v.optional(v.number()),
  })
    .index("by_run", ["scope.runId"])
    .index("by_version", ["scope.runId", "version"]),
  apSupplierContacts: defineTable({
    scope: scopeValidator,
    supplierId: v.string(),
    phone: v.string(),
    evidence: v.any(),
    mode: v.string(),
    recordedBy: v.string(),
    createdAt: v.number(),
  }).index("by_supplier", ["scope.runId", "supplierId"]),
  apSuppliers: defineTable({
    scope: scopeValidator,
    supplierId: v.string(),
    activeRevision: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_supplier", ["scope.runId", "supplierId"]),
  apSupplierRevisions: defineTable({
    scope: scopeValidator,
    supplierId: v.string(),
    revision: v.number(),
    proposal: v.any(),
    hash: v.string(),
    status: v.string(),
    proposedBy: v.string(),
    verification: v.optional(v.any()),
    verifiedBy: v.optional(v.string()),
    approvedBy: v.optional(v.string()),
    createdAt: v.number(),
    approvedAt: v.optional(v.number()),
  }).index("by_supplier", ["scope.runId", "supplierId", "revision"]),
  apApprovalProposals: defineTable({
    scope: scopeValidator,
    caseId: v.id("apCaseRecords"),
    request: v.any(),
    hash: v.string(),
    policyHash: v.string(),
    supplierHash: v.string(),
    amountCents: v.number(),
    route: v.any(),
    stage: v.number(),
    stageStartedAt: v.number(),
    votes: v.any(),
    status: v.string(),
    proposedBy: v.string(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    entryId: v.optional(v.id("journalEntries")),
  })
    .index("by_case", ["scope.runId", "caseId"])
    .index("by_run", ["scope.runId"]),
  apDelegations: defineTable({
    scope: scopeValidator,
    grantor: v.string(),
    delegation: v.any(),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_run", ["scope.runId"]),
  apReceiptConsumptions: defineTable({
    scope: scopeValidator,
    caseId: v.id("apCaseRecords"),
    billId: v.id("demoBills"),
    approvalId: v.id("apApprovalProposals"),
    sourceId: v.string(),
    sourceRevision: v.number(),
    sourceHash: v.string(),
    lineId: v.string(),
    quantity: v.string(),
    capacity: v.string(),
    invoiceLineId: v.string(),
    sku: v.string(),
    unit: v.string(),
    kind: v.string(),
  })
    .index("by_source_line", ["scope.runId", "sourceId", "lineId"])
    .index("by_bill", ["scope.runId", "billId"]),
  apCreditLinks: defineTable({
    scope: scopeValidator,
    caseId: v.id("apCaseRecords"),
    originalCaseId: v.id("apCaseRecords"),
    originalBillId: v.id("demoBills"),
    originalApprovalId: v.id("apApprovalProposals"),
    creditId: v.id("demoCredits"),
    approvalId: v.id("apApprovalProposals"),
    plan: v.any(),
    allocations: v.any(),
    amountCents: v.number(),
    entryId: v.id("journalEntries"),
    createdAt: v.number(),
  })
    .index("by_original", ["scope.runId", "originalBillId"])
    .index("by_case", ["scope.runId", "caseId"])
    .index("by_credit", ["scope.runId", "creditId"]),
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
    domainApprovalId: v.optional(v.id("apApprovalProposals")),
    creditId: v.optional(v.id("demoCredits")),
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
