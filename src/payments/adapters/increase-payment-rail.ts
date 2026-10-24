import type { PaymentRail } from "../ports/payment-rail";

/** Pass the bound IncreaseSandboxBank; no credentials or simulator controls escape. */
export function createIncreasePaymentRail(provider: PaymentRail): PaymentRail {
  return Object.freeze({ recovery: provider.recovery,
    createTransfer: provider.createTransfer.bind(provider), lookupTransfer: provider.lookupTransfer.bind(provider) });
}
