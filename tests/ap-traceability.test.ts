import { describe, expect, it } from "vitest";
import { sourceChanges, sourceSnapshots, textDiff, valueDiff } from "../console/src/traceability-model";
import { apUIFixture } from "./ap-system-ui.fixture";
describe("retained case trace diffs", () => {
  it("separates identical-byte revisions, added evidence and removed originals", () => {
    const source = apUIFixture().sources[0]!;
    const next = { ...source, revision: 2 };
    const contract = { ...source, sourceId: "contract", kind: "contract" as const, sha256: "d".repeat(64) };
    const rows = sourceChanges([source,next,contract],[source],[next,contract]);
    expect(rows.map(r=>r.status)).toEqual(["reversioned","added"]);
    expect(sourceChanges([source,next,contract],[next,contract],[source]).map(r=>r.status)).toEqual(["reversioned","removed"]);
  });
  it("uses explicit replacement links, never file names, to pair changed sources", () => {
    const source = apUIFixture().sources[0]!;
    const replacement = { ...source, sourceId: "replacement", sha256: "d".repeat(64), replaces: source };
    expect(sourceChanges([source,replacement],[source],[replacement])[0]?.status).toBe("changed");
    const unrelated = { ...replacement, replaces: null };
    expect(sourceChanges([source,unrelated],[source],[unrelated]).map(r=>r.status)).toEqual(["added","removed"]);
  });
  it("retains unavailable bindings without inventing original text", () => {
    const source = apUIFixture().sources[0]!;
    const row=sourceChanges([],[],[source])[0]!;
    expect(row.afterBinding?.sha256).toBe(source.sha256);expect(row.after).toBeUndefined();
  });
  it("does not invent old snapshots when no review exists", () => {
    const detail=apUIFixture();const snapshots=sourceSnapshots(detail);
    expect(snapshots).toHaveLength(1);expect(snapshots[0]?.bindings).toEqual(detail.currentSourceBindings);
  });
  it("compares nested request fields without modifying either snapshot", () => {
    const before={amountCents:300000,lines:[{quantity:'15',account:'6000'}],old:true};
    const after={amountCents:320000,lines:[{quantity:'16',account:'6000'}]};
    expect(valueDiff(before,after)).toEqual([{path:'amountCents',before:'300000',after:'320000'},{path:'lines.0.quantity',before:'"15"',after:'"16"'},{path:'old',before:'true',after:'Not present'}]);
    expect(before.lines[0]?.quantity).toBe('15');
  });
  it("preserves exact lines and labels additions and removals", () => {
    const rows=textDiff('Invoice\nTotal 10\nEnd','Invoice\nTotal 20\nEnd');
    expect(rows.filter(r=>r.kind!=='added').map(r=>r.text).join('\n')).toBe('Invoice\nTotal 10\nEnd');
    expect(rows.filter(r=>r.kind!=='removed').map(r=>r.text).join('\n')).toBe('Invoice\nTotal 20\nEnd');
    expect(rows.some(r=>r.kind==='added'&&r.text==='Total 20')).toBe(true);
  });
});
