import type { BankCommand, ExecutionStatus, UnsentProviderCheck } from "../contracts";
import { assertReleasableUnsent } from "../domain/rules";
import { assertFrozenBankCommand } from "../domain/validation";
import type { PaymentCommands } from "../ports/payment-kernel";
import type { PaymentRail, UnsentPaymentScanner } from "../ports/payment-rail";

export type ReleaseCandidate = {
  commandId: string; command: BankCommand; execution: ExecutionStatus;
  firstAttemptAt?: number; providerTransferId?: string; release?: unknown;
};

/** Operator recovery for a command claimed but never sent (worker died between claim and POST).
 * Runs in the trusted operator harness that holds the human client and read access to the bank.
 * It never sends, never mints a key and never changes the saved request: it proves absence
 * as far as the provider allows, then asks the kernel for an audited, human-only release. */
export class ReleaseUnsentPayment {
  constructor(private readonly commands: Pick<PaymentCommands, "releaseUnsent">,
    private readonly bank: Pick<PaymentRail, "lookupTransfer"> & UnsentPaymentScanner,
    private readonly now: () => number = Date.now) {}

  async release(candidate: ReleaseCandidate, reason: string): Promise<UnsentProviderCheck> {
    if (!reason.trim()) throw new Error("A human release reason is required");
    await assertFrozenBankCommand(candidate.command);
    assertReleasableUnsent(candidate, this.now());
    const firstAttemptAt = candidate.firstAttemptAt!;
    const lookup = await this.bank.lookupTransfer(candidate.command);
    if (lookup.kind === "found") throw new Error(`Provider shows transfer ${lookup.observation.id} for this key; reconcile it instead of releasing`);
    if (lookup.kind !== "not_found" || lookup.searchedBy !== "operation_key") throw new Error("Operation-key lookup did not prove absence; keep the reservation");
    const scan = await this.bank.scanForPossibleSend(candidate.command, firstAttemptAt);
    if (!scan.complete) throw new Error("Account scan was incomplete; keep the reservation");
    const providerCheck: UnsentProviderCheck = {
      lookup: "not_found", searchedBy: "operation_key", checkedAt: lookup.checkedAt,
      scanComplete: true, scannedFrom: firstAttemptAt, transfersScanned: scan.transfersScanned, transactionsScanned: scan.transactionsScanned,
      matchingTransferIds: scan.matchingTransferIds, matchingTransactionIds: scan.matchingTransactionIds,
    };
    // Fails before the kernel call when the scan found anything that could be this payment.
    assertReleasableUnsent(candidate, this.now(), providerCheck);
    await this.commands.releaseUnsent({ commandId: `release:${candidate.commandId}`,
      command: { type: "ReleaseUnsentPayment", commandId: candidate.commandId, reason: reason.trim(), providerCheck } });
    return providerCheck;
  }
}
