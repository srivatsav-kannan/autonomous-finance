import { api } from "../../../convex/_generated/api";
import type { BankScope } from "../contracts";
import { parseBankScope } from "../domain/validation";
import type { PaymentEvidence } from "../ports/payment-evidence";
import type { KernelTransport } from "./convex-transport";

export function createConvexPaymentEvidence(client: KernelTransport, scope: BankScope, token: string): PaymentEvidence {
  const auth = { scope: parseBankScope(scope), token };
  return {
    work: () => client.query(api.demoEvidence.work, auth),
    ingestNotice: notice => client.mutation(api.demoEvidence.ingestNotice, { ...auth, ...notice }),
    importPage: page => client.mutation(api.demoEvidence.importPage, { ...auth, ...page }),
    async observeTransfer(args) { await client.mutation(api.demoEvidence.observeTransfer, { ...auth, ...args }); },
    async observeTransactionNotice(args) { await client.mutation(api.demoEvidence.observeTransactionNotice, { ...auth, ...args }); },
    ignoreForeignNotice: args => client.mutation(api.demoEvidence.ignoreForeignNotice, { ...auth, ...args }),
    postTransaction: args => client.mutation(api.demoEvidence.postTransaction, { ...auth, ...args }),
    async recordError(args) { await client.mutation(api.demoEvidence.recordError, { ...auth, ...args }); },
    resolveCommand: args => client.query(api.demoEvidence.resolveCommand, { ...auth, ...args }),
  };
}
