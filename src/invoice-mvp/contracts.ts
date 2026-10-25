/** Shared wire contract. Amounts are integer USD cents, never cash balances. */
export type RuntimeMode = "deterministic" | "mock_model" | "live_model";
export type SourceInput = { externalId: string; name: string; mimeType: string; text: string; contentBase64?: string; replacesExternalId?: string };
export type EvidenceRef = { documentId: string; version: number; contentHash: string; quote?: string };
export type Treatment = "include_invoice" | "include_credit" | "exclude" | "needs_evidence";
export type Conclusion = {
  treatment: Treatment; customerId?: string; customerName?: string; documentNumber?: string;
  amountCents?: number; reason: string; evidence: EvidenceRef[]; contradictions: string[];
  missingEvidence: string[]; question?: string; category?: string; supersedesDocumentId?: string;
};
export type CaseStatus = "received" | "investigating" | "needs_review" | "evidence_missing" | "recorded" | "excluded" | "superseded" | "duplicate";
export type DecisionInput = {
  caseId: string; proposalId: string; evidenceVersion: number; idempotencyKey: string;
  action: "accept" | "exclude" | "request_evidence"; note?: string;
};
export type SeatAuth = { runId: string; seatId: string; token: string };
export type BackendResult<T> = { ok: true; value: T; replayed?: boolean } | { ok: false; code: string; error: string };
export type SourceVersion = SourceInput & EvidenceRef & { caseId: string; batchId: string; createdAt: number; canonicalDocumentId?: string };
export type Proposal = {
  proposalId: string; caseId: string; evidenceVersion: number; conclusion: Conclusion;
  author: string; mode: RuntimeMode; model?: string; createdAt: number;
};
export type CaseSummary = {
  caseId: string; batchId: string; documentId: string; externalId: string; name: string;
  version: number; contentHash: string; status: CaseStatus; evidenceVersion: number;
  currentProposalId?: string; acceptedProposalId?: string; canonicalDocumentId?: string;
  reason?: string; customerId?: string; question?: string; contradictions: string[];
  missingEvidence: string[]; createdAt: number; updatedAt: number;
};
export type AuditEntry = {
  auditId: string; caseId: string; kind: string; summary: string; actor: string; at: number;
  proposalId?: string; evidenceVersion?: number; toolCall?: ToolCallInput;
};
export type RecordedDecision = DecisionInput & { decisionId: string; actor: string; createdAt: number };
export type Contribution = {
  contributionId: string; caseId: string; documentId: string; proposalId: string;
  customerId: string; documentNumber: string; kind: "invoice" | "credit"; amountCents: number;
  evidence: EvidenceRef[]; active: boolean; createdAt: number;
};
export type CustomerTotal = {
  customerId: string; legalName: string; aliases: string[]; validInvoiceCount: number;
  grossCents: number; creditCents: number; netCents: number; contributions: Contribution[];
};
export type CaseDetail = {
  case: CaseSummary; source: SourceVersion; sourceVersions: SourceVersion[];
  proposals: Proposal[]; currentProposal?: Proposal; acceptedProposal?: Proposal;
  decisions: RecordedDecision[]; audit: AuditEntry[]; contributions: Contribution[];
};
export type WorkspaceSnapshot = {
  runId: string; company: string; currency: "USD"; runtimeMode: RuntimeMode;
  identity: { seatId: string; kind: "agent" | "human"; simulated: true };
  batches: { batchId: string; label: string; documentIds: string[]; createdAt: number }[];
  cases: CaseSummary[]; customerTotals: CustomerTotal[];
  progress: { total: number; pending: number; needsReview: number; evidenceMissing: number; recorded: number; excluded: number; duplicate: number; superseded: number };
};
export type ToolCallInput = {
  tool: string; summary: string; mode: RuntimeMode; model?: string; evidence: EvidenceRef[];
  inputTokens?: number; outputTokens?: number; costMicros?: number; durationMs?: number;
};
export type IngestBatchInput = { label: string; documents: SourceInput[]; idempotencyKey: string };
export type IngestBatchResult = { batchId: string; caseIds: string[]; documentIds: string[] };
export type SubmitProposalInput = {
  caseId: string; evidenceVersion: number; conclusion: Conclusion; mode: RuntimeMode;
  model?: string; idempotencyKey: string;
};
export type SubmitProposalResult = { proposalId: string; case: CaseSummary };
export type DecisionResult = { decisionId: string; case: CaseSummary };
export type RegisterCustomerInput = { customerId: string; legalName: string; aliases: string[]; evidence: EvidenceRef[]; idempotencyKey: string };
/** HTTP errors use this shape; gateway maps backend codes to 400/401/403/409. */
export type ApiError = { error: { code: string; message: string } };

/** Reservations are charged before a provider call and never refunded automatically. */
export type ModelBudget = { maxRequests: number; maxCostMicros: number; requestsReserved: number; costReservedMicros: number };
export type ReserveModelRequestInput = {
  caseId: string; evidenceVersion: number; idempotencyKey: string; model: string;
  maxCostMicros: number; budget: { maxRequests: number; maxCostMicros: number };
};
export type ModelReservationResult = ModelBudget & { reservationId: string };
