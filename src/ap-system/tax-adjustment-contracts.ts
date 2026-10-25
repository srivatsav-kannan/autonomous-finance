import { z } from "zod";
import { taxCitationSchema } from "./tax-contracts";
const id = z.string().trim().min(1).max(240),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  cents = z.number().int().safe().nonnegative();
export const taxPositionSchema = z
  .object({
    originalLineId: id,
    allocationIndex: z.number().int().nonnegative(),
    account: id,
    treatment: z.enum([
      "expense",
      "inventory",
      "fixed_asset",
      "prepayment",
      "tax",
    ]),
    store: id.nullable(),
    department: id.nullable(),
    project: id.nullable(),
  })
  .strict();
export const taxShareSchema = taxPositionSchema
  .extend({ amountCents: cents.positive() })
  .strict();
export const taxAdjustmentSchema = z
  .object({
    kind: z.literal("tax_adjustment"),
    originalEntryId: id,
    originalApprovalId: id,
    costSnapshotHash: hash,
    taxSnapshotHash: hash,
    initialAttribution: z.array(taxShareSchema).optional(),
    targets: z
      .array(z.object({ originalLineId: id, recoverableCents: cents }).strict())
      .min(1),
    movements: z
      .array(
        z
          .object({
            from: taxShareSchema,
            toAccount: id,
            toTreatment: taxPositionSchema.shape.treatment,
          })
          .strict(),
      )
      .min(1),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (d) =>
          Number.isFinite(Date.parse(`${d}T00:00:00Z`)) &&
          new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d,
      ),
    eligibilityEvidence: z.array(taxCitationSchema).min(1),
    reason: id,
  })
  .strict();
export const taxReversalSchema = z
  .object({
    snapshotHash: hash,
    allocations: z.array(taxShareSchema),
    reason: id,
  })
  .strict();
export type TaxPosition = z.infer<typeof taxPositionSchema>;
export type TaxShare = z.infer<typeof taxShareSchema>;
export type TaxAdjustment = z.infer<typeof taxAdjustmentSchema>;
export type TaxReversal = z.infer<typeof taxReversalSchema>;
export type TaxState = {
  originalEntryId: string;
  originalApprovalId: string;
  billId: string;
  supplierId: string;
  costSnapshotHash: string;
  snapshotHash: string;
  latestDate: string;
  adjusted: boolean;
  lines: {
    originalLineId: string;
    taxCode: string;
    jurisdiction: string;
    priceBasis: "exclusive" | "inclusive";
    remainingTaxCents: number;
    creditBasisTaxCents: number;
    creditBasisRecoverableCents: number;
    creditedTaxCents: number;
    creditedRecoverableCents: number;
    unattributedCostCents: number;
  }[];
  buckets: TaxShare[];
  events: { actionId: string; entryId: string; date: string }[];
};
export const taxPositionKey = (p: TaxPosition) =>
  JSON.stringify([
    p.originalLineId,
    p.allocationIndex,
    p.account,
    p.treatment,
    p.store,
    p.department,
    p.project,
  ]);
