import { z } from "zod";
const id = z.string().trim().min(1).max(240),
  quantity = z.string().regex(/^\d+(\.\d{1,6})?$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const sourceBindingSchema = z.object({
  sourceId: id,
  revision: z.number().int().positive(),
  sha256: hash,
});
export const physicalLineSchema = z
  .object({
    physicalLineId: id,
    sku: id,
    unit: id,
    capacity: quantity,
    unitPriceCents: z.number().int().safe().nonnegative().nullable(),
    locator: z
      .object({
        page: z.number().int().positive(),
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
        quote: z.string().min(1).max(4000),
      })
      .strict(),
  })
  .strict();
export const physicalAllocationSchema = z
  .object({
    reviewId: id,
    allocations: z
      .array(z.object({ physicalLineId: id, quantity }).strict())
      .min(1),
  })
  .strict();
export const physicalAccrualIdentitySchema = z
  .object({ reviewId: id, physicalLineId: id })
  .strict();
export const physicalMappingProposalSchema = z
  .object({
    caseId: id,
    expectedRevision: z.number().int().positive(),
    snapshotHash: hash,
    source: sourceBindingSchema,
    catalogId: id.optional(),
    physicalLines: z.array(physicalLineSchema).min(1).max(500).optional(),
    links: z
      .array(
        z.object({ parserLineId: id, physicalLineId: id, quantity }).strict(),
      )
      .min(1)
      .max(2000),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict()
  .refine(
    (p) => Number(!!p.catalogId) + Number(!!p.physicalLines) === 1,
    "Choose an existing immutable catalog or propose its initial physical lines",
  );
export const physicalLineOperationSchemas = {
  propose: z
    .object({ idempotencyKey: id, proposal: physicalMappingProposalSchema })
    .strict(),
  decide: z
    .object({
      reviewId: id,
      expectedHash: hash,
      outcome: z.enum(["approved", "rejected"]),
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
};
export type PhysicalLine = z.infer<typeof physicalLineSchema>;
export type PhysicalAllocation = z.infer<typeof physicalAllocationSchema>;
export type PhysicalMappingProposal = z.infer<
  typeof physicalMappingProposalSchema
>;
export type PhysicalLineInputs = {
  [K in keyof typeof physicalLineOperationSchemas]: z.infer<
    (typeof physicalLineOperationSchemas)[K]
  >;
};
export type PhysicalLineView = {
  catalogs: {
    catalogId: string;
    sourceHash: string;
    supplierId: string;
    purpose: string;
    hash: string;
    physicalLines: PhysicalLine[];
    capacities: {
      physicalLineId: string;
      consumedQuantity: string;
      accruedQuantity: string;
      remainingQuantity: string;
    }[];
  }[];
  reviews: {
    reviewId: string;
    caseId: string;
    proposal: PhysicalMappingProposal;
    hash: string;
    parsedHash: string;
    policyHash: string;
    status: string;
    catalogId: string | null;
    proposedBy: string;
    createdAt: number;
    decision: {
      subject: string;
      seatId: string;
      outcome: string;
      reason: string;
      at: number;
    } | null;
  }[];
};
