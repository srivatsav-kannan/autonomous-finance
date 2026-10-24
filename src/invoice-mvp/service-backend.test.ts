import { describe, expect, it } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";
import * as handlers from "../../convex/invoiceCases";
import { kernelHarness } from "../../tests/helpers/kernelHarness";
import { sha256Hex } from "../../convex/lib/kernel";
import { ConvexInvoiceBackend } from "./backend";
import { InvoiceService } from "./service";
import { demoBatch } from "./demo";
import { ZERO_USAGE, type InvestigatorModel } from "./model";

/** Real application + backend handlers in the repository DB harness. Not a deployed Convex test. */
async function setup() {
  const h = kernelHarness(), runId = "public-service-integration", token = "synthetic-only";
  await h.seed("runs", { runId, label: "Public synthetic service test", company: "Demo", simDate: "2026-10-24", status: "active", createdAt: 1 });
  for (const [seatId, role, kind] of [["human", "human_cfo", "human"], ["investigator", "ar_clerk", "agent"]] as const) await h.seed("seats", { runId, seatId, role, kind, name: seatId, capabilities: {}, status: "active", tokenHash: await sha256Hex(token), createdAt: 1 });
  const invoke = (ref: FunctionReference<"query" | "mutation">, args: Record<string, unknown>) => {
    const name = getFunctionName(ref).split(":")[1]!;
    const handler = (handlers as unknown as Record<string, { _handler: (ctx: unknown, input: unknown) => unknown }>)[name];
    if (!handler) throw new Error(`Unknown test handler ${name}`);
    return handler._handler(h.ctx, args);
  };
  const client = { query: invoke, mutation: invoke } as unknown as ConvexHttpClient;
  const backend = new ConvexInvoiceBackend(client, { runId, seatId: "human", token }, { runId, seatId: "investigator", token });
  return { h, backend, service: new InvoiceService(backend) };
}
describe("actual service and backend handlers on public synthetic data", () => {
  it("runs demo, preserves duplicate trace, records exact totals, resumes a decision and late revision", async () => {
    const { backend, service } = await setup();
    await service.ingestBatch(demoBatch());
    const processed = await service.processPending();
    expect(processed.errors).toEqual([]);
    const initial = await service.workspace();
    expect(initial.progress).toMatchObject({ total: 8, recorded: 3, excluded: 2, duplicate: 1, needsReview: 1, evidenceMissing: 1, pending: 0 });
    expect(initial.customerTotals.map((c) => [c.customerId, c.netCents])).toEqual([["demo-acorn", 87500], ["demo-birch", 40000]]);
    const pending = initial.cases.find((c) => c.externalId === "demo-ambiguous")!;
    const decision = { caseId: pending.caseId, proposalId: pending.currentProposalId!, evidenceVersion: pending.evidenceVersion, idempotencyKey: "human-accept-public", action: "accept" as const };
    await service.decide(decision);
    await new InvoiceService(backend).decide(decision);
    expect((await service.workspace()).customerTotals[0]!.netCents).toBe(107500);
    await service.ingestBatch(demoBatch("late"));
    const resumed = await new InvoiceService(backend).processPending();
    expect(resumed.errors).toEqual([]);
    const final = await service.workspace();
    expect(final.customerTotals.map((c) => c.netCents)).toEqual([107500, 45000]);
    expect(final.progress.superseded).toBe(1);
    expect(final.progress.evidenceMissing).toBe(1);
    const newCase = final.cases.find((c) => c.externalId === "demo-revision" && c.status === "recorded")!;
    expect((await service.caseDetail(newCase.caseId)).sourceVersions).toHaveLength(2);
    expect(final.customerTotals.flatMap((c) => c.contributions).every((c) => c.evidence.length > 0)).toBe(true);
  });
  it("invalidates old approval after late evidence and retains unknown original bytes", async () => {
    const { service } = await setup();
    await service.ingestBatch(demoBatch()); await service.processPending();
    const old = (await service.workspace()).cases.find((c) => c.externalId === "demo-ambiguous")!;
    await service.ingestBatch(demoBatch("late")); await service.processPending();
    await expect(service.decide({ caseId: old.caseId, proposalId: old.currentProposalId!, evidenceVersion: old.evidenceVersion, idempotencyKey: "stale-answer", action: "accept" })).rejects.toMatchObject({ code: "stale_proposal" });
    const contentBase64 = Buffer.from("unsupported mailbox bytes\r\n").toString("base64");
    const result = await service.ingestBatch({ label: "Mailbox", documents: [{ externalId: "mailbox", name: "source.mbox", mimeType: "application/mbox", text: "unsupported mailbox bytes\n", contentBase64 }] });
    await service.processPending();
    expect((await service.caseDetail(result.caseIds[0]!)).source.contentBase64).toBe(contentBase64);
  });
  it("atomically reserves before injected transport, records actual usage and refuses replayed reservation", async () => {
    const { backend, service } = await setup();
    const input = demoBatch().documents[7]!;
    await service.ingestBatch({ label: "Live-boundary mock transport — no network", documents: [input] });
    let calls = 0;
    const model: InvestigatorModel = { mode: "live_model", model: "test-double-no-network", budget: { maxCalls: 1, maxCostMicros: 500, maxInputTokens: 1000, maxOutputTokens: 1000 }, reservation: () => ({ ...ZERO_USAGE, inputTokens: 20, outputTokens: 10, costMicros: 50 }),
      next: async () => { calls++; expect(await backend.modelBudget()).toMatchObject({ requestsReserved: 1, costReservedMicros: 50 }); return { action: { name: "ask_human", input: { question: "Please attach the final issued invoice for this service.", missingEvidence: ["Final invoice"] } }, usage: { ...ZERO_USAGE, inputTokens: 12, outputTokens: 5, costMicros: 22 } }; },
    };
    const result = await new InvoiceService(backend, model).processPending({ allowLive: true });
    expect(result.errors).toEqual([]); expect(calls).toBe(1);
    const caseId = (await service.workspace()).cases[0]!.caseId;
    const detail = await service.caseDetail(caseId);
    expect(detail.audit.some((a) => a.toolCall?.tool === "model_usage" && a.toolCall.costMicros === 22)).toBe(true);
    // A reservation replay remains charged and is returned distinctly, never fresh authorization.
    const other = await setup();
    await other.service.ingestBatch({ label: "Replay", documents: [input] });
    const c = (await other.backend.pendingCases())[0]!; await other.backend.beginInvestigation(c.caseId);
    const reserve = { caseId: c.caseId, evidenceVersion: c.evidenceVersion, model: "test-double", maxCostMicros: 50, budget: { maxRequests: 1, maxCostMicros: 500 }, idempotencyKey: "reserved" };
    expect((await other.backend.reserveModelRequest(reserve)).replayed).toBe(false);
    expect((await other.backend.reserveModelRequest(reserve)).replayed).toBe(true);
  });
});
