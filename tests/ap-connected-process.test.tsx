import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { APCaseDetail } from "../src/ap-system/contracts";
import { APConnectedProcess, connectedProcessFacts } from "../console/src/APConnectedProcess";

const hash = "a".repeat(64);
function detail(overrides: Partial<APCaseDetail> = {}) {
  return {
    sources: [], currentSourceBindings: [], timeline: [], exceptions: [], work: null,
    identityMode: "authenticated_human", scope: { provider: "increase", environment: "sandbox" },
    extraction: { status: "failed" },
    states: { document: "failed", business: "unreviewed", accounting: "unposted", authorization: "not_requested", execution: "not_started", reconciliation: "unmatched" },
    ...overrides,
  } as unknown as APCaseDetail;
}

describe("connected processing evidence", () => {
  it("shows the parser for current byte-bound source revisions only", () => {
    const data = detail({
      currentSourceBindings: [{ sourceId: "invoice", revision: 2, sha256: hash }],
      sources: [
        { sourceId: "invoice", revision: 1, sha256: hash, parser: { provider: "old-parser" } },
        { sourceId: "invoice", revision: 2, sha256: hash, parser: { provider: "llamaparse" } },
        { sourceId: "invoice", revision: 2, sha256: "b".repeat(64), parser: { provider: "wrong-original" } },
      ] as unknown as APCaseDetail["sources"],
    });
    expect(connectedProcessFacts(data).parsers).toEqual(["llamaparse"]);
    expect(connectedProcessFacts(data).sources).toHaveLength(1);
  });
  it("counts unique validated model runs and keeps unresolved holds", () => {
    const decision = { version: "ap-model-decision-v1", mode: "model", action: "wait", reason: "Missing evidence", evidenceIds: [], runId: "run-one", provider: "anthropic", model: "recorded-model", inspectedRevision: 1, inspectedSnapshotHash: hash, inputHash: hash, usage: { inputTokens: 10, outputTokens: 2, costMicros: 30 }, latencyMs: 20 };
    const data = detail({
      timeline: [{ eventId: "one", kind: "agent_wait", transition: { decision } }, { eventId: "two", kind: "agent_wait", transition: { decision } }, { eventId: "three", kind: "agent_wait", transition: { decision: { provider: "invented" } } }] as unknown as APCaseDetail["timeline"],
      exceptions: [{ blocking: true, status: "open" }, { blocking: true, status: "resolved" }, { blocking: false, status: "open" }] as APCaseDetail["exceptions"],
    });
    expect(connectedProcessFacts(data)).toMatchObject({ modelRuns: 1, models: ["anthropic / recorded-model"], agentEvents: 3, holds: 1 });
  });
  it("uses inspected legacy agent progress without inventing a richer work record", () => {
    const data = detail({ agentProgress: { caseId: "case-one", status: "waiting", stage: "missing_evidence", owner: "receiving_owner", reason: "Receipt is missing", requirements: ["accepted_receiving_evidence"], waitSince: 1_700_000_000_000, deadlineAt: 1_700_086_400_000, updatedAt: 1_700_000_000_000 } });
    const html = renderToStaticMarkup(createElement(APConnectedProcess, { detail: data, onView: () => {} }));
    expect(html).toContain("Owner: receiving_owner");
    expect(html).toContain("Receipt is missing");
    expect(html).not.toContain("No work record yet");
    expect(html).not.toContain("Generation");
  });
  it("counts legacy and rich agent events once while excluding unrelated case history", () => {
    const data = detail({ timeline: [
      { eventId: "one", kind: "agent_missing_evidence" },
      { eventId: "two", kind: "agent_advanced", transition: {} },
      { eventId: "two", kind: "agent_advanced", transition: {} },
      { eventId: "three", kind: "source_delivery" },
    ] as unknown as APCaseDetail["timeline"] });
    expect(connectedProcessFacts(data).agentEvents).toBe(2);
    expect(connectedProcessFacts(data).modelRuns).toBe(0);
  });
  it("does not infer parsing, model activity or payment success when records are absent", () => {
    const html = renderToStaticMarkup(createElement(APConnectedProcess, { detail: detail(), onView: () => {} }));
    expect(html).toContain("No parser result recorded");
    expect(html).toContain("No model response has been recorded.");
    expect(html).toContain("No work record yet");
    expect(html).toContain("Auth0 verified");
    expect(html).toContain("Increase sandbox");
    expect(html).not.toContain("llamaparse");
    expect(html).not.toContain("Settled");
  });
});
