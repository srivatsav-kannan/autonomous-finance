import { defineTable } from "convex/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";

export const transactionValidator = v.object({
  id: v.string(), scope: scopeValidator, transferId: v.string(), commandId: v.string(),
  amountCents: v.number(), currency: v.literal("USD"), status: v.union(v.literal("pending"), v.literal("complete"), v.literal("posted")),
  purpose: v.union(v.literal("debit"), v.literal("return"), v.literal("other")), createdAt: v.string(),
  sourceCategory: v.optional(v.string()),
  postedAt: v.optional(v.string()), completedAt: v.optional(v.string()), originalTransactionId: v.optional(v.string()),
});
export const observationValidator = v.object({
  id: v.string(), scope: scopeValidator, commandId: v.string(), requestHash: v.string(),
  idempotencyKey: v.string(), amountCents: v.number(), currency: v.literal("USD"),
  destination: v.object({ externalAccountId: v.string(), version: v.string() }),
  status: v.union(v.literal("pending"), v.literal("settled"), v.literal("rejected"), v.literal("returned")),
  createdAt: v.string(), updatedAt: v.string(), pendingTransactionId: v.optional(v.string()),
  originalTransactionId: v.optional(v.string()), returnTransactionId: v.optional(v.string()),
  rejectionReason: v.optional(v.string()),
});
export const demoEvidenceTables = {
  demoInbox: defineTable({
    scope: scopeValidator, eventId: v.string(), transferId: v.optional(v.string()), transactionId: v.optional(v.string()),
    bodyHash: v.string(), receivedAt: v.number(), processed: v.boolean(), error: v.optional(v.string()),
    ignoredResource: v.optional(v.object({ resourceType: v.union(v.literal("ach_transfer"), v.literal("transaction")), resourceId: v.string(), accountId: v.string(), verifiedAt: v.number() })),
  }).index("by_event", ["scope.runId", "eventId"]).index("by_run", ["scope.runId"])
    .index("by_run_processed", ["scope.runId", "processed", "receivedAt"]),
  demoTransactions: defineTable({
    scope: scopeValidator, transaction: transactionValidator,
    commandRowId: v.optional(v.id("demoCommands")), entryId: v.optional(v.id("journalEntries")),
    // prior_activity: unlinked activity created before the run's configured activitySince.
    // It is retained for audit, never posted by the worker and never a close blocker.
    state: v.union(v.literal("unmatched"), v.literal("ready"), v.literal("posted"), v.literal("exception"), v.literal("prior_activity")),
    error: v.optional(v.string()), importedAt: v.number(), matchedAt: v.optional(v.number()),
    fundingApproval: v.optional(v.object({ subject: v.string(), reason: v.string(), at: v.number() })),
  }).index("by_transaction", ["scope.runId", "transaction.id"]).index("by_run", ["scope.runId"])
    .index("by_run_state", ["scope.runId", "state", "importedAt"]),
  /** Listed bank rows that could not be verified. Open rows are retried and block close. */
  demoEvidenceRetries: defineTable({
    scope: scopeValidator, transactionId: v.string(), open: v.boolean(), errorClass: v.string(), error: v.string(),
    attempts: v.number(), firstFailedAt: v.number(), lastFailedAt: v.number(), nextAttemptAt: v.number(),
    resolvedAt: v.optional(v.number()),
  }).index("by_transaction", ["scope.runId", "transactionId"]).index("by_run_open", ["scope.runId", "open", "firstFailedAt"]),
  /** Wall-clock worker health, written by each service pass. Never financial evidence. */
  demoWorkerHealth: defineTable({
    scope: scopeValidator, worker: v.union(v.literal("dispatcher"), v.literal("evidence")), workerId: v.string(),
    lastPassAt: v.number(), lastSuccessAt: v.optional(v.number()), lastFailureAt: v.optional(v.number()),
    lastOutcome: v.string(), lastErrorClass: v.optional(v.string()), consecutiveFailures: v.number(),
  }).index("by_worker", ["scope.runId", "worker"]),
  demoObservations: defineTable({
    scope: scopeValidator, transferId: v.string(), observation: observationValidator, importedAt: v.number(),
  }).index("by_transfer", ["scope.runId", "transferId"]).index("by_run", ["scope.runId"]),
  demoCursors: defineTable({
    scope: scopeValidator, cursor: v.union(v.string(), v.null()), updatedAt: v.number(),
    // Last time a page with no further pages was imported, i.e. a complete scan.
    scanCompletedAt: v.optional(v.number()),
  }).index("by_run", ["scope.runId"]),
  demoReconciliationProposals: defineTable({
    scope: scopeValidator, transactionId: v.string(), commandId: v.string(), proposedBy: v.string(), note: v.string(), at: v.number(),
  }).index("by_run", ["scope.runId"]),
};
