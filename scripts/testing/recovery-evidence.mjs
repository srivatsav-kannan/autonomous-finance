import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = value => {
  assert.equal(typeof value, 'string');
  assert.ok(value.length > 0);
  return createHash('sha256').update(value).digest('hex');
};

// Fail closed on missing evidence. Return only counts, booleans and hashes;
// never spread provider responses, database rows, keys, or errors into artifacts.
export function recoveryEvidence(report, journal) {
  assert.equal(report.profile, 'local');
  assert.equal(report.status, 'passed');
  assert.equal(report.identityMode, 'local_admin_simulated_human');
  assert.equal(report.scope.provider, 'fake');
  assert.equal(report.scope.environment, 'local');
  assert.deepEqual(report.faultSchedule, ['accept_then_lost_response', 'worker_exit', 'missing_webhook']);
  assert.equal(report.review.commands.length, 1);
  const row = report.review.commands[0];
  const command = row.command;
  assert.equal(row._id, report.commandId);
  assert.equal(row.attemptCount, 2);
  assert.equal(row.execution, 'settled');
  assert.equal(row.posting, 'posted');
  assert.equal(row.reconciliation, 'matched');
  assert.equal(report.bankEvidence.calls.createTransfer, 2);
  assert.equal(report.bankEvidence.transfers.length, 1);
  const transfer = report.bankEvidence.transfers[0];
  assert.equal(transfer.commandId, command.commandId);
  assert.equal(transfer.idempotencyKey, command.idempotencyKey);
  assert.equal(transfer.requestHash, command.requestHash);
  assert.deepEqual(transfer.scope, report.scope);
  assert.deepEqual(command.scope, report.scope);
  const debits = report.bankEvidence.transactions.filter(t => t.status === 'posted' && t.purpose === 'debit');
  assert.equal(debits.length, 1);
  const debit = debits[0];
  assert.equal(debit.transferId, transfer.id);
  assert.equal(debit.commandId, command.commandId);
  assert.equal(debit.amountCents, -command.amountCents);
  assert.equal(report.evidence.transactions.length, 1);
  const posted = report.evidence.transactions[0];
  assert.equal(posted.transaction.id, debit.id);
  assert.equal(posted.state, 'posted');
  assert.equal(report.evidence.blockers.length, 0);
  // Query the actual fresh backend's journal, not just its linked evidence row.
  assert.ok(journal.every(entry => entry.runId === report.scope.runId));
  const cashEntries = journal.filter(entry => entry.lines.some(line => line.account === '1000'));
  assert.equal(cashEntries.length, 1);
  const entry = cashEntries[0];
  assert.equal(entry._id, posted.entryId);
  assert.equal(entry.source.kind, 'payment_settlement');
  const cash = entry.lines.filter(line => line.account === '1000');
  assert.equal(cash.length, 1);
  assert.equal(cash[0].credit, command.amountCents);
  assert.equal(cash[0].debit, 0);
  assert.ok(Number.isSafeInteger(command.amountCents) && command.amountCents > 0);
  return {
    identityMode: 'local_admin_simulated_human',
    attempts: 2, createTransferCalls: 2, transfers: 1, postedDebits: 1,
    cashJournalEntries: 1, closeBlockers: 0, amountCents: command.amountCents,
    sameCommandAndKey: true, missingWebhookRecoveredByPolling: true,
    duplicateReconciliationPostedNothing: true, // ap-demo asserts a second tick posts zero.
    commandSha256: hash(command.commandId), idempotencyKeySha256: hash(command.idempotencyKey),
    requestHashSha256: hash(command.requestHash), transactionSha256: hash(debit.id),
    journalEntrySha256: hash(entry._id), fixtureHashSha256: hash(report.fixtureHash),
  };
}
