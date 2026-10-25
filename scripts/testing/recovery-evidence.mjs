import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = value => {
  assert.equal(typeof value, 'string');
  assert.ok(value.length > 0);
  return createHash('sha256').update(value).digest('hex');
};

// Fail closed on missing evidence. Return only counts, booleans and hashes;
// never spread provider responses, database rows, keys, or errors into artifacts.
export function recoveryEvidence(report, journal, tables) {
  assert.equal(report.profile, 'local');
  assert.equal(report.status, 'passed');
  assert.equal(report.identityMode, 'local_admin_simulated_human');
  assert.equal(report.scope.provider, 'fake');
  assert.equal(report.scope.environment, 'local');
  assert.deepEqual(report.faultSchedule, ['accept_then_lost_response', 'worker_exit', 'missing_webhook']);
  const interruption = report.processRecovery;
  assert.equal(interruption.signal, 'SIGKILL');
  assert.equal(interruption.exitCode, null);
  assert.equal(interruption.acceptedBeforeKill, true);
  assert.equal(interruption.completionAbsentBeforeKill, true);
  assert.equal(interruption.unpaidBeforeSettlement, true);
  assert.match(interruption.frozenCommandSha256, /^[a-f0-9]{64}$/);
  assert.equal(interruption.acceptedCommandSha256, interruption.frozenCommandSha256);
  assert.equal(interruption.lookupCommandSha256, interruption.frozenCommandSha256);
  assert.equal(report.review.commands.length, 1);
  const row = report.review.commands[0];
  const command = row.command;
  assert.equal(row._id, report.commandId);
  assert.equal(row.attemptCount, 2);
  assert.equal(row.execution, 'settled');
  assert.equal(row.posting, 'posted');
  assert.equal(row.reconciliation, 'matched');
  // Two bank create calls: the original POST whose response was lost, and the coordinator's
  // exact same-key replay of it. The restarted dispatcher itself must not submit at all.
  assert.equal(report.bankEvidence.calls.createTransfer, 2, 'Expected the lost POST plus exactly one same-key replay');
  assert.equal(interruption.restartCreateTransferCalls, 0, 'Restarted dispatcher must recover by lookup, not by submitting');
  assert.ok(Number.isSafeInteger(report.bankEvidence.calls.lookupTransfer) && report.bankEvidence.calls.lookupTransfer >= 1,
    'Restart must look up the original operation before considering another submission');
  assert.equal(report.bankEvidence.transfers.length, 1, 'The bank must hold exactly one transfer');
  const transfer = report.bankEvidence.transfers[0];
  assert.equal(transfer.commandId, command.commandId);
  assert.equal(transfer.idempotencyKey, command.idempotencyKey);
  assert.equal(transfer.requestHash, command.requestHash);
  assert.deepEqual(transfer.scope, report.scope);
  assert.deepEqual(command.scope, report.scope);
  assert.equal(report.bankEvidence.transfers.filter(t => t.idempotencyKey === command.idempotencyKey).length, 1,
    'Exactly one bank transfer may exist for the idempotency key');
  // #77: idempotent retry is the core defence against double payment. Every path back to the
  // transfer must return the ORIGINAL one created by the lost call.
  assert.equal(interruption.originalTransferId, transfer.id);
  assert.equal(interruption.replay?.errorClass, null, 'Same-key retry after a lost response must not error (UNIQUE or idempotency conflict)');
  assert.equal(interruption.replay?.transferId, transfer.id, 'Same-key retry after a lost response must return the original transfer');
  assert.equal(interruption.recoveredTransferId, transfer.id, 'Restarted dispatcher must recover the original transfer');
  assert.equal(interruption.recordedTransferId, transfer.id, 'Convex must record the original transfer on the command');
  assert.equal(row.providerTransferId, transfer.id, 'Final command must reference the original transfer');
  // Missing-webhook proof: the bank generated notifications, all were dropped, nothing was
  // ingested, and the polling cursor completed a scan for this run.
  assert.ok(report.bankEvidence.notifications?.generated >= 1, 'The bank must have generated notifications to drop');
  assert.equal(report.bankEvidence.notifications.delivered, 0, 'Notifications must be dropped, not delivered');
  assert.ok(Array.isArray(tables?.inbox) && Array.isArray(tables?.cursors), 'Inbox and cursor tables are required evidence');
  assert.equal(tables.inbox.length, 0, 'No webhook may be ingested in the missing-webhook scenario');
  assert.equal(tables.cursors.length, 1, 'Polling must persist exactly one cursor');
  assert.equal(tables.cursors[0].scope?.runId, report.scope.runId);
  assert.ok(Number.isSafeInteger(tables.cursors[0].scanCompletedAt), 'Polling must complete a transaction scan');
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
    attempts: 2, createTransferCalls: 2, restartCreateTransferCalls: 0, lookupTransferCalls: report.bankEvidence.calls.lookupTransfer,
    transfers: 1, postedDebits: 1,
    cashJournalEntries: 1, closeBlockers: 0, amountCents: command.amountCents,
    sameCommandAndKey: true, acceptedTransferRecoveredWithoutResend: true, missingWebhookRecoveredByPolling: true,
    sameKeyReplayReturnedOriginalTransfer: true, recordedTransferIsOriginal: true,
    droppedNotifications: report.bankEvidence.notifications.generated, ingestedNotifications: 0,
    interruption: { signal: 'SIGKILL', acceptedBeforeKill: true, completionAbsentBeforeKill: true,
      unpaidBeforeSettlement: true, frozenCommandSha256: interruption.frozenCommandSha256 },
    duplicateReconciliationPostedNothing: true, // ap-demo asserts a second tick posts zero.
    commandSha256: hash(command.commandId), idempotencyKeySha256: hash(command.idempotencyKey),
    transferSha256: hash(transfer.id), replayTransferSha256: hash(interruption.replay.transferId),
    requestHashSha256: hash(command.requestHash), transactionSha256: hash(debit.id),
    journalEntrySha256: hash(entry._id), fixtureHashSha256: hash(report.fixtureHash),
  };
}
