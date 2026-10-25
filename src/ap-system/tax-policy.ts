import { CHART } from "../core/accounts";
import type { SourceBinding, SourceDocument } from "./contracts";
import type { RecoverableTaxPolicy, TaxCitation, TaxClaim } from "./tax-contracts";

const safe = (n: bigint): number => {
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("tax_unsafe_cents");
  return Number(n);
};
/** Integer arithmetic only. Inputs are validated nonnegative safe integer cents. */
export function taxProportion(amount: number, numerator: number, denominator: number): number {
  if (![amount, numerator, denominator].every(Number.isSafeInteger) || amount < 0 || numerator < 0 || denominator <= 0)
    throw new Error("tax_unsafe_cents");
  return safe((BigInt(amount) * BigInt(numerator) * 2n + BigInt(denominator)) / (2n * BigInt(denominator)));
}
export function calculatedTax(base: number, gross: number, rateBps: number, basis: "exclusive" | "inclusive"): number {
  return basis === "exclusive" ? taxProportion(base, rateBps, 10_000) : taxProportion(gross, rateBps, 10_000 + rateBps);
}
export function citedMoney(raw: string, unit: "major" | "minor"): number | null {
  if (unit === "minor") return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
  const match = /^\$?\s*((?:\d+|\d{1,3}(?:,\d{3})+))(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const result = BigInt(match[1]!.replaceAll(",", "")) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}
export function citedRate(raw: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?\s*%$/.exec(raw);
  if (!match) return null;
  const result = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : null;
}
export function citedDocument(citation: TaxCitation, documents: SourceDocument[]) {
  const doc = documents.find(d => d.sourceId === citation.source.sourceId && d.revision === citation.source.revision && d.sha256 === citation.source.sha256);
  return doc && citation.page <= doc.pageCount && doc.pageStatus.find(p => p.page === citation.page)?.status === "complete" &&
    citation.end > citation.start && doc.extractedText.slice(citation.start, citation.end) === citation.quote &&
    citation.quote.includes(citation.rawValue) ? doc : null;
}
export function taxClaimProblems(
  claim: TaxClaim, rule: RecoverableTaxPolicy, documents: SourceDocument[],
  original: { amountCents: number; taxCents: number; source: SourceBinding; taxableBaseCents?: number }, acceptedTaxCents: number,
): string[] {
  const errors = new Set<string>();
  if (claim.jurisdiction !== rule.jurisdiction || !rule.priceBases.includes(claim.priceBasis) ||
    claim.taxPointDate < rule.effectiveFrom || claim.taxPointDate > rule.effectiveThrough)
    errors.add("tax_policy_scope");
  const facts = Object.values(claim.facts).filter((v): v is TaxCitation => v !== undefined);
  if (facts.some(f => citedDocument(f, documents)?.kind !== "invoice" ||
    f.source.sourceId !== original.source.sourceId || f.source.revision !== original.source.revision || f.source.sha256 !== original.source.sha256))
    errors.add("tax_invoice_evidence");
  if (claim.eligibilityEvidence.some(f => {
    const doc = citedDocument(f, documents);
    return !doc || !["other", "contract", "correction"].includes(doc.kind) ||
      doc.sha256 === original.source.sha256 ||
      documents.some(source => source.kind === "invoice" && source.sha256 === doc.sha256);
  })) errors.add("tax_eligibility_evidence");
  const moneyMatches = claim.derivedHeaderBasis
    ? !!claim.facts.net && citedMoney(claim.facts.net.rawValue, claim.facts.net.unit) === original.amountCents &&
      !!rule.headerBasis && claim.derivedHeaderBasis.freight === rule.headerBasis.freight && claim.derivedHeaderBasis.discount === rule.headerBasis.discount
    : !!claim.facts.base && !!claim.facts.gross && citedMoney(claim.facts.base.rawValue, claim.facts.base.unit) === claim.taxableBaseCents &&
      citedMoney(claim.facts.gross.rawValue, claim.facts.gross.unit) === claim.originalGrossCents;
  if (!moneyMatches ||
    citedMoney(claim.facts.tax.rawValue, claim.facts.tax.unit) !== claim.originalTaxCents ||
    claim.facts.date.rawValue !== claim.taxPointDate || claim.facts.jurisdiction.rawValue !== claim.jurisdiction ||
    claim.facts.priceBasis.rawValue.toLowerCase() !== `tax ${claim.priceBasis}`)
    errors.add("tax_fact_mismatch");
  if (claim.taxableBaseCents !== (original.taxableBaseCents ?? original.amountCents) || claim.originalTaxCents !== original.taxCents ||
    BigInt(claim.taxableBaseCents) + BigInt(claim.originalTaxCents) !== BigInt(claim.originalGrossCents))
    errors.add("tax_original_arithmetic");
  if (claim.calculation === "rate") {
    if (claim.rateBps === null || !rule.rateBps.includes(claim.rateBps) ||
      !claim.facts.rate || citedRate(claim.facts.rate.rawValue) !== claim.rateBps ||
      calculatedTax(claim.taxableBaseCents, claim.originalGrossCents, claim.rateBps, claim.priceBasis) !== claim.originalTaxCents)
      errors.add("tax_rate_arithmetic");
  } else if (!rule.allowStatedAmount || claim.rateBps !== null || claim.facts.rate !== undefined)
    errors.add("tax_stated_amount_policy");
  if (claim.recoverableCents !== taxProportion(acceptedTaxCents, rule.recoverableBps, 10_000))
    errors.add("tax_recovery_amount");
  return [...errors];
}
/** Tax and cost remain separate original pools even for a tax-only supplier credit. */
export function recoverableCreditCents(originalTax: number, originalRecovery: number, previousTax: number, previousRecovery: number, creditTax: number): number {
  const cumulativeTax = safe(BigInt(previousTax) + BigInt(creditTax));
  if (cumulativeTax > originalTax || previousRecovery > originalRecovery) throw new Error("tax_credit_capacity");
  const cumulativeRecovery = originalTax ? taxProportion(originalRecovery, cumulativeTax, originalTax) : 0;
  const amount = cumulativeRecovery - previousRecovery;
  if (amount < 0 || amount > creditTax || previousRecovery + amount > originalRecovery) throw new Error("tax_credit_capacity");
  return amount;
}

/** Passive schema validation: declaring an account never activates a business policy. */
export function taxPolicyProblems(policy: {
  groups: { groupId: string }[];
  accounts: { account: string; treatment: string }[];
  taxCodes: { code: string; mode: string; recovery?: RecoverableTaxPolicy }[];
}): string[] {
  const errors = new Set<string>();
  for (const code of policy.taxCodes) {
    if (!code.recovery) continue;
    const rule = code.recovery;
    if (code.mode !== "recoverable") errors.add("tax_policy_mode");
    const account = CHART.find(a => a.code === rule.receivableAccount);
    if (!account || account.cash || account.type !== "asset" ||
      !policy.accounts.some(a => a.account === rule.receivableAccount && a.treatment === "tax"))
      errors.add("tax_receivable_account");
    if (policy.accounts.some(a => a.account === rule.receivableAccount && a.treatment === "tax") && policy.accounts.some(a => a.account === rule.receivableAccount && a.treatment !== "tax")) errors.add("tax_account_treatment");
    if (!policy.groups.some(g => g.groupId === rule.approvalGroupId)) errors.add("tax_approval_group");
  }
  for (const allocation of policy.accounts.filter(a => a.treatment === "tax")) {
    const account = CHART.find(a => a.code === allocation.account);
    if (!account || account.cash || account.type !== "asset") errors.add("tax_receivable_account");
  }
  return [...errors];
}
