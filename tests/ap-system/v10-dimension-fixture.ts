import {makeFunctionReference} from 'convex/server';
import {businessFixture, acceptance, policy, binding, br, syncPrimary} from './business-fixture';
import {packet} from './accounting-fixture';
import type {CostCorrection, CostState} from '../../src/ap-system/cost-contracts';
import type {CloseAction, CloseAccountingExport} from '../../src/ap-system/close-contracts';
import type {AccountingExport, Mappings} from '../../src/ap-system/quickbooks/types';
export const coords = [
  {department: 'ops', project: 'alpha'},
  {department: 'ops', project: 'beta'},
  {department: 'sales', project: 'alpha'},
  {department: 'sales', project: 'beta'},
];
export const portions = [2000, 1800, 1600, 2300];
const mutation = (name: string) => makeFunctionReference<'mutation'>(`apClose:${name}`);
const query = (name: string) => makeFunctionReference<'query'>(`apClose:${name}`);
export async function dimensionsFixture(options: {recognize?: boolean; project?: boolean; homogeneous?: boolean} = {}) {
  const configured = policy();
  configured.dimensions = {version: 'ap-gl-dimensions-v1', scope: 'cost_allocations', departments: ['ops', 'sales'], projects: ['alpha', 'beta']};
  const f = await businessFixture({policy: configured});
  const accepted = acceptance(f.input);
  accepted.lines[0]!.allocations = coords.map((c, i) => ({...accepted.lines[0]!.allocations[0]!, ...c, department: options.homogeneous ? 'ops' : c.department, project: options.project === false ? null : c.project, amountCents: portions[i]!}));
  const original = options.recognize === false ? null : await f.recognize(f.detail, accepted);
  let n = 0;
  const evidence = [binding(f.input.documents[1]!)];
  const proposeClose = (action: CloseAction) => f.t.mutation(mutation('propose'), {...f.controller, input: {action, idempotencyKey: `v10-close-${++n}`}});
  async function approveClose(action: CloseAction) {
    const p = await proposeClose(action); let result: any;
    for (const stage of p.route) result = await f.humans[stage.groupId === 'govern' ? 'governor' : stage.groupId]!.mutation(mutation('vote'), {scope: f.scope, input: {actionId: p.actionId, actionHash: p.actionHash, idempotencyKey: `v10-close-vote-${++n}`, outcome: 'approved', reason: 'Independent exact cost and dimension review'}});
    return result;
  }
  const cost = (entryId = original!.entryId) => f.humans.finance!.query(query('costState'), {scope: f.scope, originalEntryId: entryId}) as Promise<CostState>;
  const exported = (caseId = f.detail.caseId) => f.humans.finance!.query(makeFunctionReference<'query'>('apAccountingExport:current'), {scope: f.scope, caseId}) as Promise<AccountingExport>;
  const closeExport = (actionId: string) => f.humans.finance!.query(query('accountingExport'), {scope: f.scope, input: {actionId}}) as Promise<{accounting: CloseAccountingExport; authorizedSubject: string; exportedAt: number}>;
  const adjustment = (index: number, amountCents: number, originalEntryId = original!.entryId): CloseAction => ({kind: 'adjustment', originalEntryId, date: '2026-10-31', fromAccount: '5000', toAccount: '1200', amountCents, ...coords[index]!, project: options.project === false ? null : coords[index]!.project, store: 'sf-hayes-valley', evidence, reason: 'Independent dimension-partitioned reclassification'});
  async function credit(correction?: CostCorrection) {
    const input = packet(`V10-credit-${++n}`), c = input.candidate!;
    c.kind = 'credit_note'; input.documents[0]!.kind = 'credit_note'; c.lines[0]!.quantity.decimal = '1'; c.lines[0]!.amountCents = 3850; c.lines[0]!.allocations[0]!.amountCents = 3850; c.subtotalCents = 3850; c.totalCents = 3850; syncPrimary(input);
    const d = await f.reviewed(input);
    const proposed = await f.t.mutation(br.propose!, {...f.ap, input: {caseId: d.caseId, expectedRevision: d.revision, snapshotHash: d.snapshotHash, idempotencyKey: `v10-credit-${++n}`, policyVersion: configured.version, supplierRevision: 1, accountingDate: '2026-10-31', credit: {originalCaseId: f.detail.caseId, originalApprovalId: original!.proposal.proposalId, lines: [{creditLineId: 'line-1', originalLineId: 'line-1', basis: 'price_adjustment', quantity: '0', netCents: 3850, taxCents: 0, returnEvidence: []}], freightCents: 0, discountCents: 0, reason: 'Independent exact half-price credit', ...(correction ? {correction} : {})}}});
    let result = await f.vote(proposed); if (result.status === 'pending') result = await f.vote(proposed, 'finance');
    return exported(d.caseId);
  }
  const financial = () => f.t.run(async ctx => ({journals: await ctx.db.query('journalEntries').collect(), bills: await ctx.db.query('demoBills').collect(), credits: await ctx.db.query('demoCredits').collect(), applications: await ctx.db.query('apAccrualApplications').collect()}));
  return {...f, accepted, original, evidence, proposeClose, approveClose, cost, exported, closeExport, adjustment, credit, financial};
}
export function dimensionMappings(): Mappings {
  const now = Date.now();
  return {version: 'v10-independent', realmId: '123', country: 'US', vendors: {'golden-state-produce': {id: '5', displayName: 'Golden State Produce Co.'}}, accounts: {'1000': {id: '35', name: 'Bank', type: 'Bank'}, '2000': {id: '33', name: 'AP', type: 'Accounts Payable'}, '2010': {id: '34', name: 'Accrued', type: 'Other Current Liability'}, '5000': {id: '7', name: 'Produce', type: 'Expense'}, '1200': {id: '8', name: 'Stock', type: 'Other Current Asset'}}, classes: {'sf-hayes-valley': {id: '9', name: 'Hayes'}}, apAccount: '2000', bankAccount: '1000', dimensions: {version: 'ap-qbo-dimensions-v1', policyId: 'v10-reviewed-mappings', reviewedBy: 'synthetic-controller', reviewedAt: now, departmentAsLocation: {mode: 'department_as_location', locations: {ops: {id: '10', name: 'Operations'}, sales: {id: '20', name: 'Sales'}}}, projects: {mode: 'qbo_project', mappings: {alpha: {id: '11', name: 'Alpha', customerId: '12', billable: false}, beta: {id: '21', name: 'Beta', customerId: '22', billable: true}}, catalog: {realmId: '123', observedAt: now, validUntil: now + 60000, responseHash: 'a'.repeat(64), entitlementHash: 'b'.repeat(64), scope: 'project-management.project', projects: [{id: '11', name: 'Alpha', customerId: '12', active: true}, {id: '21', name: 'Beta', customerId: '22', active: true}]}}}};
}
