import { randomUUID } from "node:crypto";
import { api } from "../../convex/_generated/api";
import { BankProviderError, type BankScope, type BankingProvider } from "../integrations/contracts";
import type { KernelTransport } from "./evidence";

/** The only application component with a transfer-submission capability. */
export class PaymentDispatcher {
  constructor(private readonly kernel: KernelTransport, private readonly scope: BankScope, private readonly token: string, private readonly bank: Pick<BankingProvider, "createTransfer">, private readonly workerId: string) {}
  async tick() {
    const auth = { scope: this.scope, token: this.token };
    const claim = await this.kernel.mutation(api.demoPayments.claim, { ...auth, workerId: this.workerId, leaseToken: randomUUID() });
    if (!claim) return { dispatched: false };
    const fence = { ...auth, commandId: claim.commandId, generation: claim.generation, leaseToken: claim.leaseToken };
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void this.kernel.mutation(api.demoPayments.heartbeat, fence).catch(() => { leaseLost = true; });
    }, 10_000);
    heartbeat.unref();
    try {
      // Never reconstruct from current bill/vendor data or select another provider after ambiguity.
      const result = await this.bank.createTransfer(claim.command);
      if (leaseLost) return { dispatched: true, stale: true };
      await this.kernel.mutation(api.demoPayments.complete, { ...fence, providerTransferId: result.id });
      return { dispatched: true, providerTransferId: result.id };
    } catch (error) {
      const normalized = error instanceof BankProviderError ? error : new BankProviderError("unknown", error instanceof Error ? error.message : String(error), true);
      try {
        await this.kernel.mutation(api.demoPayments.fail, { ...fence, errorClass: normalized.errorClass, error: normalized.message, retryAfterMs: normalized.retryAfterMs });
      } catch {
        // Lease takeover or verified evidence may have won. The persisted attempt remains recoverable.
        return { dispatched: true, stale: true };
      }
      return { dispatched: true, error: normalized.errorClass };
    } finally { clearInterval(heartbeat); }
  }
}
