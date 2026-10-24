import type { BankCommand, BankTransaction, BankingEvents, BankingProvider, TransferObservation } from "../contracts";

export type EvidenceBank = Pick<BankingProvider, "getTransfer" | "getTransaction" | "listTransactions">;
export type EvidenceWebhookVerifier = Pick<BankingEvents, "verifyWebhook">;
export type EvidenceNotice = { eventId: string; transferId?: string; transactionId?: string; bodyHash: string };
export type EvidenceWork = {
  notices: { eventId: string; transferId?: string; transactionId?: string }[];
  commands: { providerTransferId?: string }[];
  transactions: { transaction: BankTransaction }[];
  cursor: string | null;
};

/** Evidence-service-authenticated, full-scope-bound adapter. No transfer submission capability. */
export interface PaymentEvidence {
  work(): Promise<EvidenceWork>;
  ingestNotice(notice: EvidenceNotice): Promise<{ duplicate: boolean }>;
  importPage(args: { expectedCursor: string | null; cursor: string | null; transactions: BankTransaction[] }): Promise<{ stale: boolean }>;
  observeTransfer(args: { observation: TransferObservation; transactions: BankTransaction[]; eventId?: string }): Promise<void>;
  observeTransactionNotice(args: { eventId: string; transaction: BankTransaction }): Promise<void>;
  ignoreForeignNotice(args: { eventId: string; resourceType: "ach_transfer" | "transaction"; resourceId: string; accountId: string }): Promise<{ replayed: boolean }>;
  postTransaction(args: { transactionId: string }): Promise<{ entryId: string; replayed: boolean }>;
  recordError(args: { transactionId?: string; eventId?: string; error: string }): Promise<void>;
  resolveCommand(args: { idempotencyKey: string }): Promise<BankCommand | null>;
}
