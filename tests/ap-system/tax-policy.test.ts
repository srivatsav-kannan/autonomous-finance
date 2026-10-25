import { describe, expect, it } from "vitest";
import { recoverableTaxPolicySchema, taxClaimSchema } from "../../src/ap-system/tax-contracts";
import { calculatedTax, citedMoney, recoverableCreditCents, taxClaimProblems, taxProportion, taxPolicyProblems } from "../../src/ap-system/tax-policy";
import { syntheticTaxRule, taxEvidenceFixture } from "./tax-fixture";

describe("explicit synthetic recoverable-tax rules", () => {
  it.each(["exclusive", "inclusive"] as const)("checks %s source arithmetic and exact allocations", basis => {
    const f = taxEvidenceFixture(basis);
    expect(taxClaimSchema.parse(f.claim)).toEqual(f.claim);
    expect(taxClaimProblems(f.claim, f.rule, f.documents, f.original, 770)).toEqual([]);
  });
  it("accepts a stated amount only when allowed and carries no invented rate", () => {
    const f = taxEvidenceFixture(); f.claim.calculation = "stated_amount"; f.claim.rateBps = null; delete f.claim.facts.rate;
    expect(taxClaimSchema.safeParse(f.claim).success).toBe(true);
    expect(taxClaimProblems(f.claim, f.rule, f.documents, f.original, 770)).toEqual([]);
    expect(taxClaimProblems(f.claim, { ...f.rule, allowStatedAmount: false }, f.documents, f.original, 770)).toContain("tax_stated_amount_policy");
    expect(taxClaimSchema.safeParse({ ...f.claim, rateBps: 1000 }).success).toBe(false);
  });
  it("holds a made-up rate and an unapproved jurisdiction/date", () => {
    const f = taxEvidenceFixture(); f.claim.rateBps = 900;
    expect(taxClaimProblems(f.claim, f.rule, f.documents, f.original, 770)).toContain("tax_rate_arithmetic");
    f.claim.jurisdiction = "other"; f.claim.taxPointDate = "2027-01-01";
    expect(taxClaimProblems(f.claim, f.rule, f.documents, f.original, 770)).toContain("tax_policy_scope");
  });
  it.each(["revision", "hash", "quote", "page"])("rejects changed %s in tax evidence", kind => {
    const f = taxEvidenceFixture(), e = f.claim.facts.tax;
    if (kind === "revision") e.source.revision++;
    if (kind === "hash") e.source.sha256 = "0".repeat(64);
    if (kind === "quote") e.quote = "$8.00";
    if (kind === "page") e.page = 2;
    expect(taxClaimProblems(f.claim, f.rule, f.documents, f.original, 770)).toContain("tax_invoice_evidence");
  });
  it("requires distinct retained eligibility support, not an invoice asserting its own eligibility", () => {
    const f = taxEvidenceFixture(); f.claim.eligibilityEvidence = [f.claim.facts.tax];
    expect(taxClaimProblems(f.claim, f.rule, f.documents, f.original, 770)).toContain("tax_eligibility_evidence");
  });
  it("retains partial recoverability without treating all tax as a receivable", () => {
    const f = taxEvidenceFixture(); f.rule.recoverableBps = 5000; f.claim.recoverableCents = 193;
    expect(taxClaimProblems(f.claim, f.rule, f.documents, f.original, 385)).toEqual([]);
    f.claim.recoverableCents = 385;
    expect(taxClaimProblems(f.claim, f.rule, f.documents, f.original, 385)).toContain("tax_recovery_amount");
  });
  it("uses exact half-up integers at ties and does not tolerate fractional cent evidence", () => {
    expect(calculatedTax(5, 6, 1000, "exclusive")).toBe(1);
    expect(taxProportion(Number.MAX_SAFE_INTEGER, 1, 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => taxProportion(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow(/unsafe/);
    expect(citedMoney("$0.005", "major")).toBeNull();
    expect(citedMoney("1.5", "minor")).toBeNull();
    expect(citedMoney("$1,234.56", "major")).toBe(123456);
  });
  it("allocates cumulative credit rounding without over-reversing original tax", () => {
    expect(recoverableCreditCents(3, 2, 0, 0, 1)).toBe(1);
    expect(recoverableCreditCents(3, 2, 1, 1, 1)).toBe(0);
    expect(recoverableCreditCents(3, 2, 2, 1, 1)).toBe(1);
    expect(() => recoverableCreditCents(3, 2, 3, 2, 1)).toThrow(/capacity/);
  });
  it("binds every tax fact to the actual invoice original, not another uploaded invoice", () => {
    const f = taxEvidenceFixture();
    const other = structuredClone(f.documents[0]!); other.sourceId = "different-invoice";
    f.documents.push(other); f.claim.facts.tax.source.sourceId = other.sourceId;
    expect(taxClaimProblems(f.claim, f.rule, f.documents, f.original, 770)).toContain("tax_invoice_evidence");
  });
  it.each(["1000", "2000", "5000", "missing"])("rejects %s as the configured tax receivable", account => {
    const recovery = { ...syntheticTaxRule(), receivableAccount: account };
    expect(taxPolicyProblems({ groups: [{ groupId: "tax-review" }], accounts: [{ account, treatment: "tax" }], taxCodes: [{ code: "TEST", mode: "recoverable", recovery }] })).toContain("tax_receivable_account");
  });
  it("requires a configured tax treatment and real approval group", () => {
    const recovery = syntheticTaxRule();
    expect(taxPolicyProblems({ groups: [{ groupId: "tax-review" }], accounts: [{ account: "1180", treatment: "tax" }], taxCodes: [{ code: "TEST", mode: "recoverable", recovery }] })).toEqual([]);
    expect(taxPolicyProblems({ groups: [], accounts: [{ account: "1180", treatment: "inventory" }], taxCodes: [{ code: "TEST", mode: "recoverable", recovery }] })).toEqual(["tax_receivable_account", "tax_approval_group"]);
  });
  it("rejects ambiguous policy dates or rounding rules at the contract boundary", () => {
    const rule = syntheticTaxRule();
    expect(recoverableTaxPolicySchema.safeParse({ ...rule, effectiveThrough: "2026-02-30" }).success).toBe(false);
    expect(recoverableTaxPolicySchema.safeParse({ ...rule, rounding: { ...rule.rounding, calculatedTax: "nearest_guess" } }).success).toBe(false);
  });
});
