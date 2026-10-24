import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { BackendResult, CaseDetail, CaseSummary, DecisionResult, IngestBatchResult, SubmitProposalResult, WorkspaceSnapshot } from "../src/invoice-mvp/contracts";

export const seatArgs = { runId: v.string(), seatId: v.string(), token: v.string() };
export const evidenceValidator = v.object({ documentId: v.string(), version: v.number(), contentHash: v.string(), quote: v.optional(v.string()) });
export const modeValidator = v.union(v.literal("deterministic"), v.literal("mock_model"), v.literal("live_model"));
export const sourceValidator = v.object({ externalId: v.string(), name: v.string(), mimeType: v.string(), text: v.string(), contentBase64: v.optional(v.string()), replacesExternalId: v.optional(v.string()) });
export const conclusionValidator = v.object({
  treatment: v.union(v.literal("include_invoice"), v.literal("include_credit"), v.literal("exclude"), v.literal("needs_evidence")),
  customerId: v.optional(v.string()), customerName: v.optional(v.string()), documentNumber: v.optional(v.string()), amountCents: v.optional(v.number()),
  reason: v.string(), evidence: v.array(evidenceValidator), contradictions: v.array(v.string()), missingEvidence: v.array(v.string()),
  question: v.optional(v.string()), category: v.optional(v.string()), supersedesDocumentId: v.optional(v.string()),
});
export const toolCallValidator = v.object({ tool: v.string(), summary: v.string(), mode: modeValidator, model: v.optional(v.string()), evidence: v.array(evidenceValidator), inputTokens: v.optional(v.number()), outputTokens: v.optional(v.number()), costMicros: v.optional(v.number()), durationMs: v.optional(v.number()) });

// Signature-first handoff. These fail closed until the implementation commit lands.
const pending = <T>(): BackendResult<T> => ({ ok: false, code: "not_implemented", error: "Invoice case backend implementation pending" });
export const workspace = query({ args: seatArgs, handler: async (): Promise<BackendResult<WorkspaceSnapshot>> => pending() });
export const caseDetail = query({ args: { ...seatArgs, caseId: v.string() }, handler: async (): Promise<BackendResult<CaseDetail>> => pending() });
export const pendingCases = query({ args: seatArgs, handler: async (): Promise<BackendResult<CaseSummary[]>> => pending() });
export const ingestBatch = mutation({ args: { ...seatArgs, label: v.string(), documents: v.array(sourceValidator), idempotencyKey: v.string() }, handler: async (): Promise<BackendResult<IngestBatchResult>> => pending() });
export const beginInvestigation = mutation({ args: { ...seatArgs, caseId: v.string() }, handler: async (): Promise<BackendResult<CaseSummary>> => pending() });
export const submitProposal = mutation({ args: { ...seatArgs, caseId: v.string(), evidenceVersion: v.number(), conclusion: conclusionValidator, mode: modeValidator, model: v.optional(v.string()), idempotencyKey: v.string() }, handler: async (): Promise<BackendResult<SubmitProposalResult>> => pending() });
export const decide = mutation({ args: { ...seatArgs, caseId: v.string(), proposalId: v.string(), evidenceVersion: v.number(), idempotencyKey: v.string(), action: v.union(v.literal("accept"), v.literal("exclude"), v.literal("request_evidence")), note: v.optional(v.string()) }, handler: async (): Promise<BackendResult<DecisionResult>> => pending() });
export const registerCustomer = mutation({ args: { ...seatArgs, customerId: v.string(), legalName: v.string(), aliases: v.array(v.string()), evidence: v.array(evidenceValidator), idempotencyKey: v.string() }, handler: async (): Promise<BackendResult<{ customerId: string }>> => pending() });
export const recordToolCall = mutation({ args: { ...seatArgs, caseId: v.string(), evidenceVersion: v.number(), call: toolCallValidator, idempotencyKey: v.string() }, handler: async (): Promise<BackendResult<{ auditId: string }>> => pending() });
