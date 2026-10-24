import type { BankCommand, BankScope, BankingProvider, TransferObservation } from "../contracts";

/** Document the actual provider guarantee, never infer retention from the retry budget. */
export type RailRecoveryCapability = {
  lookup: "operation_key" | "transfer_id_only" | "none";
  sameKeyResend:
    | { kind: "never"; reason: string }
    | { kind: "retained"; retentionMs: number; documentation: string }
    | { kind: "durable"; documentation: string };
};
export type TransferLookup = {
  scope: BankScope;
  commandId: string;
  idempotencyKey: string;
  requestHash: string;
  checkedAt: number;
} & (
  | { kind: "found"; observation: TransferObservation }
  | { kind: "not_found"; searchedBy: "operation_key" | "transfer_id" }
  | { kind: "unknown"; reason: string }
);

/** Trusted dispatcher only. Lookup must query provider state in all five scope dimensions.
 * Never implement lookup by createTransfer. A timeout/partial scan is unknown, not not_found. */
export interface PaymentRail extends Pick<BankingProvider, "createTransfer"> {
  readonly recovery: RailRecoveryCapability;
  lookupTransfer(command: BankCommand, providerTransferId?: string): Promise<TransferLookup>;
}
