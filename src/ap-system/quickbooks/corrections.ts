import { z } from "zod";
const id = z.string().min(1).max(180);
const cents = z.number().int().safe().nonnegative();
const base = {
  caseId: id,
  idempotencyKey: id,
  reason: z.string().trim().min(1).max(2000),
};
export const accountingCorrectionRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("bank_return"),
      paymentVersionId: id,
      returnTransactionId: id,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("payment_allocation"),
      paymentVersionId: id,
      originalBillCents: cents,
      restoredPayables: z
        .array(
          z
            .object({ correctionId: id, amountCents: cents.positive() })
            .strict(),
        )
        .max(20),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("credit_allocation"),
      creditApplicationId: id,
      originalBillCents: cents,
      restoredPayables: z
        .array(
          z
            .object({ correctionId: id, amountCents: cents.positive() })
            .strict(),
        )
        .max(20),
    })
    .strict(),
]);
export type AccountingCorrectionRequest = z.infer<
  typeof accountingCorrectionRequestSchema
>;
