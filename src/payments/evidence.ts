import { createEvidenceWorker } from "./bootstrap";
import type { KernelTransport } from "./adapters/convex-transport";
import type { BankScope } from "./contracts";
import type { EvidenceBank, EvidenceWebhookVerifier } from "./ports/payment-evidence";
export type { KernelTransport } from "./adapters/convex-transport";
export type { EvidenceBank } from "./ports/payment-evidence";

/** Compatibility facade. Submission and posted-evidence processing remain separate services. */
export class EvidenceWorker {
  private readonly worker: ReturnType<typeof createEvidenceWorker>;
  constructor(kernel: KernelTransport, scope: BankScope, token: string, bank: EvidenceBank) {
    this.worker = createEvidenceWorker(kernel, scope, token, bank);
  }
  receive(rawBody: Uint8Array, headers: Record<string, string>, verifier: EvidenceWebhookVerifier) {
    return this.worker.receive(rawBody, headers, verifier);
  }
  tick() { return this.worker.tick(); }
}
