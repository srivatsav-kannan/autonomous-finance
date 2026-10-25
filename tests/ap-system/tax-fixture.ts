import { createHash } from "node:crypto";
import { packet } from "./accounting-fixture";
import type { SourceDocument } from "../../src/ap-system/contracts";
import { recoverableTaxPolicySchema, type TaxClaim, type TaxCitation } from "../../src/ap-system/tax-contracts";

export const syntheticTaxRule = () => recoverableTaxPolicySchema.parse({
  version: "ap-recoverable-tax-v1", receivableAccount: "1180", jurisdiction: "SYNTHETIC-JURISDICTION",
  rateBps: [1000], allowStatedAmount: true, priceBases: ["exclusive", "inclusive"], recoverableBps: 10000,
  effectiveFrom: "2026-01-01", effectiveThrough: "2026-12-31", approvalGroupId: "tax-review",
  rounding: { calculatedTax: "half_up_per_line", partialAcceptance: "half_up_original_proportion", recovery: "half_up_original_proportion", credit: "half_up_cumulative_original_proportion" },
});
export function taxEvidenceFixture(basis: "exclusive" | "inclusive" = "exclusive") {
  const documents = packet().documents;
  const doc = documents[0]!;
  const body = `Taxable base $77.00\nTax $7.70\nGross $84.70\nRate 10%\nTax point 2026-10-19\nPricing tax ${basis}\nJurisdiction SYNTHETIC-JURISDICTION`;
  setText(doc, body);
  const eligibility = structuredClone(doc);
  eligibility.sourceId = "synthetic-tax-eligibility";
  eligibility.kind = "other";
  setText(eligibility, "SYNTHETIC ONLY: configured 100% recoverability for this test purchase; this is not practitioner advice or approval.");
  documents.push(eligibility);
  const claim: TaxClaim = {
    calculation: "rate", jurisdiction: "SYNTHETIC-JURISDICTION", taxPointDate: "2026-10-19", priceBasis: basis,
    rateBps: 1000, taxableBaseCents: 7700, originalTaxCents: 770, originalGrossCents: 8470, recoverableCents: 770,
    facts: {
      base: { ...cite(doc, "$77.00"), unit: "major" }, tax: { ...cite(doc, "$7.70"), unit: "major" }, gross: { ...cite(doc, "$84.70"), unit: "major" },
      date: cite(doc, "2026-10-19"), priceBasis: cite(doc, `tax ${basis}`), jurisdiction: cite(doc, "SYNTHETIC-JURISDICTION"), rate: cite(doc, "10%"),
    },
    eligibilityEvidence: [cite(eligibility, eligibility.extractedText)], eligibilityRationale: "Explicit synthetic test policy only",
  };
  return { claim, documents, rule: syntheticTaxRule(), original: { amountCents: 7700, taxCents: 770, source: { sourceId: doc.sourceId, revision: doc.revision, sha256: doc.sha256 } } };
}
export function setText(doc: SourceDocument, body: string) {
  Object.assign(doc, { extractedText: body, originalBase64: Buffer.from(body).toString("base64"), byteLength: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") });
}
export function cite(doc: SourceDocument, rawValue: string): TaxCitation {
  const start = doc.extractedText.indexOf(rawValue);
  return { source: { sourceId: doc.sourceId, revision: doc.revision, sha256: doc.sha256 }, page: 1, start, end: start + rawValue.length, quote: rawValue, rawValue };
}
