import { z } from "zod";

const id = z.string().trim().min(1).max(240);
const cents = z.number().int().safe().nonnegative();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
export const taxHeaderTreatmentSchema = z.object({
  freight: z.enum(["included", "excluded"]),
  discount: z.enum(["reduces_base", "excluded"]),
}).strict();
export const taxHeaderAllocationSchema = z.object({
  originalFreightCents: cents, originalDiscountCents: cents,
  acceptedFreightCents: cents, acceptedDiscountCents: cents,
}).strict();
export const creditTaxHeaderAllocationSchema = z.object({ freightCents: cents, discountCents: cents }).strict();
export const recoverableTaxPolicySchema = z.object({
  version: z.literal("ap-recoverable-tax-v1"),
  receivableAccount: id,
  jurisdiction: id,
  rateBps: z.array(z.number().int().min(1).max(10_000)),
  allowStatedAmount: z.boolean(),
  priceBases: z.array(z.enum(["exclusive", "inclusive"])).min(1),
  recoverableBps: z.number().int().min(0).max(10_000),
  effectiveFrom: date,
  effectiveThrough: date,
  approvalGroupId: id,
  adjustments: z.object({
    mode: z.literal("reviewed_remaining_tax"),
    attribution: z.literal("explicit_original_allocation"),
    creditRounding: z.literal("half_up_cumulative_latest_adjustment"),
  }).strict().optional(),
  headerBasis: taxHeaderTreatmentSchema.extend({ partialTax: z.literal("half_up_taxable_base_proportion") }).strict().optional(),
  rounding: z.object({
    calculatedTax: z.literal("half_up_per_line"),
    partialAcceptance: z.literal("half_up_original_proportion"),
    recovery: z.literal("half_up_original_proportion"),
    credit: z.literal("half_up_cumulative_original_proportion"),
  }).strict(),
}).strict().refine(p =>
  p.effectiveFrom <= p.effectiveThrough &&
  (p.allowStatedAmount || p.rateBps.length > 0) &&
  new Set(p.rateBps).size === p.rateBps.length &&
  new Set(p.priceBases).size === p.priceBases.length,
"Tax policy needs a valid date interval and distinct explicit calculation choices");

export const taxCitationSchema = z.object({
  source: z.object({ sourceId: id, revision: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  page: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  quote: z.string().min(1).max(4000),
  rawValue: z.string().trim().min(1).max(2000),
}).strict();
export const moneyCitationSchema = taxCitationSchema.extend({ unit: z.enum(["major", "minor"]) });
export const taxClaimSchema = z.object({
  calculation: z.enum(["rate", "stated_amount"]),
  jurisdiction: id,
  taxPointDate: date,
  priceBasis: z.enum(["exclusive", "inclusive"]),
  rateBps: z.number().int().min(1).max(10_000).nullable(),
  taxableBaseCents: cents,
  originalTaxCents: cents,
  originalGrossCents: cents,
  recoverableCents: cents,
  derivedHeaderBasis: taxHeaderTreatmentSchema.optional(),
  facts: z.object({
    base: moneyCitationSchema.optional(), tax: moneyCitationSchema, gross: moneyCitationSchema.optional(),
    net: moneyCitationSchema.optional(),
    date: taxCitationSchema, priceBasis: taxCitationSchema,
    jurisdiction: taxCitationSchema, rate: taxCitationSchema.optional(),
  }).strict(),
  eligibilityEvidence: z.array(taxCitationSchema).min(1).max(20),
  eligibilityRationale: z.string().trim().min(1).max(4000),
}).strict().refine(c => c.calculation === "rate"
  ? c.rateBps !== null && c.facts.rate !== undefined
  : c.rateBps === null && c.facts.rate === undefined,
"Stated-amount claims must not invent a rate; rate claims require its evidence")
.refine(c => c.derivedHeaderBasis
  ? c.facts.net !== undefined && c.facts.base === undefined && c.facts.gross === undefined
  : c.facts.base !== undefined && c.facts.gross !== undefined && c.facts.net === undefined,
"Derived header bases cite original net/header facts; printed base/gross facts are not fabricated");

export type RecoverableTaxPolicy = z.infer<typeof recoverableTaxPolicySchema>;
export type TaxCitation = z.infer<typeof taxCitationSchema>;
export type TaxClaim = z.infer<typeof taxClaimSchema>;
