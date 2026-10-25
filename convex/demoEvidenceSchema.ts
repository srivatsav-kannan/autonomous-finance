import { defineTable } from "convex/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";

export const transactionValidator = v.object({
  id: v.string(), scope: scopeValidator, transferId: v.string(), commandId: v.string(),
  amountCents: v.number(), currency: v.literal("USD"), status: v.union(v.literal("pending"), v.literal("complete"), v.literal("posted")),
  purpose: v.union(v.literal("debit"), v.literal("return")), createdAt: v.string(),
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
  }).index("by_event", ["scope.runId", "eventId"]).index("by_run", ["scope.runId"]),
  demoTransactions: defineTable({
    scope: scopeValidator, transaction: transactionValidator,
    commandRowId: v.optional(v.id("demoCommands")), entryId: v.optional(v.id("journalEntries")),
    state: v.union(v.literal("unmatched"), v.literal("ready"), v.literal("posted"), v.literal("exception")),
    error: v.optional(v.string()), importedAt: v.number(), matchedAt: v.optional(v.number()),
  }).index("by_transaction", ["scope.runId", "transaction.id"]).index("by_run", ["scope.runId"]),
  demoObservations: defineTable({
    scope: scopeValidator, transferId: v.string(), observation: observationValidator, importedAt: v.number(),
  }).index("by_transfer", ["scope.runId", "transferId"]).index("by_run", ["scope.runId"]),
  demoCursors: defineTable({
    scope: scopeValidator, cursor: v.union(v.string(), v.null()), updatedAt: v.number(),
  }).index("by_run", ["scope.runId"]),
  demoReconciliationProposals: defineTable({
    scope: scopeValidator, transactionId: v.string(), commandId: v.string(), proposedBy: v.string(), note: v.string(), at: v.number(),
  }).index("by_run", ["scope.runId"]),
};
