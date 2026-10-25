import { z } from "zod";
import { sourceBindingSchema, allocationSchema } from "./contracts";
const id = z.string().trim().min(1).max(240),
  cents = z.number().int().safe().nonnegative(),
  signed = z.number().int().safe();
export const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (d) =>
      Number.isFinite(Date.parse(`${d}T00:00:00Z`)) &&
      new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d,
    "Invalid calendar date",
  );
const quantity = z.string().regex(/^\d+(\.\d{1,6})?$/),
  evidence = z.array(sourceBindingSchema).min(1);
const statementLine = z.object({
  lineId: id,
  date,
  reference: id,
  amountCents: signed,
  match: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("bill"), id }),
    z.object({ kind: z.literal("credit"), id }),
    z.object({ kind: z.literal("payment"), id }),
    z.object({ kind: z.literal("return"), id }),
    z.object({ kind: z.literal("unmatched") }),
  ]),
});
export const statementSchema = z
  .object({
    supplierId: id,
    period: periodSchema,
    source: sourceBindingSchema,
    openingCents: signed,
    closingCents: signed,
    lines: z.array(statementLine),
  })
  .refine(
    (s) => new Set(s.lines.map((l) => l.lineId)).size === s.lines.length,
    "Statement lines must be distinct",
  );
export const statementReviewSchema = z.object({
  statementId: id,
  statementHash: id,
  snapshotHash: id,
  idempotencyKey: id,
  reason: id,
  resolutions: z.array(
    z.object({
      discrepancyId: id,
      classification: z.enum([
        "disputed_invoice",
        "timing_difference",
        "supplier_error",
      ]),
      reason: id,
      evidence,
    }),
  ),
});
export const accrualSchema = z.object({
  supplierId: id,
  source: sourceBindingSchema,
  lineId: id,
  sku: id,
  unit: id,
  description: id,
  quantity,
  capacityQuantity: quantity,
  unitPriceCents: cents,
  allocations: z.array(allocationSchema).min(1),
  date,
  expectedInvoiceCaseId: id.nullable(),
  quote: id,
  reason: id,
});
export const accrualApplicationSchema = z.object({ accrualId: id, quantity });
export const openingReviewSchema = z.object({
  evidence,
  cashBalances: z.array(z.object({ account: id, balanceCents: signed })),
  apCents: signed,
  accruedCents: signed,
  reason: id,
});
export const closeActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("disposition"),
    period: periodSchema,
    reference: id,
    snapshotHash: id,
    classification: z.enum(["not_obligation", "future_period", "duplicate"]),
    evidence,
    reason: id,
  }),
  z.object({ kind: z.literal("accrual"), accrual: accrualSchema }),
  z.object({
    kind: z.literal("reverse_accrual"),
    accrualId: id,
    quantity,
    date,
    evidence,
    reason: id,
  }),
  z.object({
    kind: z.literal("adjustment"),
    originalEntryId: id,
    date,
    fromAccount: id,
    toAccount: id,
    amountCents: cents.positive(),
    store: z.string().nullable(),
    evidence,
    reason: id,
  }),
  z.object({
    kind: z.literal("close"),
    period: periodSchema,
    snapshotHash: id,
    opening: openingReviewSchema,
    reason: id,
  }),
  z.object({
    kind: z.literal("reopen"),
    period: periodSchema,
    closeActionId: id,
    evidence,
    reason: id,
  }),
]);
export const closeProposalSchema = z.object({
  idempotencyKey: id,
  action: closeActionSchema,
});
export const closeVoteSchema = z.object({
  actionId: id,
  actionHash: id,
  idempotencyKey: id,
  outcome: z.enum(["approved", "rejected"]),
  reason: id,
  delegationId: id.optional(),
});
export type SupplierStatement = z.infer<typeof statementSchema>;
export type StatementReview = z.infer<typeof statementReviewSchema>;
export type Accrual = z.infer<typeof accrualSchema>;
export type AccrualApplication = z.infer<typeof accrualApplicationSchema>;
export type OpeningReview = z.infer<typeof openingReviewSchema>;
export type CloseAction = z.infer<typeof closeActionSchema>;
export type CloseProposal = z.infer<typeof closeProposalSchema>;
export type CloseVote = z.infer<typeof closeVoteSchema>;
export type CloseBlocker = {
  code: string;
  owner: "controller" | "ap_clerk" | "treasury" | "purchasing_owner";
  reference: string;
  reason: string;
};
export type PeriodView = {
  period: string;
  status: "open" | "closed";
  snapshotHash: string;
  reconciliationHash: string;
  ready: boolean;
  blockers: CloseBlocker[];
  opening: {
    apCents: number;
    accruedCents: number;
    cashBalances: { account: string; balanceCents: number }[];
  };
  reconciliation: {
    apGLCents: number;
    apSubledgerCents: number;
    differenceCents: number;
    accruedGLCents: number;
    accruedSubledgerCents: number;
  };
  suppliers: {
    supplierId: string;
    openingCents: number;
    closingCents: number;
  }[];
  movements: {
    kind: "bill" | "credit" | "payment" | "return";
    id: string;
    reference: string;
    date: string;
    amountCents: number;
    supplierId: string;
  }[];
  unpaidBills: {
    billId: string;
    caseId: string | null;
    supplierId: string;
    reference: string;
    recognizedCents: number;
    appliedCreditCents: number;
    cashCents: number;
    outstandingCents: number;
  }[];
  statements: {
    statementId: string;
    hash: string;
    status: string;
    supplierId: string;
    discrepancies: {
      discrepancyId: string;
      amountCents: number;
      reason: string;
    }[];
  }[];
  accruals: {
    accrualId: string;
    supplierId: string;
    sku: string;
    unit: string;
    quantity: string;
    reversedQuantity: string;
    outstandingQuantity: string;
    source: z.infer<typeof sourceBindingSchema>;
    sourceLineId: string;
    date: string;
    amountCents: number;
    reversedCents: number;
    outstandingCents: number;
    entryId: string;
    expectedInvoiceCaseId: string | null;
  }[];
  history: {
    actionId: string;
    kind: string;
    at: number;
    actor: string;
    reason: string;
  }[];
};
