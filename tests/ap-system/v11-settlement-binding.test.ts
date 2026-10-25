import {createHash} from 'node:crypto';
import {beforeEach, afterEach, expect, it, vi} from 'vitest';
import {api} from '../demo-fixture';
import {banks, settlementFixture} from './v11-settlement-fixture';
import {commandRequestHash, buildIncreaseRequestBody} from '../../src/payments/contracts';
import {canonicalJson} from '../../src/integrations/contracts';
import {creditFixture} from './quickbooks-business-fixture';
import {br} from './business-fixture';
import {makeFunctionReference} from 'convex/server';
const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));});
afterEach(() => {for (const bank of banks.splice(0)) bank.close(); vi.useRealTimers(); vi.unstubAllEnvs();});

it.each(['ops', null])('freezes %s authority in exact snapshot/command hashes and preserves partial cash/credit arithmetic through real FakeBank settlement and return', async department => {
  const f = await settlementFixture(true, department), initial = await f.state(), v = initial.versions[0]!, command = initial.commands[0]!;
  const binding = v.snapshot.accountingBinding!;
  expect(binding.department).toBe(department); expect(binding.bills.map(b => [b.billId, b.appliedCents])).toEqual([[f.original.billId, 3000]]); expect(binding.credits.map(c => [c.creditId, c.appliedCents])).toEqual([[f.credit.creditId, 1000]]);
  expect(v.snapshotHash).toBe(digest(v.snapshot)); expect(command.command.accountingBindingHash).toBe(digest(binding)); expect(command.command.requestHash).toBe(await commandRequestHash(command.command));
  expect(JSON.parse(buildIncreaseRequestBody(command.command))).not.toHaveProperty('accountingBindingHash');
  expect(await f.t.mutation(api.demoPayments.requestPayment, f.args)).toEqual(f.request); expect((await f.state()).versions).toHaveLength(1);
  const sent = await f.dispatch.tick(); expect(sent.error).toBeUndefined(); expect(sent.providerTransferId).toBeTruthy();
  f.bank.harness.settle(sent.providerTransferId!); expect((await f.reconcile.tick()).errors).toEqual([]);
  const settled = await f.state(); expect(settled.bills[0]!.paidCents).toBe(3000); expect(settled.credits[0]!.consumedCents).toBe(1000);
  f.bank.harness.returnTransfer(sent.providerTransferId!); expect((await f.reconcile.tick()).errors).toEqual([]);
  const returned = await f.state(), posts = returned.journals.filter(j => j.source.kind === 'payment_settlement');
  expect(posts).toHaveLength(2); expect(posts.map(j => j.lines.map(l => [l.account, l.debit, l.credit, l.dims?.department ?? null]))).toEqual([[['2000', 2000, 0, department], ['1000', 0, 2000, department]], [['1000', 2000, 0, department], ['2000', 0, 2000, department]]]);
  expect(returned.bills[0]!.paidCents).toBe(1000); expect(returned.credits[0]!.consumedCents).toBe(1000); expect(returned.credits[0]!.reservedCents).toBe(0);
  expect((await f.reconcile.tick()).posted).toBe(0); expect((await f.state()).journals).toEqual(returned.journals); expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
});

it.each(['human', 'policy'])('blocks a first send after current %s retirement without changing the original binding or submitting to the bank', async retirement => {
  const f = await settlementFixture(), before = await f.state();
  await f.t.run(async ctx => {if (retirement === 'human') {const seat = (await ctx.db.query('seats').collect()).find(s => s.seatId === 'human-finance')!; await ctx.db.patch(seat._id, {status: 'retired'});} else {const policy = await ctx.db.query('apBusinessPolicies').first(); await ctx.db.patch(policy!._id, {status: 'superseded'});}});
  expect(await f.dispatch.tick()).toEqual({dispatched: false});
  const after = await f.state(); expect(after.attempts).toHaveLength(0); expect(after.commands[0]!.attemptCount).toBe(0); expect(after.commands[0]!.command).toEqual(before.commands[0]!.command); expect(after.versions[0]!.snapshot).toEqual(before.versions[0]!.snapshot); expect(f.bank.harness.inspect().transfers).toHaveLength(0);
});

it.each(['department', 'credit amount', 'recognition journal'])('rejects a rehashed forged %s binding during human authorization', async change => {
  const f = await settlementFixture(false);
  const version = (await f.state()).versions[0]!, snapshot = structuredClone(version.snapshot);
  if (change === 'department') snapshot.accountingBinding!.department = 'sales';
  if (change === 'credit amount') snapshot.accountingBinding!.credits[0]!.appliedCents++;
  if (change === 'recognition journal') snapshot.accountingBinding!.bills[0]!.recognitionEntryId = snapshot.accountingBinding!.credits[0]!.recognitionEntryId;
  const snapshotHash = digest(snapshot);
  await f.t.run(ctx => ctx.db.patch(version._id, {snapshot, snapshotHash}));
  await expect(f.humans.finance!.mutation(api.demoPayments.approveAndQueue, {scope: f.scope, versionId: version._id, snapshotHash})).rejects.toThrow();
  const state = await f.state(); expect(state.commands).toHaveLength(0); expect(state.attempts).toHaveLength(0); expect(f.bank.harness.inspect().transfers).toHaveLength(0);
});

it('recovers an accepted lost response and settles the frozen department after both current policy and approving human retire', async () => {
  const f = await settlementFixture(); f.bank.harness.scheduleFault({operation: 'createTransfer', call: 1, kind: 'accept_then_lost_response'});
  expect((await f.dispatch.tick()).error).toBe('transport'); const before = await f.state(), first = before.commands[0]!;
  expect(f.bank.harness.inspect().transfers).toHaveLength(1); expect(before.bills[0]!.reservedVersionId).toBe(f.request.versionId); expect(before.credits[0]!.reservedCents).toBe(1000);
  await f.t.run(async ctx => {const p = await ctx.db.query('apBusinessPolicies').first(); await ctx.db.patch(p!._id, {status: 'superseded'}); const s = (await ctx.db.query('seats').collect()).find(s => s.seatId === 'human-finance')!; await ctx.db.patch(s._id, {status: 'retired'});});
  vi.setSystemTime(first.nextAttemptAt); const recovered = await f.dispatch.tick(); expect(recovered.error).toBeUndefined(); expect(recovered.providerTransferId).toBe(f.bank.harness.inspect().transfers[0]!.id);
  expect((await f.state()).commands[0]!.command).toEqual(first.command); expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
  f.bank.harness.settle(recovered.providerTransferId!); expect((await f.reconcile.tick()).errors).toEqual([]);
  const rows = await f.state(); expect(rows.journals.filter(j => j.source.kind === 'payment_settlement')[0]!.lines.every(l => l.dims?.department === 'ops')).toBe(true); expect(rows.bills[0]!.paidCents).toBe(3000); expect(rows.credits[0]!.consumedCents).toBe(1000);
});

it('rejects a changed command binding during possible-send recovery even with a valid new request hash', async () => {
  const f = await settlementFixture(); f.bank.harness.scheduleFault({operation: 'createTransfer', call: 1, kind: 'accept_then_lost_response'}); await f.dispatch.tick();
  const before = await f.state(), row = before.commands[0]!, command = {...row.command, accountingBindingHash: 'f'.repeat(64)}; command.requestHash = await commandRequestHash(command);
  await f.t.run(ctx => ctx.db.patch(row._id, {command})); vi.setSystemTime(row.nextAttemptAt);
  await expect(f.dispatch.tick()).rejects.toThrow(/command_accounting_binding_mismatch/); const after = await f.state(); expect(after.commands[0]!.attemptCount).toBe(1); expect(after.bills[0]!.reservedVersionId).toBe(f.request.versionId); expect(after.credits[0]!.reservedCents).toBe(1000); expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
});

it('requires the original settlement account and department before posting a verified bank return', async () => {
  const f = await settlementFixture(), sent = await f.dispatch.tick(); f.bank.harness.settle(sent.providerTransferId!); await f.reconcile.tick();
  const original = (await f.state()).journals.find(j => j.source.kind === 'payment_settlement')!;
  f.bank.harness.returnTransfer(sent.providerTransferId!);
  await f.t.run(ctx => ctx.db.patch(original._id, {lines: original.lines.map(l => ({...l, dims: {...l.dims, department: 'sales'}}))}));
  expect((await f.reconcile.tick()).errors.some(e => e.includes('return_original_accounting_mismatch'))).toBe(true); expect((await f.state()).journals.filter(j => j.source.kind === 'payment_settlement')).toHaveLength(1); expect((await f.state()).bills[0]!.paidCents).toBe(3000);
  await f.t.run(ctx => ctx.db.patch(original._id, {lines: original.lines})); expect((await f.reconcile.tick()).errors).toEqual([]); expect((await f.state()).bills[0]!.paidCents).toBe(1000); expect((await f.state()).journals.filter(j => j.source.kind === 'payment_settlement')).toHaveLength(2);
});

it('stores one exact zero-cash binding on every group member and rejects a partial changed member during grouped read', async () => {
  const f = await creditFixture(0, {department: 'ops', scope: 'cost_and_settlement'}), a = await f.credit('V11-credit-a'), b = await f.credit('V11-credit-b'), d = (await f.load()).detail;
  const args = {scope: f.scope, caseId: d.caseId, expectedRevision: d.revision, snapshotHash: d.snapshotHash, billVersion: d.links.billVersion!, idempotencyKey: 'v11-zero-cash', reason: 'Independent grouped application', credits: [{creditId: a.creditId, amountCents: 500}, {creditId: b.creditId, amountCents: 600}]};
  const applied = await f.humans.finance!.mutation(br.applyCredits!, args); expect(applied).toMatchObject({appliedCents: 1100, cashCents: 0}); expect(await f.humans.finance!.mutation(br.applyCredits!, args)).toEqual(applied);
  const state = await f.t.run(async ctx => ({rows: await ctx.db.query('apCreditApplications').collect(), commands: await ctx.db.query('demoCommands').collect(), versions: await ctx.db.query('demoVersions').collect(), journals: await ctx.db.query('journalEntries').collect()}));
  expect(state.rows).toHaveLength(2); expect(state.commands).toEqual([]); expect(state.versions).toEqual([]); expect(state.journals).toHaveLength(3);
  expect(state.rows[0]!.accountingBinding).toEqual(state.rows[1]!.accountingBinding); expect(state.rows[0]!.accountingBinding!.bills[0]!.appliedCents).toBe(1100); expect(state.rows[0]!.accountingBinding!.credits.map(c => c.appliedCents).sort()).toEqual([500, 600]);
  const read = makeFunctionReference<'query'>('apAccountingCorrections:creditApplication'), input = {scope: f.scope, caseId: d.caseId, creditApplicationId: state.rows[0]!._id};
  expect((await f.humans.finance!.query(read, input)).amountCents).toBe(1100);
  const wrong = structuredClone(state.rows[1]!.accountingBinding!); wrong.department = 'sales'; await f.t.run(ctx => ctx.db.patch(state.rows[1]!._id, {accountingBinding: wrong}));
  await expect(f.humans.finance!.query(read, input)).rejects.toThrow(/application_accounting_binding_mismatch/);
});


it('applies one governed credit without cash, retains its binding and refuses a stripped binding on authoritative read', async () => {
  const f = await creditFixture(0, {department: 'ops', scope: 'cost_and_settlement'}), credit = await f.credit('V11-one-credit'), d = (await f.load()).detail;
  const args = {scope: f.scope, caseId: d.caseId, expectedRevision: d.revision, snapshotHash: d.snapshotHash, billVersion: d.links.billVersion!, idempotencyKey: 'v11-single-zero-cash', reason: 'Independent no-cash application', credits: [{creditId: credit.creditId, amountCents: 1100}]};
  expect(await f.humans.finance!.mutation(br.applyCredits!, args)).toMatchObject({appliedCents: 1100, cashCents: 0});
  const rows = await f.t.run(ctx => ctx.db.query('apCreditApplications').collect()); expect(rows).toHaveLength(1);
  expect(rows[0]!.accountingBinding).toMatchObject({department: 'ops', bills: [{billId: f.original.billId, appliedCents: 1100}], credits: [{creditId: credit.creditId, appliedCents: 1100}]});
  const read = makeFunctionReference<'query'>('apAccountingCorrections:creditApplication'), input = {scope: f.scope, caseId: d.caseId, creditApplicationId: rows[0]!._id};
  expect((await f.humans.finance!.query(read, input)).amountCents).toBe(1100);
  await f.t.run(ctx => ctx.db.patch(rows[0]!._id, {accountingBinding: undefined}));
  await expect(f.humans.finance!.query(read, input)).rejects.toThrow(/accounting_binding_authority_changed/);
  expect(await f.t.run(ctx => ctx.db.query('demoCommands').collect())).toHaveLength(0);
});
