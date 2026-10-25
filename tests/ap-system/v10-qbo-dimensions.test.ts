import {tmpdir} from 'node:os';
import {mkdtemp, rm} from 'node:fs/promises';
import {afterEach, expect, it, vi} from 'vitest';
import {dimensionsFixture, dimensionMappings} from './v10-dimension-fixture';
import {successful, seedSettled} from './quickbooks-business-fixture';
import {billPlan, creditPlan, paymentPlan, dimensionHold} from '../../src/ap-system/quickbooks/plans';
import {QboClient, matches} from '../../src/ap-system/quickbooks/client';
import {PrivateStore, hash, canonical} from '../../src/ap-system/quickbooks/private-store';
import {SyncJournal} from '../../src/ap-system/quickbooks/sync';
import type {OAuth} from '../../src/ap-system/quickbooks/oauth';
import type {Mappings, Plan} from '../../src/ap-system/quickbooks/types';
const dirs: string[] = [];
afterEach(async () => {vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(p => rm(p, {recursive: true, force: true})));});
async function protocol(m: Mappings, entity: Plan['entity'] = 'Bill') {
  const dir = await mkdtemp(`${tmpdir()}/ap97-v10-qbo-`); dirs.push(dir);
  const state = {row: null as any, lose: false, responseProcessing: false, tokenReads: 0};
  const posts: {body: string; requestId: string | null}[] = [];
  const refs: Record<string, unknown> = {
    '/companyinfo/123': {CompanyInfo: {Country: 'US'}}, '/preferences': {Preferences: {AccountingInfoPrefs: {TrackDepartments: true}}},
    ...Object.fromEntries(Object.values(m.accounts).map(a => [`/account/${a.id}`, {Account: {Id: a.id, Active: true, Name: a.name, AccountType: a.type}}])),
    ...Object.fromEntries(Object.values(m.vendors).map(v => [`/vendor/${v.id}`, {Vendor: {Id: v.id, Active: true, DisplayName: v.displayName}}])),
    ...Object.fromEntries(Object.values(m.classes ?? {}).map(c => [`/class/${c.id}`, {Class: {Id: c.id, Active: true, Name: c.name}}])),
    ...Object.fromEntries(Object.values(m.dimensions?.departmentAsLocation?.locations ?? {}).map(d => [`/department/${d.id}`, {Department: {Id: d.id, Active: true, Name: d.name}}])),
    ...Object.fromEntries(Object.values(m.dimensions?.projects?.mappings ?? {}).map(p => [`/customer/${p.customerId}`, {Customer: {Id: p.customerId, Active: true}}])),
  };
  const oauth = {config: {realmId: '123'}, access: async () => {state.tokenReads++; return 'synthetic-only';}, transport: async (url: URL, init: RequestInit) => {
    expect(url.origin).toBe('https://sandbox-quickbooks.api.intuit.com');
    const path = url.pathname.replace('/v3/company/123', '');
    if (init.method === 'POST') {
      posts.push({body: String(init.body), requestId: url.searchParams.get('requestid')});
      state.row = {...JSON.parse(String(init.body)), Id: '900', SyncToken: '0', ...(state.responseProcessing ? {ProcessBillPayment: true} : {})};
      if (state.lose) throw Error('Synthetic lost response');
      return new Response(JSON.stringify({[entity]: state.row}));
    }
    if (path === '/query') return new Response(JSON.stringify({QueryResponse: state.row ? {[entity]: [state.row]} : {}}));
    if (path === `/${entity.toLowerCase()}/900`) return new Response(JSON.stringify({[entity]: state.row}));
    if (!(path in refs)) throw Error('Unplanned protocol route');
    return new Response(JSON.stringify(refs[path]));
  }} as unknown as OAuth;
  const client = new QboClient(oauth, async () => {}, m.dimensions?.projects ? async () => m.dimensions!.projects!.catalog : undefined);
  const store = new PrivateStore(dir), journal = new SyncJournal(store, client);
  return {state, posts, client, store, journal};
}
const auth = (p: Plan) => ({subject: 'synthetic-current-controller', planHash: hash(p), decidedAt: Date.now()});

it('maps actual recognized invoice and linked credit with exact locations, distinct projects/customers and reviewed billability', async () => {
  const f = await dimensionsFixture({homogeneous: true}), m = dimensionMappings();
  const e = await f.exported(), b = billPlan(e, m), credit = await f.credit();
  const c = creditPlan(credit.recognizedCredit!, m, successful(b, '900'));
  for (const [plan, amounts] of [[b, [20, 18, 16, 23]], [c, [10, 9, 8, 11.5]]] as const) {
    expect(plan.payload.DepartmentRef).toEqual({value: '10'});
    expect((plan.payload.Line as any[]).map(l => [l.Amount, l.ProjectRef.value, l.AccountBasedExpenseLineDetail.CustomerRef.value, l.AccountBasedExpenseLineDetail.BillableStatus, l.AccountBasedExpenseLineDetail.ClassRef.value])).toEqual(amounts.map((amount, i) => [amount, i % 2 ? '21' : '11', i % 2 ? '22' : '12', i % 2 ? 'Billable' : 'NotBillable', '9']));
  }
  expect(c.payload.TotalAmt).toBe(38.5);
  const multi = await dimensionsFixture();
  expect(() => billPlan(e, {...m, dimensions: undefined})).toThrow(/department_location_policy_required/);
  const multiExport = await multi.exported();
  expect(() => billPlan(multiExport, m)).toThrow(/mixed_department_export_unsupported/);
});

it.each(['missing department', 'missing project', 'extra line department', 'extra header class', 'wrong customer', 'changed billability'] as const)('never accepts %s in lost-response recovery and never reposts the original request', async change => {
  const f = await dimensionsFixture({homogeneous: true}), m = dimensionMappings(), p = billPlan(await f.exported(), m), wire = await protocol(m);
  wire.state.lose = true;
  await expect(wire.journal.execute(p, m, undefined, auth(p))).rejects.toThrow(/qbo_transport_unknown/);
  const initial = await wire.journal.get(p); expect(initial!.state).toBe('unknown'); expect(wire.posts).toHaveLength(1);
  const exact = structuredClone(wire.state.row), line = wire.state.row.Line[0];
  if (change === 'missing department') delete wire.state.row.DepartmentRef;
  if (change === 'missing project') delete line.ProjectRef;
  if (change === 'extra line department') line.AccountBasedExpenseLineDetail.DepartmentRef = {value: '20'};
  if (change === 'extra header class') wire.state.row.ClassRef = {value: '9'};
  if (change === 'wrong customer') line.AccountBasedExpenseLineDetail.CustomerRef = {value: '22'};
  if (change === 'changed billability') line.AccountBasedExpenseLineDetail.BillableStatus = 'Billable';
  expect(matches(p.payload, wire.state.row)).toBe(false);
  await expect(wire.journal.execute(p, m)).rejects.toThrow(/external_mapping_conflict/);
  const after = await wire.journal.get(p); expect(after!.state).toBe('conflict'); expect(after!.requestId).toBe(initial!.requestId); expect(after!.payload).toEqual(initial!.payload); expect(after!.attempts).toBe(1); expect(wire.posts).toHaveLength(1);
  expect(matches(p.payload, {...exact, MetaData: {CreateTime: 'synthetic'}, domain: 'QBO'})).toBe(true);
});

it('keeps changed mapping policy out of a prepared operation and requires fresh project verification before the first POST', async () => {
  const f = await dimensionsFixture({homogeneous: true}), m = dimensionMappings(), p = billPlan(await f.exported(), m), wire = await protocol(m);
  const withoutCatalog = new SyncJournal(wire.store, new QboClient(wire.client.oauth));
  await expect(withoutCatalog.execute(p, m, undefined, auth(p))).rejects.toThrow(/project_catalog_verification_required/);
  const before = await wire.journal.get(p); expect(before!.state).toBe('prepared'); expect(before!.attempts).toBe(0); expect(wire.state.tokenReads).toBe(0);
  const changed = structuredClone(m); changed.dimensions!.projects!.mappings.alpha!.billable = true;
  const changedPlan = billPlan(await f.exported(), changed);
  await expect(wire.journal.execute(changedPlan, changed, undefined, auth(changedPlan))).rejects.toThrow(/immutable_operation_conflict/);
  expect(await wire.journal.get(p)).toEqual(before); expect(wire.posts).toHaveLength(0);
  const done = await wire.journal.execute(p, m, undefined, auth(p)); expect(done.state).toBe('succeeded'); expect(wire.posts).toHaveLength(1);
  expect(wire.posts[0]!.body).toBe(canonical(p.payload));
});

it('does not infer department authority for local cost-only settlement even after an observed synthetic settlement', async () => {
  const f = await dimensionsFixture({homogeneous: true}), m = dimensionMappings();
  const s = await seedSettled({...f, original: f.original!}, 7700, 7700);
  const e = await s.load(f.detail.caseId, {paymentVersionId: s.versionId});
  expect(dimensionHold(e, m)).toMatchObject({code: 'department_settlement_authority_required'});
  const b = billPlan(e, m);
  expect(() => paymentPlan(e, m, successful(b, '900'))).toThrow(/department_settlement_authority_required/);
});

it('keeps merchant processing disabled through durable prepared state, lost response and saved readback', async () => {
  const m = dimensionMappings(); delete m.dimensions;
  const p: Plan = {version: 'ap-qbo-operation-v1', minorVersion: 75, realmId: m.realmId, identity: 'v10-accounting-payment', entity: 'BillPayment', mappingHash: hash(m), links: {caseId: 'synthetic-case', billId: 'synthetic-bill', recognitionJournalId: 'synthetic-journal', paymentVersionId: 'synthetic-payment', commandId: 'synthetic-command', bankTransactionId: 'synthetic-bank', settlementJournalId: 'synthetic-settlement', creditId: null}, payload: {DocNumber: 'AP' + 'a'.repeat(18), VendorRef: {value: '5'}, APAccountRef: {value: '33'}, CurrencyRef: {value: 'USD'}, TxnDate: '2026-10-31', PayType: 'Check', CheckPayment: {BankAccountRef: {value: '35'}, PrintStatus: 'NotSet'}, TotalAmt: 77, Line: [{Amount: 77, LinkedTxn: [{TxnId: '700', TxnType: 'Bill'}]}]}};
  const bad = {...p, payload: {...p.payload, ProcessBillPayment: true}}, rejected = await protocol(m, 'BillPayment');
  await expect(rejected.journal.execute(bad, m, undefined, auth(bad))).rejects.toThrow(/merchant_processing_forbidden/); expect(rejected.posts).toHaveLength(0);
  expect((await rejected.journal.get(bad))!.payload).toEqual(bad.payload);
  const wire = await protocol(m, 'BillPayment'); wire.state.lose = true; wire.state.responseProcessing = true;
  await expect(wire.journal.execute(p, m, undefined, auth(p))).rejects.toThrow(/qbo_transport_unknown/);
  const unknown = await wire.journal.get(p); expect(unknown!.state).toBe('unknown');
  expect(wire.posts[0]!.body).toBe(canonical(p.payload)); expect(JSON.parse(wire.posts[0]!.body)).not.toHaveProperty('ProcessBillPayment');
  await expect(wire.journal.execute(p, m)).rejects.toThrow(/external_mapping_conflict/); expect(wire.posts).toHaveLength(1);
  expect((await wire.journal.get(p))!.requestId).toBe(unknown!.requestId);
  const good = await protocol(m, 'BillPayment'); const saved = await good.journal.execute(p, m, undefined, auth(p));
  expect(saved.state).toBe('succeeded'); good.state.row.ProcessBillPayment = true;
  await expect(good.journal.execute(p, m)).rejects.toThrow(/external_stale_or_changed/); expect(good.posts).toHaveLength(1);
});
