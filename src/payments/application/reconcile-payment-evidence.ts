import {
  BankProviderError, BankResourceOutsideScope, sameBankScope,
  type BankItemFailure, type BankPage, type BankScope, type BankTransaction,
} from "../contracts";
import { assertObservationMatchesCommand } from "../domain/rules";
import { assertFrozenBankCommand, parseBankScope, parseBankTransaction, parseTransferObservation } from "../domain/validation";
import type { PaymentEvidence, EvidenceBank, EvidenceWork } from "../ports/payment-evidence";

/** Read-only bank orchestration. Posting remains an atomic, separately retried kernel command. */
export class ReconcilePaymentEvidence {
  private readonly scope: BankScope;
  constructor(private readonly evidence: PaymentEvidence, private readonly bank: EvidenceBank, scope: BankScope,
    private readonly now: () => number = Date.now) {
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
    // Unmatched, verified account activity is evidence too. Preserve it as a close
    // blocker; the posting mutation still requires a matching frozen command.
    if (command) {
      await assertFrozenBankCommand(command);
      assertObservationMatchesCommand(command, observation);
    }
    const transactions: BankTransaction[] = [];
    for (const transactionId of [observation.originalTransactionId, observation.returnTransactionId]) {
      if (transactionId) transactions.push(this.validateTransaction(await this.bank.getTransaction(this.scope, transactionId), transactionId));
    }
    await this.evidence.observeTransfer({ observation, transactions, eventId });
  }
  /** Validate each listed row on its own. A failed row is recorded for retry with the page,
   * so the cursor never moves past evidence that was neither imported nor recorded. */
  private splitPage(page: BankPage<BankTransaction>) {
    const transactions: BankTransaction[] = [];
    const failures: BankItemFailure[] = [];
    for (const failure of page.failures ?? []) {
      if (typeof failure?.id !== "string" || !failure.id.trim()) throw new Error("Bank page failure has no transaction identity");
      failures.push({ id: failure.id, errorClass: failure.errorClass, error: String(failure.error).slice(0, 300),
        ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) });
    }
    for (const item of page.items) {
      try { transactions.push(this.validateTransaction(item)); }
      catch (error) {
        const id = (item as { id?: unknown })?.id;
        if (typeof id !== "string" || !id.trim()) throw new Error("Bank page item has no transaction identity");
        failures.push({ id, errorClass: "validation", error: error instanceof Error ? error.message.slice(0, 300) : "Invalid bank transaction" });
      }
    }
    return { transactions, failures };
  }
  private async poll(work: EvidenceWork, errors: string[]) {
    // Transaction polling is independent of delivery. Persist each page before fetching another.
    let cursor = work.cursor;
    try {
      for (let pages = 0; pages < 100; pages++) {
        const page = await this.bank.listTransactions(this.scope, { cursor, limit: 100,
          ...(work.activitySince ? { createdOnOrAfter: work.activitySince } : {}) });
        const { transactions, failures } = this.splitPage(page);
        for (const failure of failures) errors.push(`Bank transaction ${failure.id} deferred: ${failure.errorClass}`);
        const result = await this.evidence.importPage({ expectedCursor: cursor, cursor: page.cursor, transactions, failures, scanComplete: !page.nextCursor });
        if (result.stale || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
    } catch (error) {
      // A failed page leaves the stored cursor where it was. Notices, observations and
      // posting for everything already imported still run in this tick.
      errors.push(`Bank transaction polling failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async retryFailed(work: EvidenceWork, errors: string[]) {
    const now = this.now();
    for (const retry of work.retries.filter(item => item.nextAttemptAt <= now).slice(0, 20)) {
      try {
        const transaction = this.validateTransaction(await this.bank.getTransaction(this.scope, retry.transactionId), retry.transactionId);
        await this.evidence.importTransactions({ transactions: [transaction], failures: [] });
      } catch (error) {
        const failure: BankItemFailure = error instanceof BankProviderError
          ? { id: retry.transactionId, errorClass: error.errorClass, error: error.message.slice(0, 300), ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) }
          : { id: retry.transactionId, errorClass: "unknown", error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
        errors.push(`Bank transaction ${retry.transactionId} deferred: ${failure.errorClass}`);
        try { await this.evidence.importTransactions({ transactions: [], failures: [failure] }); }
        catch (recordError) { errors.push(recordError instanceof Error ? recordError.message : String(recordError)); }
      }
    }
  }
  async tick() {
    let work = await this.evidence.work();
    const errors: string[] = [];
    await this.poll(work, errors);
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
    await this.retryFailed(await this.evidence.work(), errors);
    work = await this.evidence.work();
    const transferIds =new Set([...work.commands.map(c => c.providerTransferId!), ...work.transactions.map(t => t.transaction.transferId)].filter(Boolean));
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
