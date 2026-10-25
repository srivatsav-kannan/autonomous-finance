import { createHash } from "node:crypto";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { BankScope, BankingProvider, BankingEvents, TransferObservation, BankTransaction } from "../integrations/contracts";
import { BankResourceOutsideScope } from "../integrations/contracts";

export type KernelTransport = Pick<ConvexHttpClient, "query" | "mutation">;
/** Read-only bank capability; the evidence worker cannot submit or alter provider state. */
export type EvidenceBank = Pick<BankingProvider, "getTransfer" | "getTransaction" | "listTransactions">;
export class EvidenceWorker {
  constructor(private readonly kernel: KernelTransport, private readonly scope: BankScope, private readonly token: string, private readonly bank: EvidenceBank) {}
  private get auth() { return { scope: this.scope, token: this.token }; }

  /** Ingress authenticates exact bytes, persists the hint, and only then may send HTTP 2xx. */
  async receive(rawBody: Uint8Array, headers: Record<string, string>, verifier: Pick<BankingEvents, "verifyWebhook">) {
    const event = await verifier.verifyWebhook(rawBody, headers);
    if (JSON.stringify(event.scope) !== JSON.stringify(this.scope)) {
      // Use structural scope identity rather than caller-provided event scope on ingress.
      const { sameBankScope } = await import("../integrations/contracts");
      if (!sameBankScope(event.scope, this.scope)) throw new Error("Webhook subscription scope mismatch");
    }
    return this.kernel.mutation(api.demoEvidence.ingestNotice, {
      ...this.auth, eventId: event.id, transferId: event.transferId, transactionId: event.transactionId,
      bodyHash: createHash("sha256").update(rawBody).digest("hex"),
    });
  }
  private async observe(id: string, eventId?: string) {
    const observation: TransferObservation = await this.bank.getTransfer(this.scope, id);
    const transactions: BankTransaction[] = [];
    for (const transactionId of [observation.originalTransactionId, observation.returnTransactionId]) {
      if (transactionId) transactions.push(await this.bank.getTransaction(this.scope, transactionId));
    }
    await this.kernel.mutation(api.demoEvidence.observeTransfer, { ...this.auth, observation, transactions, eventId });
  }
  async tick() {
    let work = await this.kernel.query(api.demoEvidence.work, this.auth);
    const errors: string[] = [];
    // Transaction polling is independent of delivery. Persist each page before fetching another.
    let cursor = work.cursor;
    for (let pages = 0; pages < 100; pages++) {
      const page = await this.bank.listTransactions(this.scope, { cursor, limit: 100 });
      const result = await this.kernel.mutation(api.demoEvidence.importPage, { ...this.auth, expectedCursor: cursor, cursor: page.cursor, transactions: page.items });
      if (result.stale || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    for (const notice of work.notices) {
      try {
        if (notice.transferId) await this.observe(notice.transferId, notice.eventId);
        else {
          const transaction = await this.bank.getTransaction(this.scope, notice.transactionId!);
          if (transaction.commandId) await this.observe(transaction.transferId, notice.eventId);
          else await this.kernel.mutation(api.demoEvidence.observeTransactionNotice, { ...this.auth, eventId: notice.eventId, transaction });
        }
      } catch (error) {
        // Ignore only a verified foreign DIRECT resource. A contradictory nested link
        // on one of our resources, a 404, or a failed verification must remain blocked.
        if (error instanceof BankResourceOutsideScope &&
            (notice.transferId ? error.resourceType === "ach_transfer" && error.resourceId === notice.transferId
              : error.resourceType === "transaction" && error.resourceId === notice.transactionId)) {
          await this.kernel.mutation(api.demoEvidence.ignoreForeignNotice, { ...this.auth, eventId: notice.eventId,
            resourceType: error.resourceType, resourceId: error.resourceId, accountId: error.accountId });
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        await this.kernel.mutation(api.demoEvidence.recordError, { ...this.auth, eventId: notice.eventId, error: message });
      }
    }
    work = await this.kernel.query(api.demoEvidence.work, this.auth);
    const transferIds = new Set([...work.commands.map(c => c.providerTransferId!), ...work.transactions.map(t => t.transaction.transferId)].filter(Boolean));
    for (const id of transferIds) {
      try { await this.observe(id); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    work = await this.kernel.query(api.demoEvidence.work, this.auth);
    // Return-first delivery still posts the verified original debit before its compensation.
    const ordered = [...work.transactions].sort((a, b) => Number(a.transaction.purpose === "return") - Number(b.transaction.purpose === "return"));
    let posted = 0;
    for (const record of ordered) {
      try {
        const result = await this.kernel.mutation(api.demoEvidence.postTransaction, { ...this.auth, transactionId: record.transaction.id });
        if (!result.replayed) posted++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        await this.kernel.mutation(api.demoEvidence.recordError, { ...this.auth, transactionId: record.transaction.id, error: message });
      }
    }
    return { posted, errors };
  }
}
