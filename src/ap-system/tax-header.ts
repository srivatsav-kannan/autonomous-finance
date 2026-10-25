import type { APIntake } from "./contracts";
import type { AcceptedLine, BusinessAcceptance, BusinessPolicy, CreditPlan } from "./domain-contracts";
import type { TaxClaim } from "./tax-contracts";
import { citedDocument, citedMoney, taxProportion } from "./tax-policy";

/** This is a declared attribution, never an inferred printed taxable base. */
export function headerTaxBase(net: number, freight: number, discount: number, treatment: NonNullable<TaxClaim["derivedHeaderBasis"]>): number {
  const value = BigInt(net) + (treatment.freight === "included" ? BigInt(freight) : 0n) - (treatment.discount === "reduces_base" ? BigInt(discount) : 0n);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("tax_header_base");
  return Number(value);
}
export function acceptedHeaderTax(line: AcceptedLine, original: { amountCents: number; taxCents: number }): { originalBase: number; acceptedBase: number; taxCents: number } | null {
  if (!line.tax?.derivedHeaderBasis || !line.headerAllocation) return null;
  const a = line.headerAllocation, t = line.tax.derivedHeaderBasis;
  const originalBase = headerTaxBase(original.amountCents, a.originalFreightCents, a.originalDiscountCents, t);
  const acceptedBase = headerTaxBase(line.netCents, a.acceptedFreightCents, a.acceptedDiscountCents, t);
  if (acceptedBase > originalBase || (!originalBase && original.taxCents)) throw new Error("tax_header_base");
  return { originalBase, acceptedBase, taxCents: originalBase ? taxProportion(original.taxCents, acceptedBase, originalBase) : 0 };
}
export function taxHeaderProblems(input: APIntake, acceptance: BusinessAcceptance, policy: BusinessPolicy): string[] {
  const c = input.candidate;
  if (!c) return [];
  const governed = acceptance.lines.some(l => l.tax?.derivedHeaderBasis || l.headerAllocation) || !!acceptance.taxHeaderEvidence;
  const recovery = acceptance.lines.some(l => policy.taxCodes.some(t => t.code === l.taxCode && t.mode === "recoverable"));
  if (!governed) return recovery && (c.freightCents || c.discountCents) ? ["tax_header_basis"] : [];
  const errors = new Set<string>();
  if (!recovery || acceptance.lines.some(l => !l.headerAllocation)) errors.add("tax_header_coverage");
  const totals = { originalFreightCents: c.freightCents, originalDiscountCents: c.discountCents, acceptedFreightCents: acceptance.freightCents, acceptedDiscountCents: acceptance.discountCents };
  for (const [key, expected] of Object.entries(totals)) {
    const actual = acceptance.lines.reduce((n,l) => n + BigInt(l.headerAllocation?.[key as keyof typeof totals] ?? 0), 0n);
    if (actual !== BigInt(expected)) errors.add("tax_header_allocation");
  }
  for (const l of acceptance.lines) {
    const a = l.headerAllocation;
    if (!a) continue;
    if (a.acceptedFreightCents > a.originalFreightCents || a.acceptedDiscountCents > a.originalDiscountCents ||
      (Number(l.quantity) === 0 && (a.acceptedFreightCents || a.acceptedDiscountCents))) errors.add("tax_header_allocation");
    const rule = policy.taxCodes.find(t => t.code === l.taxCode && t.mode === "recoverable")?.recovery;
    if (rule && (!rule.headerBasis || !l.tax?.derivedHeaderBasis)) errors.add("tax_header_basis");
    if (!rule && l.tax?.derivedHeaderBasis) errors.add("tax_header_basis");
    try { const original = c.lines.find(x => x.lineId === l.lineId); if (original) acceptedHeaderTax(l, original); }
    catch { errors.add("tax_header_base"); }
  }
  for (const category of ["freight", "discount"] as const) {
    const fact = acceptance.taxHeaderEvidence?.[category], amount = c[`${category}Cents`];
    const doc = fact && citedDocument(fact, input.documents);
    if ((!fact && amount !== 0) || (fact && (!doc || doc.kind !== "invoice" || !c.evidence.some(e => e.fieldPath === "totalCents" && e.contentStatus === "supported" && e.source.sourceId === doc.sourceId && e.source.revision === doc.revision && e.source.sha256 === doc.sha256) || citedMoney(fact.rawValue, fact.unit) !== amount)))
      errors.add("tax_header_evidence");
  }
  return [...errors];
}
/** Cumulative reductions retain the original attribution even after policy changes. */
export function creditHeaderProblems(plan: CreditPlan, acceptance: BusinessAcceptance, previous: CreditPlan[]): string[] {
  const governed = acceptance.lines.some(l => l.headerAllocation);
  if (!governed) return plan.lines.some(l => l.headerAllocation) ? ["tax_header_credit"] : [];
  const errors = new Set<string>();
  for (const category of ["freightCents", "discountCents"] as const) {
    if (plan.lines.reduce((n,l) => n + BigInt(l.headerAllocation?.[category] ?? 0), 0n) !== BigInt(plan[category])) errors.add("tax_header_credit");
  }
  for (const item of plan.lines) {
    const original = acceptance.lines.find(l => l.lineId === item.originalLineId), a = original?.headerAllocation;
    if (!a || !item.headerAllocation) { errors.add("tax_header_credit"); continue; }
    const prior = previous.flatMap(p => p.lines).filter(l => l.originalLineId === item.originalLineId);
    if (prior.some(l => !l.headerAllocation)) errors.add("tax_header_credit_history");
    for (const [category, cap] of [["freightCents",a.acceptedFreightCents],["discountCents",a.acceptedDiscountCents]] as const) {
      if (prior.reduce((n,l) => n + BigInt(l.headerAllocation?.[category] ?? 0), BigInt(item.headerAllocation[category])) > BigInt(cap)) errors.add("tax_header_credit_capacity");
    }
    if (item.basis === "tax_adjustment" && (item.headerAllocation.freightCents || item.headerAllocation.discountCents)) errors.add("tax_header_credit");
  }
  return [...errors];
}
export function expectedHeaderCreditTax(accepted: AcceptedLine, item: CreditPlan["lines"][number], prior: CreditPlan["lines"]): number | null {
  if (!accepted.tax?.derivedHeaderBasis || !accepted.headerAllocation || !item.headerAllocation) return null;
  const t = accepted.tax.derivedHeaderBasis, a = accepted.headerAllocation;
  const base = headerTaxBase(accepted.netCents, a.acceptedFreightCents, a.acceptedDiscountCents, t);
  const sum = (field: "netCents" | "freightCents" | "discountCents") => prior.reduce((n,l) => n + BigInt(field === "netCents" ? l.netCents : l.headerAllocation?.[field] ?? 0), BigInt(field === "netCents" ? item.netCents : item.headerAllocation![field]));
  const usedBase = headerTaxBase(Number(sum("netCents")),Number(sum("freightCents")),Number(sum("discountCents")),t);
  if (usedBase > base) throw new Error("tax_header_credit_capacity");
  return Math.max(0, (base ? taxProportion(accepted.taxCents, usedBase, base) : 0) - prior.reduce((n,l) => n+l.taxCents,0));
}
