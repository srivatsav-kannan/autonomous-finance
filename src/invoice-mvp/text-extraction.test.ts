import { describe, expect, it } from "vitest";
import { parseSupportedSource } from "./parser";
import { signedDecimalCents } from "./money";
import { extractionCustomers, extractionFixtures, matchesExtraction } from "../../tests/fixtures/invoice-extraction";

describe("printed invoice extraction — public development regressions", () => {
  for (const fixture of extractionFixtures) it(fixture.id, () => {
    const ref = { documentId: fixture.id, version: 2, contentHash: "fixture-sha256" };
    const { conclusion } = parseSupportedSource(fixture.source, ref, fixture.customers ?? extractionCustomers);
    expect(conclusion).toMatchObject(fixture.expected);
    expect(matchesExtraction(conclusion, fixture)).toBe(true);
    expect(conclusion.evidence.length).toBeGreaterThan(0);
    for (const evidence of conclusion.evidence) {
      expect(evidence).toMatchObject(ref);
      expect(fixture.source.text).toContain(evidence.quote);
    }
    if (conclusion.treatment === "needs_evidence") {
      expect(conclusion.missingEvidence.length).toBeGreaterThan(0);
      expect(conclusion.question).toBeTruthy();
    }
  });
  it("does not select a last-wins total or combine source documents", () => {
    for (const id of ["conflicting-totals", "two-invoices"]) {
      const f = extractionFixtures.find((v) => v.id === id)!;
      expect(parseSupportedSource(f.source, { documentId: id, version: 1, contentHash: "test" }).conclusion.amountCents).toBeUndefined();
    }
  });
  it("preserves every cent near the safe integer boundary and rejects double signs", () => {
    for (let i = 0; i < 100; i++) {
      const expected = BigInt(Number.MAX_SAFE_INTEGER) - BigInt(i);
      const decimal = `${expected / 100n}.${String(expected % 100n).padStart(2, "0")}`;
      expect(signedDecimalCents(decimal)).toBe(Number(expected));
    }
    for (const text of ["--$20.00", "(-20.00)", "$1,23.00", "1e6", "90,071,992,547,409.92"]) expect(signedDecimalCents(text)).toBeUndefined();
  });
});
