import { BankProviderError, type BankErrorClass, type LeaseProof } from "../contracts";
import { assertObservationMatchesCommand, decideRecovery } from "../domain/rules";
import { assertFrozenBankCommand, parseEffectLease } from "../domain/validation";
import type { PaymentKernel } from "../ports/payment-kernel";
import type { PaymentRail } from "../ports/payment-rail";

export type EffectRuntime = {
  now(): number;
  newLeaseToken(): string;
  startHeartbeat(callback: () => Promise<void>): () => void;
};
export type DispatchResult = { dispatched: boolean; stale?: boolean; providerTransferId?: string; error?: BankErrorClass };

/** Only this application service receives transfer submission authority. */
export class ExecutePaymentEffect {
  constructor(private readonly kernel: PaymentKernel, private readonly rail: PaymentRail,
    private readonly workerId: string, private readonly runtime: EffectRuntime) {}

  async tick(): Promise<DispatchResult> {
    const claim = await this.kernel.claim({ workerId: this.workerId, leaseToken: this.runtime.newLeaseToken() });
    if (!claim) return { dispatched: false };
    const proof: LeaseProof = { commandId: claim.commandId, generation: claim.generation, leaseToken: claim.leaseToken };
    let leaseLost = false;
    const stopHeartbeat = this.runtime.startHeartbeat(async () => {
      try { await this.kernel.heartbeat(proof); }
      catch { leaseLost = true; }
    });
    try {
      // A malformed or conflicting command/observation requires review, never transport retry.
      const validate = async <T>(fn: () => T | Promise<T>): Promise<T> => {
        try { return await fn(); }
        catch { throw new BankProviderError("configuration", "Invalid frozen payment command, lease or bank observation"); }
      };
      const lease = await validate(() => parseEffectLease(claim));
      await validate(() => assertFrozenBankCommand(lease.command));
      let observation;
      if (lease.action === "reconcile") {
        const lookup = await this.rail.lookupTransfer(lease.command, lease.providerTransferId);
        const decision = await validate(() => {
          if (!lookup || !["found", "not_found", "unknown"].includes(lookup.kind)) throw new Error("Invalid recovery lookup");
          return decideRecovery(lease, this.rail.recovery, lookup, this.runtime.now());
        });
        if (decision.action === "review") throw new BankProviderError("configuration", decision.reason);
        if (decision.action === "complete") observation = decision.observation;
      }
      if (leaseLost || this.runtime.now() >= lease.leaseExpiresAt) return { dispatched: true, stale: true };
      // Keep the original command, operation key and providerRequest bytes on every attempt.
      observation ??= await this.rail.createTransfer(lease.command);
      await validate(() => assertObservationMatchesCommand(lease.command, observation, {
        providerTransferId: lease.providerTransferId, firstAttemptAt: lease.firstAttemptAt, execution: "in_flight",
      }));
      if (leaseLost) return { dispatched: true, stale: true };
      await this.kernel.complete({ ...proof, providerTransferId: observation.id });
      return { dispatched: true, providerTransferId: observation.id };
    } catch (error) {
      const normalized = error instanceof BankProviderError ? error : new BankProviderError("unknown", error instanceof Error ? error.message : String(error), true);
      try { await this.kernel.fail({ ...proof, errorClass: normalized.errorClass, error: normalized.message, retryAfterMs: normalized.retryAfterMs }); }
      catch { return { dispatched: true, stale: true }; }
      return { dispatched: true, error: normalized.errorClass };
    } finally { stopHeartbeat(); }
  }
}
