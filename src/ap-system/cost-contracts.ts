import { z } from "zod";
const id = z.string().trim().min(1).max(240);
const sourceBindingSchema = z.object({
  sourceId: id,
  revision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const correctedCostAllocationSchema = z.object({
  originalLineId: id,
  allocationIndex: z.number().int().nonnegative(),
  account: id,
  store: z.string().nullable(),
  treatment: z.enum(["expense", "inventory", "fixed_asset", "prepayment"]),
  side: z.enum(["credit", "debit"]),
  amountCents: z.number().int().safe().positive(),
});
/** An explicit human-reviewed replacement for exact original allocation shares. */
export const costCorrectionSchema = z.object({
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  allocations: z.array(correctedCostAllocationSchema).min(1),
  evidence: z.array(sourceBindingSchema).min(1),
  reason: id,
});
export type CostCorrection = z.infer<typeof costCorrectionSchema>;
export type CorrectedCostAllocation = z.infer<
  typeof correctedCostAllocationSchema
>;
export type CostState = {
  originalEntryId: string;
  originalShares: {
    originalLineId: string;
    allocationIndex: number;
    account: string;
    store: string | null;
    treatment: string;
    period: string;
    side: "credit" | "debit";
    amountCents: number;
    remainingCents: number;
  }[];
  billId: string | null;
  accrualId: string | null;
  snapshotHash: string;
  latestDate: string;
  supplierId: string | null;
  positions: { account: string; store: string | null; balanceCents: number }[];
  corrections: {
    actionId: string;
    entryId: string;
    date: string;
    fromAccount: string;
    toAccount: string;
    store: string | null;
    amountCents: number;
  }[];
};
