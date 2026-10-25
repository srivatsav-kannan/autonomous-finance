import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {Id} from '../../convex/_generated/dataModel';
import type {CostCorrection} from '../../src/ap-system/cost-contracts';
import {binding, cr, policy} from './business-fixture';
import {dimensionsFixture, coords, portions, dimensionMappings} from './v10-dimension-fixture';
import {closePlan} from '../../src/ap-system/quickbooks/close-sync';
import {successful} from './quickbooks-business-fixture';
beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T20:00:00Z'));});
afterEach(() => {vi.useRealTimers(); vi.unstubAllEnvs();});
const signed = (positions: {account: string; department?: string | null; project?: string | null; balanceCents: number}[]) => positions.filter(p => p.balanceCents).map(p => [p.account, p.department ?? null, p.project ?? null, p.balanceCents]).sort();

it('conserves a four-coordinate invoice through account correction and two exact half credits without borrowing another department or project path', async () => {
  const f = await dimensionsFixture();
  expect(signed((await f.cost()).positions)).toEqual(coords.map((c, i) => ['5000', c.department, c.project, portions[i]]).sort());
  const original = (await f.financial()).journals[0];
  await f.approveClose(f.adjustment(0, 2000));
  const state = await f.cost();
  const correction: CostCorrection = {snapshotHash: state.snapshotHash, reason: 'Half of each independently fixed original share', evidence: f.evidence,
    allocations: coords.map((c, i) => ({...c, store: 'sf-hayes-valley', originalLineId: 'line-1', allocationIndex: i, account: i === 0 ? '1200' : '5000', treatment: i === 0 ? 'inventory' as const : 'expense' as const, side: 'credit' as const, amountCents: portions[i]! / 2}))};
  // The same account/store has ample inventory in ops/alpha, but no path exists for ops/beta or sales/alpha.
  for (const index of [1, 2]) {
    const wrong = structuredClone(correction); wrong.allocations[index]!.account = '1200'; wrong.allocations[index]!.treatment = 'inventory';
    const before = await f.financial(); await expect(f.credit(wrong)).rejects.toThrow(/cost_correction_path/); expect(await f.financial()).toEqual(before);
  }
  const cross = structuredClone(correction); cross.allocations[0]!.project = 'beta';
  await expect(f.credit(cross)).rejects.toThrow(/cost_original_share/);
  const e = await f.credit(correction);
  expect(e.recognizedCredit!.allocations).toEqual(coords.map((c, i) => ({...c, store: 'sf-hayes-valley', account: i === 0 ? '1200' : '5000', amountCents: portions[i]! / 2})));
  expect(signed((await f.cost()).positions)).toEqual(coords.map((c, i) => [i === 0 ? '1200' : '5000', c.department, c.project, portions[i]! / 2]).sort());
  await expect(f.credit(correction)).rejects.toThrow(/stale_cost_snapshot/);
  await f.credit({...correction, snapshotHash: (await f.cost()).snapshotHash});
  expect(signed((await f.cost()).positions)).toEqual([]);
  expect((await f.financial()).journals.find(j => j._id === original!._id)).toEqual(original);
  expect((await f.exported()).recognizedInvoice!.allocations).toEqual(coords.map((c, i) => ({...c, store: 'sf-hayes-valley', account: '5000', amountCents: portions[i]})));
});

it('keeps multi-department accrual, correction and partial reversal exact through authoritative export and per-line QBO location mapping', async () => {
  const f = await dimensionsFixture({recognize: false, project: false});
  const accrued = await f.approveClose({kind: 'accrual', accrual: {supplierId: f.supplier.supplierId, source: binding(f.input.documents[2]!), lineId: 'receipt-line-1', sku: 'KALE-24', unit: 'case', description: 'Independent dimensional accrual', quantity: '2', capacityQuantity: '2', unitPriceCents: 3850, allocations: f.accepted.lines[0]!.allocations, date: '2026-10-31', expectedInvoiceCaseId: f.detail.caseId, quote: f.input.documents[2]!.extractedText, reason: 'Retained receiving obligation'}});
  await f.approveClose(f.adjustment(0, 2000, accrued.entryId));
  const correction: CostCorrection = {snapshotHash: (await f.cost(accrued.entryId)).snapshotHash, reason: 'Half each original accrued share', evidence: f.evidence,
    allocations: coords.map((c, i) => ({department: c.department, project: null, store: 'sf-hayes-valley', originalLineId: 'accrual', allocationIndex: i, account: i === 0 ? '1200' : '5000', treatment: i === 0 ? 'inventory' as const : 'expense' as const, side: 'credit' as const, amountCents: portions[i]! / 2}))};
  const reversed = await f.approveClose({kind: 'reverse_accrual', accrualId: accrued.accrualId, quantity: '1', date: '2026-10-31', reason: 'Independent half reversal', evidence: f.evidence, correction});
  const a = await f.closeExport(accrued.actionId), r = await f.closeExport(reversed.actionId);
  expect(r.accounting.journal.lines).toEqual([{account: '2010', debit: 3850, credit: 0, store: null, supplierId: f.supplier.supplierId}, ...coords.map((c, i) => ({account: i === 0 ? '1200' : '5000', debit: 0, credit: portions[i]! / 2, store: 'sf-hayes-valley', department: c.department, project: null, supplierId: f.supplier.supplierId}))]);
  const m = dimensionMappings(); delete m.dimensions!.projects;
  const ap = closePlan({...a, scope: f.scope}, {actionId: accrued.actionId}, m, null);
  const rp = closePlan({...r, scope: f.scope}, {actionId: reversed.actionId}, m, successful(ap, '900'));
  const lines = rp.payload.Line as any[];
  expect(lines[0].JournalEntryLineDetail).not.toHaveProperty('DepartmentRef');
  expect(lines[0].JournalEntryLineDetail).not.toHaveProperty('ClassRef');
  expect(lines.slice(1).map(l => [l.Amount, l.JournalEntryLineDetail.AccountRef.value, l.JournalEntryLineDetail.DepartmentRef.value, l.JournalEntryLineDetail.ClassRef.value])).toEqual([[10, '8', '10', '9'], [9, '7', '10', '9'], [8, '7', '20', '9'], [11.5, '7', '20', '9']]);
  expect(lines.every(l => l.JournalEntryLineDetail.Entity.EntityRef.value === '5')).toBe(true);
  const missing = structuredClone(m); delete missing.dimensions!.departmentAsLocation!.locations.sales;
  expect(() => closePlan({...r, scope: f.scope}, {actionId: reversed.actionId}, missing, successful(ap, '900'))).toThrow(/department_mapping_missing/);
});

it('rejects final posting after a dimension policy change while preserving historical dimension exports', async () => {
  const f = await dimensionsFixture(); const pending = await f.proposeClose(f.adjustment(0, 100));
  const p = await f.t.mutation(cr.proposePolicy!, {...f.controller, idempotencyKey: 'v10-retire-dimensions', policy: {...policy(), version: 'v10-retired'}});
  const row = await f.t.run(ctx => ctx.db.get(p.policyId as Id<'apBusinessPolicies'>));
  await f.humans.governor!.mutation(cr.activatePolicy!, {scope: f.scope, policyId: p.policyId, expectedHash: row!.hash, reason: 'Retire dimension authority'});
  const before = await f.financial();
  const {makeFunctionReference} = await import('convex/server');
  await expect(f.humans.finance!.mutation(makeFunctionReference<'mutation'>('apClose:vote'), {scope: f.scope, input: {actionId: pending.actionId, actionHash: pending.actionHash, idempotencyKey: 'v10-stale-final', outcome: 'approved', reason: 'Cannot preserve retired authority'}})).rejects.toThrow(/adjustment_dimension/);
  expect(await f.financial()).toEqual(before);
  expect((await f.exported()).recognizedInvoice!.allocations.map(a => [a.department, a.project, a.amountCents])).toEqual(coords.map((c, i) => [c.department, c.project, portions[i]]));
});
