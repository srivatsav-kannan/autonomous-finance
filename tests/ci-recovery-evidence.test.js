import { describe, expect, it } from 'vitest';
import { recoveryEvidence } from '../scripts/testing/recovery-evidence.mjs';

function fixture() {
  const scope = { provider: 'fake', environment: 'local', runId: 'fixture' };
  const command = { scope, commandId: 'command', idempotencyKey: 'private-key-canary', requestHash: 'request', amountCents: 66290 };
  const debit = { id: 'debit', commandId: 'command', transferId: 'transfer', amountCents: -66290, status: 'posted', purpose: 'debit' };
  return {
    report: {
      profile: 'local', status: 'passed', identityMode: 'local_admin_simulated_human', scope,
      faultSchedule: ['accept_then_lost_response', 'worker_exit', 'missing_webhook'],
      commandId: 'row', fixtureHash: 'fixture',
      review: { commands: [{ _id: 'row', command, attemptCount: 2, execution: 'settled', posting: 'posted', reconciliation: 'matched' }] },
      bankEvidence: { calls: { createTransfer: 1, lookupTransfer: 1 }, transfers: [{ ...command, id: 'transfer' }], transactions: [debit] },
      evidence: { transactions: [{ transaction: debit, state: 'posted', entryId: 'journal' }], blockers: [] },
    },
    journal: [{ _id: 'journal', runId: 'fixture', source: { kind: 'payment_settlement' }, lines: [{ account: '1000', debit: 0, credit: 66290 }] }],
  };
}

describe('CI recovery evidence boundary', () => {
  it('exports only verified counts and hashes, even when raw evidence contains credentials', () => {
    const { report, journal } = fixture();
    report.secret = 'admin-secret-canary';
    report.review.commands[0].leaseToken = 'lease-token-canary';
    report.bankEvidence.transfers[0].payload = 'provider-payload-canary';
    journal[0].memo = 'raw-memo-canary';
    const result = recoveryEvidence(report, journal);
    expect(result).toMatchObject({ attempts: 2, createTransferCalls: 1, lookupTransferCalls: 1, acceptedTransferRecoveredWithoutResend: true,
      transfers: 1, postedDebits: 1, cashJournalEntries: 1, amountCents: 66290 });
    expect(result.idempotencyKeySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('canary');
  });
  it.each([
    ['a changed retry key', ({ report }) => { report.bankEvidence.transfers[0].idempotencyKey = 'different'; }],
    ['missing crash recovery', ({ report }) => { report.review.commands[0].attemptCount = 1; }],
    ['a blind recovery resend', ({ report }) => { report.bankEvidence.calls.createTransfer = 2; }],
    ['missing recovery lookup', ({ report }) => { report.bankEvidence.calls.lookupTransfer = 0; }],
    ['a second debit', ({ report }) => { report.bankEvidence.transactions.push(report.bankEvidence.transactions[0]); }],
    ['a second cash effect', ({ journal }) => { journal.push(journal[0]); }],
    ['an unlinked cash effect', ({ journal }) => { journal[0]._id = 'different'; }],
    ['an incorrect cash amount', ({ journal }) => { journal[0].lines[0].credit = 1; }],
    ['a claimed sandbox result', ({ report }) => { report.profile = 'sandbox'; }],
    ['unfinished close blockers', ({ report }) => { report.evidence.blockers.push({}); }],
    ['a missing report', data => { data.report = {}; }],
  ])('rejects %s', (_description, change) => {
    const data = fixture(); change(data);
    expect(() => recoveryEvidence(data.report, data.journal)).toThrow();
  });
});
