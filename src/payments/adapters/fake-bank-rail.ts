import type { PaymentRail } from "../ports/payment-rail";

/** Pass the provider from openFakeBank; the SQLite store must be the original bank store. */
export function createFakeBankRail(provider: PaymentRail): PaymentRail {
  return Object.freeze({ recovery: provider.recovery,
    createTransfer: provider.createTransfer.bind(provider), lookupTransfer: provider.lookupTransfer.bind(provider) });
}
