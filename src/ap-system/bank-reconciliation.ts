import { z } from "zod";
import type { BankScope, BankTransaction } from "../integrations/contracts";
export const sandboxFundingSchema = z.object({
  transactionId: z.string().trim().min(1).max(240),
  expectedAmountCents: z.number().int().safe().positive(),
  reason: z.string().trim().min(1).max(2000),
}).strict();
export type SandboxFundingInput = z.infer<typeof sandboxFundingSchema>;
/** Explicitly classified sandbox capital only; payment collections/returns remain ineligible. */
export function isSandboxFunding(scope: BankScope, tx: BankTransaction): boolean {
  return scope.provider === "increase" && scope.environment === "sandbox" &&
    ["inbound_wire_transfer", "inbound_ach_transfer"].includes(tx.sourceCategory ?? "") &&
    tx.purpose === "other" && !tx.commandId && !tx.transferId && !tx.originalTransactionId &&
    tx.status === "posted" && tx.currency === "USD" && Number.isSafeInteger(tx.amountCents) && tx.amountCents > 0 && !!tx.postedAt;
}
export type BankReconciliationView = {
  scope: BankScope;
  transactions: { transaction: BankTransaction; state: string; entryId: string | null; fundingReason: string | null; fundingEligible: boolean }[];
  blockers: { kind: string; id: string; reason: string }[];
  cashLedgerCents: number;
  importedNetCents: number;
  allImportedMatched: boolean;
  scanCompletedAt: number | null;
};
