import { describe, expect, it } from "vitest";
import { investigate } from "./investigator";
import { InvoiceService } from "./service";
import { TestBackend } from "./test-backend";
import { ZERO_USAGE, type InvestigatorModel, type ModelRequest, type ToolAction } from "./model";
import { demoBatch } from "./demo";

class MockModel implements InvestigatorModel {
  mode = "mock_model" as const;
  model = "scripted-test-model";
  seen: ModelRequest[] = [];
  constructor(private actions: ToolAction[]) {}
  reservation() { return ZERO_USAGE; }
  async next(request: ModelRequest) {
    this.seen.push(structuredClone(request));
    return { action: this.actions.shift() ?? { name: "policy" as const, input: {} }, usage: { ...ZERO_USAGE, inputTokens: 10, outputTokens: 4 } };
  }
}
async function setup(source = demoBatch().documents[2]!) {
  const backend = new TestBackend();
  const result = await backend.ingestBatch({ label: "Public synthetic test", documents: [source], idempotencyKey: "test" });
  return { backend, detail: await backend.caseDetail(result.caseIds[0]!) };
}
describe("bounded investigator mock integration — no live model", () => {
  it("retrieves source, related documents/customers and policy then records deterministic proposal", async () => {
    const { backend, detail } = await setup();
    const result = await investigate(backend, detail);
    expect(result).toMatchObject({ mode: "deterministic", modelCalls: 0, outcome: "recorded", toolCalls: 5 });
    expect(backend.details.get(detail.case.caseId)!.audit.map((a) => a.toolCall?.tool)).toEqual(["inspect_source", "related_documents", "related_customers", "policy", "propose_disposition"]);
  });
  it("leaves unfamiliar evidence unresolved with a specific question", async () => {
    const { backend, detail } = await setup(demoBatch().documents[7]!);
    expect((await investigate(backend, detail)).outcome).toBe("evidence_missing");
    expect(backend.details.get(detail.case.caseId)!.currentProposal!.conclusion.question).toContain(detail.source.name);
  });
  it("observes tool results, proposes with exact evidence and never self-approves a mock model", async () => {
    const { backend, detail } = await setup();
    const model = new MockModel([
      { name: "inspect_source", input: {} }, { name: "related_documents", input: {} }, { name: "related_customers", input: {} }, { name: "policy", input: {} },
      { name: "propose_disposition", input: { treatment: "include_invoice", customerId: "demo-acorn", customerName: "Acorn Design", documentNumber: "AC-100", amountCents: 100000, reason: "Source explicitly shows the invoice.", evidence: [{ documentId: detail.source.documentId, version: 1, contentHash: detail.source.contentHash, quote: "Total: USD 1000.00" }], contradictions: [], missingEvidence: [] } },
    ]);
    const result = await investigate(backend, detail, model);
    expect(result).toMatchObject({ outcome: "needs_review", mode: "mock_model", modelCalls: 5, usage: { inputTokens: 50, outputTokens: 20, costMicros: 0 } });
    expect(model.seen[1]!.observations[0]!.result).toMatchObject({ text: detail.source.text });
  });
  it("rejects fabricated quotes, records tool rejection and stops at bound", async () => {
    const { backend, detail } = await setup();
    const model = new MockModel([
      { name: "inspect_source", input: {} }, { name: "related_documents", input: {} }, { name: "related_customers", input: {} }, { name: "policy", input: {} },
      { name: "propose_disposition", input: { treatment: "exclude", reason: "Fabricated", evidence: [{ documentId: detail.source.documentId, version: 1, contentHash: detail.source.contentHash, quote: "this quote does not exist" }], contradictions: [], missingEvidence: [] } },
    ]);
    const result = await investigate(backend, detail, model, 6);
    expect(result.outcome).toBe("evidence_missing"); expect(model.seen).toHaveLength(6);
    expect(backend.details.get(detail.case.caseId)!.audit.some((a) => a.summary.includes("exact inspected source"))).toBe(true);
  });
  it("records human questions from a mock and resumes using recorded response after process recreation", async () => {
    const { backend, detail } = await setup(demoBatch().documents[7]!);
    const model = new MockModel([{ name: "ask_human", input: { question: "Is the signed final invoice for this service available?", missingEvidence: ["Final issued invoice"] } }]);
    await investigate(backend, detail, model);
    const state = backend.details.get(detail.case.caseId)!;
    state.decisions.push({ caseId: state.case.caseId, proposalId: state.currentProposal!.proposalId, evidenceVersion: 1, idempotencyKey: "reply", action: "request_evidence", note: "Signed invoice will arrive tomorrow", decisionId: "d1", actor: "human", createdAt: 1 });
    state.case.status = "investigating";
    const resumed = new MockModel([{ name: "ask_human", input: { question: "Please attach the signed invoice promised for tomorrow.", missingEvidence: ["Signed invoice"] } }]);
    await new InvoiceService(backend, resumed).processPending();
    expect(resumed.seen[0]!.decisionSummaries[0]).toContain("Signed invoice will arrive tomorrow");
    expect(state.case.status).toBe("evidence_missing");
  });
  it("never invokes a live transport without atomic backend budget support", async () => {
    const { backend } = await setup();
    let called = false;
    const model: InvestigatorModel = { mode: "live_model", model: "not-called", reservation: () => ZERO_USAGE, next: async () => { called = true; throw new Error(); } };
    await expect(new InvoiceService(backend, model).processPending({ allowLive: true })).rejects.toMatchObject({ code: "live_budget_backend_required" });
    expect(called).toBe(false);
  });
  it("pages through long sources instead of silently restricting access", async () => {
    const source = { ...demoBatch().documents[7]!, text: `${"x".repeat(85_000)}FINAL EVIDENCE` };
    const { backend, detail } = await setup(source);
    const model = new MockModel([{ name: "inspect_source", input: { offset: 85_000, limit: 100 } }, { name: "ask_human", input: { question: "Please provide the issued invoice corresponding to this final evidence.", missingEvidence: ["Issued invoice"] } }]);
    await investigate(backend, detail, model);
    expect(model.seen[1]!.observations[0]!.result).toMatchObject({ text: "FINAL EVIDENCE", offset: 85_000, nextOffset: null, totalCharacters: 85_014 });
  });
  it("processes customer registry dependency before earlier invoices in the input batch", async () => {
    const backend = new TestBackend();
    const service = new InvoiceService(backend);
    await service.ingestBatch({ label: "Unsorted synthetic documents", documents: [demoBatch().documents[2]!, demoBatch().documents[0]!] });
    const result = await service.processPending({ maxCases: 1 });
    expect(result.processed[0]!.caseId).toBe("case-1");
    expect(backend.calls).toContain("registerCustomer");
    expect((await backend.caseDetail("case-0")).case.status).toBe("received");
  });
});
