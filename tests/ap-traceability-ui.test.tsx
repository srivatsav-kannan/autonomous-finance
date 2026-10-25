import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { APTraceability, chronologicalEvents } from "../console/src/APTraceability";
import { historyFixture } from "./ap-system/agent-history.fixture";

const render = (detail = historyFixture()) => renderToStaticMarkup(createElement(APTraceability, { detail, children: createElement("p", null, "Existing review history") }));

describe("case trace activity log", () => {
  it("sorts recorded events deterministically without changing the case", () => {
    const event = historyFixture("legacy").timeline[0]!;
    const input = [{ ...event, eventId: "z", at: 2 }, { ...event, eventId: "b", at: 1 }, { ...event, eventId: "a", at: 1 }];
    expect(chronologicalEvents(input).map(item => item.eventId)).toEqual(["a", "b", "z"]);
    expect(input.map(item => item.eventId)).toEqual(["z", "b", "a"]);
  });
  it("uses main's saved agent snapshots without attributing current case changes", () => {
    const detail = historyFixture("missing-receipt");
    detail.states.execution = "settled";
    const html = render(detail);
    expect(html).toContain("Activity log");
    expect(html).toContain("Recorded changes");
    expect(html).toContain("Changes during this operation");
    expect(html).toContain("not attributed to this actor");
    expect(html).toContain(detail.timeline[0]!.agentTransition!.operationId);
    expect(html).not.toContain("Bank execution</th><td data-label=\"Before operation\">Not started</td><td data-label=\"After operation\">Settled");
    expect(html).toContain("Full review history");
    expect(html).not.toContain(" open=");
  });
  it("keeps empty history empty and legacy events without invented diffs", () => {
    expect(render(historyFixture("empty"))).toContain("No activity has been recorded for this case.");
    const detail = historyFixture("legacy");
    detail.timeline[0]!.at = Number.MAX_SAFE_INTEGER;
    const html = render(detail);
    expect(html).toContain("Time unavailable");
    expect(html).not.toContain("Recorded changes");
    expect(html).toContain("Raw event");
    expect(html).toContain("Export trace JSON");
  });
});
