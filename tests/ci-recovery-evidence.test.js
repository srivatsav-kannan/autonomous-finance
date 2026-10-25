import { describe, expect, it, vi } from 'vitest';
import { recoveryEvidence } from '../scripts/testing/recovery-evidence.mjs';
import { diagnosticCollector, waitForRequiredStep } from '../scripts/testing/ci-report.mjs';

function fixture() {
  const scope = { provider: 'fake', environment: 'local', runId: 'fixture' };
  const command = { scope, commandId: 'command', idempotencyKey: 'private-key-canary', requestHash: 'request', amountCents: 66290 };
  const debit = { id: 'debit', commandId: 'command', transferId: 'transfer', amountCents: -66290, status: 'posted', purpose: 'debit' };
  return {
    report: {
      profile: 'local', status: 'passed', identityMode: 'local_admin_simulated_human', scope,
      faultSchedule: ['accept_then_lost_response', 'worker_exit', 'missing_webhook'],
      processRecovery: { signal: 'SIGKILL', exitCode: null, acceptedBeforeKill: true, completionAbsentBeforeKill: true,
        unpaidBeforeSettlement: true, frozenCommandSha256: 'a'.repeat(64), acceptedCommandSha256: 'a'.repeat(64), lookupCommandSha256: 'a'.repeat(64),
        recoveredTransferId: 'transfer', restartCreateTransferCalls: 0, recordedTransferId: 'transfer', originalTransferId: 'transfer',
        replay: { transferId: 'transfer', errorClass: null } },
      commandId: 'row', fixtureHash: 'fixture',
      review: { commands: [{ _id: 'row', command, attemptCount: 2, execution: 'settled', posting: 'posted', reconciliation: 'matched', providerTransferId: 'transfer' }] },
      bankEvidence: { calls: { createTransfer: 2, lookupTransfer: 1 }, transfers: [{ ...command, id: 'transfer' }], transactions: [debit],
        notifications: { generated: 2, delivered: 0 } },
      evidence: { transactions: [{ transaction: debit, state: 'posted', entryId: 'journal' }], blockers: [] },
    },
    journal: [{ _id: 'journal', runId: 'fixture', source: { kind: 'payment_settlement' }, lines: [{ account: '1000', debit: 0, credit: 66290 }] }],
    tables: { inbox: [], cursors: [{ scope, cursor: 'transactions:binding:2', updatedAt: 2, scanCompletedAt: 2 }] },
  };
}
const verify = data => recoveryEvidence(data.report, data.journal, data.tables);

describe('CI recovery evidence boundary', () => {
  it('exports only verified counts and hashes, even when raw evidence contains credentials', () => {
    const data = fixture();
    const { report, journal } = data;
    report.secret = 'admin-secret-canary';
    report.review.commands[0].leaseToken = 'lease-token-canary';
    report.bankEvidence.transfers[0].payload = 'provider-payload-canary';
    journal[0].memo = 'raw-memo-canary';
    const result = verify(data);
    expect(result).toMatchObject({ attempts: 2, createTransferCalls: 2, restartCreateTransferCalls: 0, lookupTransferCalls: 1, acceptedTransferRecoveredWithoutResend: true,
      sameKeyReplayReturnedOriginalTransfer: true, recordedTransferIsOriginal: true, droppedNotifications: 2, ingestedNotifications: 0,
      transfers: 1, postedDebits: 1, cashJournalEntries: 1, amountCents: 66290 });
    expect(result.idempotencyKeySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('canary');
  });
  it.each([
    ['a changed retry key', ({ report }) => { report.bankEvidence.transfers[0].idempotencyKey = 'different'; }],
    ['missing crash recovery', ({ report }) => { report.review.commands[0].attemptCount = 1; }],
    ['a blind recovery resend', ({ report }) => { report.processRecovery.restartCreateTransferCalls = 1; }],
    ['an extra bank create call', ({ report }) => { report.bankEvidence.calls.createTransfer = 3; }],
    ['a missing same-key replay', ({ report }) => { report.bankEvidence.calls.createTransfer = 1; }],
    // #77: with FakeBank's replay branch disabled, the retry hits the UNIQUE key and returns nothing.
    ['a same-key retry that errored', ({ report }) => { report.processRecovery.replay = { transferId: null, errorClass: 'ERR_SQLITE_ERROR' }; }],
    ['a same-key retry that returned a different transfer', ({ report }) => { report.processRecovery.replay.transferId = 'transfer-2'; }],
    ['a restart that recovered a different transfer', ({ report }) => { report.processRecovery.recoveredTransferId = 'transfer-2'; }],
    ['a command recording a different transfer', ({ report }) => { report.review.commands[0].providerTransferId = 'transfer-2'; }],
    ['a second transfer for the key', ({ report }) => { report.bankEvidence.transfers.push({ ...report.bankEvidence.transfers[0], id: 'transfer-2' }); }],
    ['an ingested webhook', ({ tables }) => { tables.inbox.push({ eventId: 'event' }); }],
    ['no completed polling scan', ({ tables }) => { delete tables.cursors[0].scanCompletedAt; }],
    ['a missing polling cursor', ({ tables }) => { tables.cursors = []; }],
    ['undropped notifications', ({ report }) => { report.bankEvidence.notifications.delivered = 1; }],
    ['missing table evidence', data => { delete data.tables; }],
    ['missing recovery lookup', ({ report }) => { report.bankEvidence.calls.lookupTransfer = 0; }],
    ['a graceful exit instead of SIGKILL', ({ report }) => { report.processRecovery.signal = null; report.processRecovery.exitCode = 86; }],
    ['missing before-record checkpoint', ({ report }) => { report.processRecovery.completionAbsentBeforeKill = false; }],
    ['a changed frozen instruction', ({ report }) => { report.processRecovery.lookupCommandSha256 = 'b'.repeat(64); }],
    ['a not-run recovery check', ({ report }) => { report.status = 'not_run'; }],
    ['a second debit', ({ report }) => { report.bankEvidence.transactions.push(report.bankEvidence.transactions[0]); }],
    ['a second cash effect', ({ journal }) => { journal.push(journal[0]); }],
    ['an unlinked cash effect', ({ journal }) => { journal[0]._id = 'different'; }],
    ['an incorrect cash amount', ({ journal }) => { journal[0].lines[0].credit = 1; }],
    ['a claimed sandbox result', ({ report }) => { report.profile = 'sandbox'; }],
    ['unfinished close blockers', ({ report }) => { report.evidence.blockers.push({}); }],
    ['a missing report', data => { data.report = {}; }],
  ])('rejects %s', (_description, change) => {
    const data = fixture(); change(data);
    expect(() => verify(data)).toThrow();
  });
  it('names the broken idempotent retry in a fixed message without leaking values', () => {
    const data = fixture();
    data.report.processRecovery.replay = { transferId: null, errorClass: 'ERR_SQLITE_ERROR' };
    const error = (() => { try { verify(data); } catch (e) { return e; } })();
    expect(error).toMatchObject({ code: 'ERR_ASSERTION', generatedMessage: false });
    expect(error.message.split('\n')[0]).toBe('Same-key retry after a lost response must not error (UNIQUE or idempotency conflict)');
    expect(error.message.split('\n')[0]).not.toContain('ERR_SQLITE_ERROR'); // The runner keeps only this first line.
  });
});

describe('CI failure diagnostic boundary', () => {
  it('retains useful known build categories and source locations without raw credentials', () => {
    const diagnostics = diagnosticCollector(['convex/lib/payments/applyCommand.ts', 'scripts/ap-demo.ts']);
    diagnostics.consume('Authorization: Bearer ADMIN_CANARY\nproviderBody={"token":"BANK_CANARY"}\n');
    diagnostics.consume('\u001b[31mError: Invalid module path convex/lib/payments/applyCommand.ts:12:5 JWT_CANARY\u001b[0m\n');
    diagnostics.consume('Could not res');
    diagnostics.consume('olve "scripts/ap-demo.ts" SECRET_CANARY\n');
    diagnostics.consume('Error: cannot find module /private/credential-canary.ts\n');
    const result = diagnostics.snapshot();
    expect(result.events).toContainEqual({ code: 'INVALID_MODULE_PATH', file: 'convex/lib/payments/applyCommand.ts', line: 12, column: 5 });
    expect(result.events).toContainEqual({ code: 'MODULE_NOT_FOUND', file: 'scripts/ap-demo.ts' });
    expect(JSON.stringify(result)).not.toMatch(/CANARY|credential-canary|Authorization|Bearer|providerBody/);
    expect(result.rawOutputRetained).toBe(false);
  });
  it('classifies a same-key retry hitting the bank unique key as an idempotency conflict without raw text', () => {
    const diagnostics = diagnosticCollector(['scripts/ap-demo.ts']);
    diagnostics.consume('Error: UNIQUE constraint failed: transfers.idem KEY_CANARY\n');
    const result = diagnostics.snapshot();
    expect(result.events).toContainEqual({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });
  it('bounds diagnostic input, event count and output size under noisy failures', () => {
    const diagnostics = diagnosticCollector(['scripts/ap-demo.ts']);
    diagnostics.consume(Array.from({ length: 100 }, (_, i) => `AssertionError scripts/ap-demo.ts:${i + 1}:1\n`).join(''));
    diagnostics.consume('SECRET_CANARY'.repeat(100_000));
    const result = diagnostics.snapshot();
    expect(result.events.length).toBeLessThanOrEqual(32);
    expect(result.scannedBytes).toBeLessThanOrEqual(256 * 1024);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(10_000);
    expect(JSON.stringify(result)).not.toContain('SECRET_CANARY');
  });
  it('rejects failed, signalled and incomplete required processes', async () => {
    const signal = new AbortController().signal;
    const base = { failed: false, child: { exitCode: null, signalCode: null } };
    await expect(waitForRequiredStep(() => false, { ...base, failed: true }, 100, signal)).rejects.toThrow();
    await expect(waitForRequiredStep(() => true, { ...base, child: { exitCode: null, signalCode: 'SIGKILL' } }, 100, signal)).rejects.toThrow();
    await expect(waitForRequiredStep(() => true, { ...base, child: { exitCode: 1, signalCode: null } }, 100, signal)).rejects.toThrow();
    await expect(waitForRequiredStep(() => false, { ...base, child: { exitCode: 0, signalCode: null } }, 100, signal)).rejects.toThrow();
  });
  it('rejects cancellation and a success that arrives after the deadline', async () => {
    const state = { failed: false, child: { exitCode: 0, signalCode: null } };
    const cancelled = new AbortController(); cancelled.abort();
    await expect(waitForRequiredStep(() => true, state, 100, cancelled.signal)).rejects.toMatchObject({ code: 'RECOVERY_ABORTED' });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      await expect(waitForRequiredStep(async () => { now.mockReturnValue(1200); return true; }, state, 100, new AbortController().signal)).rejects.toMatchObject({ code: 'RECOVERY_TIMEOUT' });
    } finally { now.mockRestore(); }
  });
});
