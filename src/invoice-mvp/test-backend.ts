// Test double only. Production never imports this module or persists here.
import { createHash } from "node:crypto";
import type { InvoiceBackend } from "./backend";
import { InvoiceError } from "./backend";
import type { CaseDetail, CaseSummary, DecisionInput, IngestBatchInput, RegisterCustomerInput, SubmitProposalInput, ToolCallInput, WorkspaceSnapshot } from "./contracts";

export class TestBackend implements InvoiceBackend {
  details = new Map<string, CaseDetail>();
  calls: string[] = [];
  snapshot: WorkspaceSnapshot = { runId: "test-only", company: "Synthetic test", currency: "USD", runtimeMode: "deterministic", identity: { seatId: "human", kind: "human", simulated: true }, batches: [], cases: [], customerTotals: [], progress: { total: 0, pending: 0, needsReview: 0, evidenceMissing: 0, recorded: 0, excluded: 0, duplicate: 0, superseded: 0 } };
  async workspace() { return { ...this.snapshot, cases: [...this.details.values()].map((d) => d.case) }; }
  async caseDetail(caseId: string) { const d = this.details.get(caseId); if (!d) throw new InvoiceError("not_found", "No such test case"); return structuredClone(d); }
  async pendingCases() { return [...this.details.values()].map((d) => d.case).filter((c) => ["received", "investigating"].includes(c.status)); }
  async ingestBatch(input: IngestBatchInput) {
    this.calls.push("ingest");
    const batchId = `batch-${this.details.size}`;
    const caseIds: string[] = [];
    for (const source of input.documents) {
      const caseId = `case-${this.details.size}`, documentId = `document-${this.details.size}`, contentHash = createHash("sha256").update(source.text).digest("hex");
      const summary: CaseSummary = { caseId, documentId, externalId: source.externalId, name: source.name, contentHash, batchId, version: 1, status: "received", evidenceVersion: 1, contradictions: [], missingEvidence: [], createdAt: 0, updatedAt: 0 };
      const version = { ...source, documentId, version: 1, contentHash, caseId, batchId, createdAt: 0 };
      this.details.set(caseId, { case: summary, source: version, sourceVersions: [version], proposals: [], decisions: [], audit: [], contributions: [] });
      caseIds.push(caseId);
    }
    return { batchId, caseIds, documentIds: caseIds.map((id) => this.details.get(id)!.source.documentId) };
  }
  async beginInvestigation(caseId: string) { const d = this.details.get(caseId)!; d.case.status = "investigating"; return d.case; }
  async submitProposal(input: SubmitProposalInput) {
    const d = this.details.get(input.caseId)!;
    const proposal = { ...input, proposalId: `proposal-${d.proposals.length}`, author: "investigator", createdAt: 0 };
    d.proposals.push(proposal); d.currentProposal = proposal; d.case.currentProposalId = proposal.proposalId;
    d.case.status = input.conclusion.treatment === "needs_evidence" ? "evidence_missing" : input.mode !== "deterministic" || input.conclusion.contradictions.length ? "needs_review" : input.conclusion.treatment === "exclude" ? "excluded" : "recorded";
    return { proposalId: proposal.proposalId, case: d.case };
  }
  async decide(input: DecisionInput) {
    const d = this.details.get(input.caseId)!;
    if (d.case.currentProposalId !== input.proposalId) throw new InvoiceError("stale_proposal", "Proposal changed.");
    d.case.status = input.action === "accept" ? "recorded" : input.action === "exclude" ? "excluded" : "evidence_missing";
    const decision = { ...input, decisionId: `decision-${d.decisions.length}`, actor: "human", createdAt: 0 };
    d.decisions.push(decision);
    return { decisionId: decision.decisionId, case: d.case };
  }
  async registerCustomer(input: RegisterCustomerInput) { this.calls.push("registerCustomer"); return { customerId: input.customerId }; }
  async recordToolCall(caseId: string, evidenceVersion: number, call: ToolCallInput, idempotencyKey: string) {
    const d = this.details.get(caseId)!;
    if (!d.audit.some((a) => a.auditId === idempotencyKey)) d.audit.push({ auditId: idempotencyKey, caseId, evidenceVersion, actor: "investigator", at: 0, kind: "tool", summary: call.summary, toolCall: call });
    return { auditId: idempotencyKey };
  }
}
