import { randomUUID } from "node:crypto";
import { ExecutePaymentEffect, type EffectRuntime } from "./application/execute-payment-effect";
import { ReconcilePaymentEvidence } from "./application/reconcile-payment-evidence";
import { createConvexPaymentKernel } from "./adapters/convex-payment-kernel";
import { createConvexPaymentEvidence } from "./adapters/convex-payment-evidence";
import { createFakeBankRail } from "./adapters/fake-bank-rail";
import { createIncreasePaymentRail } from "./adapters/increase-payment-rail";
import { receiveBankNotice } from "./adapters/webhook-ingress";
import type { KernelTransport } from "./adapters/convex-transport";
import type { BankScope } from "./contracts";
import { parseBankScope } from "./domain/validation";
import type { EvidenceBank, EvidenceWebhookVerifier } from "./ports/payment-evidence";
import type { PaymentRail } from "./ports/payment-rail";

export function createEffectRuntime(): EffectRuntime {
  return {
    now: Date.now, newLeaseToken: randomUUID,
    startHeartbeat(callback) {
      let running = false;
      const timer = setInterval(() => {
        if (running) return;
        running = true;
        void callback().finally(() => { running = false; });
      }, 10_000);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

export function createPaymentDispatcher(client: KernelTransport, scope: BankScope, token: string, bank: PaymentRail, workerId: string) {
  const rail = scope.provider === "fake" ? createFakeBankRail(bank) : createIncreasePaymentRail(bank);
  return new ExecutePaymentEffect(createConvexPaymentKernel(client, scope, token), rail, workerId, createEffectRuntime());
}

export function createEvidenceWorker(client: KernelTransport, binding: BankScope, token: string, bank: EvidenceBank) {
  const scope = parseBankScope(binding);
  const evidence = createConvexPaymentEvidence(client, scope, token);
  // Strip submission and simulator capabilities even if a compatibility caller passed a full bank.
  const reader: EvidenceBank = { getTransfer: bank.getTransfer.bind(bank), getTransaction: bank.getTransaction.bind(bank), listTransactions: bank.listTransactions.bind(bank) };
  const worker = new ReconcilePaymentEvidence(evidence, reader, scope);
  return { tick: () => worker.tick(), receive: (rawBody: Uint8Array, headers: Record<string, string>, verifier: EvidenceWebhookVerifier) =>
    receiveBankNotice(evidence, scope, rawBody, headers, verifier) };
}
