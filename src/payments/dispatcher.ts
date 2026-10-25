import { createPaymentDispatcher } from "./bootstrap";
import type { KernelTransport } from "./adapters/convex-transport";
import type { BankScope } from "./contracts";
import type { PaymentRail } from "./ports/payment-rail";

/** Existing worker constructor; orchestration lives behind the typed application ports. */
export class PaymentDispatcher {
  private readonly worker: ReturnType<typeof createPaymentDispatcher>;
  constructor(kernel: KernelTransport, scope: BankScope, token: string, bank: PaymentRail, workerId: string) {
    this.worker = createPaymentDispatcher(kernel, scope, token, bank, workerId);
  }
  tick() { return this.worker.tick(); }
}
