import { api } from "../../../convex/_generated/api";
import type { BankScope } from "../contracts";
import { parseBankScope } from "../domain/validation";
import type { PaymentEvidence } from "../ports/payment-evidence";
import type { KernelTransport } from "./convex-transport";

export function createConvexPaymentEvidence(client: KernelTransport, scope: BankScope, token: string): PaymentEvidence {
  const auth = { scope: parseBankScope(scope), token };
  return {
    work: () => client.query(api.demoEvidence.work, auth),
    ingestNotice: notice => client.mutation(api.demoEvidence.ingestNotice, { ...auth,
      eventId: notice.eventId, transferId: notice.transferId, transactionId: notice.transactionId, bodyHash: notice.bodyHash }),
    importPage: page => client.mutation(api.demoEvidence.importPage, { ...auth,
      expectedCursor: page.expectedCursor, cursor: page.cursor, transactions: page.transactions }),
    async observeTransfer(args) { await client.mutation(api.demoEvidence.observeTransfer, { ...auth,
      observation: args.observation, transactions: args.transactions, eventId: args.eventId }); },
    async observeTransactionNotice(args) { await client.mutation(api.demoEvidence.observeTransactionNotice, { ...auth,
      eventId: args.eventId, transaction: args.transaction }); },
    ignoreForeignNotice: args => client.mutation(api.demoEvidence.ignoreForeignNotice, { ...auth,
      eventId: args.eventId, resourceType: args.resourceType, resourceId: args.resourceId, accountId: args.accountId }),
    postTransaction: args => client.mutation(api.demoEvidence.postTransaction, { ...auth, transactionId: args.transactionId }),
    async recordError(args) { await client.mutation(api.demoEvidence.recordError, { ...auth,
      transactionId: args.transactionId, eventId: args.eventId, error: args.error }); },
    resolveCommand: args => client.query(api.demoEvidence.resolveCommand, { ...auth, idempotencyKey: args.idempotencyKey }),
  };
}
