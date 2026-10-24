import { BankResourceOutsideScope, sameBankScope, type BankScope, type BankTransaction } from "../contracts";
import { assertObservationMatchesCommand } from "../domain/rules";
import { assertFrozenBankCommand, parseBankScope, parseBankTransaction, parseTransferObservation } from "../domain/validation";
import type { PaymentEvidence, EvidenceBank } from "../ports/payment-evidence";

/** Read-only bank orchestration. Posting remains an atomic, separately retried kernel command. */
export class ReconcilePaymentEvidence {
  private readonly scope: BankScope;
  constructor(private readonly evidence: PaymentEvidence, private readonly bank: EvidenceBank, scope: BankScope) {
    this.scope = parseBankScope(scope);
  }
  private validateTransaction(value: BankTransaction, expectedId?: string): BankTransaction {
    const transaction = parseBankTransaction(value);
    if (!sameBankScope(transaction.scope, this.scope) || (expectedId && transaction.id !== expectedId)) {
      throw new Error("Bank transaction scope or identity mismatch");
    }
    return transaction;
  }
  private async observe(id: string, eventId?: string) {
    const observation = parseTransferObservation(await this.bank.getTransfer(this.scope, id));
    if (observation.id !== id || !sameBankScope(observation.scope, this.scope)) throw new Error("Bank transfer scope or identity mismatch");
    const command = await this.evidence.resolveCommand({ idempotencyKey: observation.idempotencyKey });
    if (!command) throw new Error("No frozen command for bank transfer");
    await assertFrozenBankCommand(command);
    assertObservationMatchesCommand(command, observation);
    const transactions: BankTransaction[] = [];
    for (const transactionId of [observation.originalTransactionId, observation.returnTransactionId]) {
      if (transactionId) transactions.push(this.validateTransaction(await this.bank.getTransaction(this.scope, transactionId), transactionId));
    }
    await this.evidence.observeTransfer({ observation, transactions, eventId });
  }
  async tick() {
    let work = await this.evidence.work();
    const errors: string[] = [];
    // Transaction polling is independent of delivery. Persist each page before fetching another.
    let cursor = work.cursor;
    for (let pages = 0; pages < 100; pages++) {
      const page = await this.bank.listTransactions(this.scope, { cursor, limit: 100 });
      const result = await this.evidence.importPage({ expectedCursor: cursor, cursor: page.cursor, transactions: page.items.map(item => this.validateTransaction(item)) });
      if (result.stale || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    for (const notice of work.notices) {
      try {
        if (notice.transferId) await this.observe(notice.transferId, notice.eventId);
        else {
          if (!notice.transactionId) throw new Error("Bank notice has no resource identity");
          const transaction = this.validateTransaction(await this.bank.getTransaction(this.scope, notice.transactionId), notice.transactionId);
          if (transaction.commandId) await this.observe(transaction.transferId, notice.eventId);
          else await this.evidence.observeTransactionNotice({ eventId: notice.eventId, transaction });
        }
      } catch (error) {
        // Ignore only a verified foreign DIRECT resource. A contradictory nested link
        // on one of our resources, a 404, or a failed verification must remain blocked.
        if (error instanceof BankResourceOutsideScope &&
            (notice.transferId ? error.resourceType === "ach_transfer" && error.resourceId === notice.transferId
              : error.resourceType === "transaction" && error.resourceId === notice.transactionId)) {
          await this.evidence.ignoreForeignNotice({ eventId: notice.eventId,
            resourceType: error.resourceType, resourceId: error.resourceId, accountId: error.accountId });
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        await this.evidence.recordError({ eventId: notice.eventId, error: message });
      }
    }
    work = await this.evidence.work();
    const transferIds = new Set([...work.commands.map(c => c.providerTransferId!), ...work.transactions.map(t => t.transaction.transferId)].filter(Boolean));
    for (const id of transferIds) {
      try { await this.observe(id); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    work = await this.evidence.work();
    // Return-first delivery still posts the verified original debit before its compensation.
    const ordered = [...work.transactions].sort((a, b) => Number(a.transaction.purpose === "return") - Number(b.transaction.purpose === "return"));
    let posted = 0;
    for (const record of ordered) {
      try {
        const result = await this.evidence.postTransaction({ transactionId: record.transaction.id });
        if (!result.replayed) posted++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        await this.evidence.recordError({ transactionId: record.transaction.id, error: message });
      }
    }
    return { posted, errors };
  }
}
