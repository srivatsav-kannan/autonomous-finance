import { describe, expect, it } from "vitest";
import {
  recordedCents,
  referenceTarget,
  snapshotReferences,
  snapshotRows,
} from "../../console/src/apAgentHistoryView";
import { historyFixture } from "./agent-history.fixture";
import saved from "../../docs/ap-orchestration/evidence/agent-transition-v1/case-transitions.json";

describe("saved AP history presentation", () => {
  it("distinguishes unknown, missing and zero and keeps every safe integer cent", () => {
    expect(recordedCents(null)).toBe("Unknown (recorded null)");
    expect(recordedCents(undefined)).toBe("Not recorded");
    expect(recordedCents(0)).toBe("0.00 (0 cents)");
    expect(recordedCents(7701)).toBe("77.01 (7,701 cents)");
    expect(recordedCents(Number.MAX_SAFE_INTEGER)).toBe(
      "90,071,992,547,409.91 (9,007,199,254,740,991 cents)",
    );
    expect(recordedCents(1.5)).toBe("Invalid recorded amount");
  });
  it("projects the stored transitions without changing their contents", () => {
    expect(historyFixture().timeline.map((e) => e.agentTransition)).toEqual(
      saved.events.map((e) => e.transition),
    );
  });
  it("keeps the missing receipt hold and its required next action", () => {
    const transition =
      historyFixture("missing-receipt").timeline[0]!.agentTransition!;
    const rows = snapshotRows(transition);
    expect(rows.find((r) => r.label === "Owner")).toMatchObject({
      before: "ap_clerk",
      after: "receiving_owner",
      changed: true,
    });
    expect(
      rows.find((r) => r.label === "Required next action / evidence")?.after,
    ).toBe("Accepted receiving evidence");
    expect(rows.find((r) => r.label === "Accepted")).toMatchObject({
      before: "Unknown (recorded null)",
      after: "Unknown (recorded null)",
      changed: false,
    });
  });
  it("never turns observations between operations into changes within one", () => {
    for (const mode of [
      "evidence-revision",
      "independent-approval",
      "settled",
    ] as const) {
      for (const e of historyFixture(mode).timeline) {
        const unchanged = snapshotRows(e.agentTransition!).filter((r) =>
          [
            "Case revision",
            "Source revisions",
            "Bill decision",
            "Document review",
            "Payment authorization",
            "Bank execution",
            "Settled",
          ].includes(r.label),
        );
        expect(unchanged.every((r) => !r.changed)).toBe(true);
      }
    }
    expect(
      historyFixture("settled").timeline[0]!.agentTransition!.before.case.states
        .execution,
    ).toBe("settled");
  });
  it("shows the one newly linked proposal, without turning it into an execution", () => {
    const transition =
      historyFixture("payment-proposal").timeline[0]!.agentTransition!;
    expect(
      snapshotReferences(transition).filter((r) => r.kind === "Payment"),
    ).toEqual([
      {
        kind: "Payment",
        id: saved.versions[0]!.id,
        before: false,
        after: true,
      },
    ]);
    expect(
      snapshotRows(transition).find((r) => r.label === "Bank execution"),
    ).toMatchObject({
      before: "Not started",
      after: "Not started",
      changed: false,
    });
  });
  it("only offers destinations for records present in the scoped case", () => {
    const detail = historyFixture();
    expect(
      referenceTarget({ kind: "Payment", id: saved.versions[0]!.id }, detail),
    ).toBeUndefined();
    expect(
      referenceTarget(
        { kind: "Journal", id: detail.journals[0]!.entryId },
        detail,
      ),
    ).toBe("accounting");
    expect(
      referenceTarget(
        { kind: "Decision", id: detail.decisions[0]!.decisionId },
        detail,
      ),
    ).toBe("decision");
    expect(
      referenceTarget({ kind: "Payment", id: "missing" }, detail),
    ).toBeUndefined();
    expect(
      referenceTarget(
        { kind: "Provider transfer", id: "https://example.invalid" },
        detail,
      ),
    ).toBeUndefined();
  });
  it("leaves legacy and empty events without invented snapshots", () => {
    expect(
      historyFixture("legacy").timeline.every((e) => !e.agentTransition),
    ).toBe(true);
    expect(historyFixture("empty").timeline).toEqual([]);
  });
  it("compares source bindings by value, regardless of array order", () => {
    const transition = historyFixture().timeline[0]!.agentTransition!;
    transition.after.case.sourceBindings.reverse();
    expect(
      snapshotRows(transition).find((r) => r.label === "Source revisions")
        ?.changed,
    ).toBe(false);
  });
});
