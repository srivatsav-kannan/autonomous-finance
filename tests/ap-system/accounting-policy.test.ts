import { describe, expect, it } from "vitest";
import { packet } from "./accounting-fixture";
import { evaluatePolicy } from "../../src/ap-system/policy";
import {
  accountingProblems,
  lineCents,
  recognitionLines,
} from "../../src/ap-system/accounting";
const codes = (input = packet(), reviewed = true) =>
  evaluatePolicy(input, "golden-state-produce", reviewed).map((e) => e.code);
describe("Golden State explicit AP evidence policy", () => {
  it("separates geometric review from business evidence", () => {
    expect(codes(packet(), false)).toContain("geometry_review_required");
    expect(codes()).toEqual([]);
    const p = packet();
    p.purchasingEvidence = p.purchasingEvidence.filter(
      (e) => e.kind !== "receipt",
    );
    expect(codes(p)).toContain("missing_receipt");
  });
  it("holds unknown SKU/unit and price/receipt discrepancies with accountable owners", () => {
    const p = packet();
    p.candidate!.lines[0]!.sku = "UNKNOWN";
    p.candidate!.lines[0]!.quantity.unit = "crate";
    p.candidate!.lines[0]!.unitPriceCents = 4000;
    p.purchasingEvidence[1]!.lines[0]!.quantity.decimal = "1";
    const holds = evaluatePolicy(p, "golden-state-produce", true);
    expect(holds.map((h) => h.code)).toEqual(
      expect.arrayContaining([
        "unknown_sku",
        "unknown_unit",
        "receipt_mismatch",
        "unsupported_field",
      ]),
    );
    expect(
      holds.every(
        (h) =>
          h.ownerRole && h.requiredEvidence.length && h.permittedActions.length,
      ),
    ).toBe(true);
  });
  it("rejects foreign source bindings, unsupported content and implicit allocations", () => {
    const p = packet();
    p.purchasingEvidence[1]!.source.sha256 = "a".repeat(64);
    p.candidate!.evidence[0]!.contentStatus = "conflicting";
    p.candidate!.lines[0]!.allocations = [];
    expect(codes(p)).toEqual(
      expect.arrayContaining([
        "purchasing_source_mismatch",
        "content_conflict",
        "arithmetic_or_coding",
      ]),
    );
  });
  it("retains unknown extraction rather than treating absence as zero", () => {
    const p = packet();
    p.candidate = null;
    p.extraction = {
      status: "failed",
      evidence: [],
      reasons: ["page unreadable"],
    };
    expect(codes(p)).toEqual(["incomplete_extraction"]);
  });
  it("rounds exact quantities once per line and prevents unsafe totals", () => {
    expect(lineCents("0.005", 100)).toBe(1);
    expect(lineCents("1.234567", 100)).toBe(123);
    expect(() => lineCents("999999999999", 999999999)).toThrow("Unsafe");
  });
  it("recognizes the cost once and credits AP, retaining cost dimensions", () => {
    const c = packet().candidate!;
    expect(accountingProblems(c)).toEqual([]);
    expect(recognitionLines(c)).toEqual([
      {
        account: "5000",
        debit: 7700,
        credit: 0,
        dims: { store: "sf-hayes-valley", vendor: "golden-state-produce" },
        memo: "expense; period 2026-10",
      },
      {
        account: "2000",
        debit: 0,
        credit: 7700,
        dims: { vendor: "golden-state-produce" },
      },
    ]);
  });
});
