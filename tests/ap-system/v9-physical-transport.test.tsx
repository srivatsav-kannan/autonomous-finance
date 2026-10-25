import {afterEach, expect, it, vi} from 'vitest';
import {getFunctionName} from 'convex/server';
import type {ConvexHttpClient} from 'convex/browser';
import type {AddressInfo} from 'node:net';
import {renderToStaticMarkup} from 'react-dom/server';
import {APPhysicalAllocation} from '../../console/src/APPhysicalClaims';
import {currentPhysicalReviews, physicalAccrualChoices, validatePhysicalBusiness} from '../../console/src/apPhysicalView';
import {createAPSystemServer, APHttpError, type APWorkspaceService} from '../../src/ap-system/server';
import {createAPWorkspaceService} from '../../src/ap-system/service';
import type {PhysicalLineView} from '../../src/ap-system/physical-line-contracts';
import {physicalFixture, physical, physicalView} from './v9-physical-fixture';

const servers: ReturnType<typeof createAPSystemServer>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('binds actual HTTP physical mapping decisions to each synthetic current human and creates no accounting or payment effects', async () => {
  const f = await physicalFixture(), origin = 'http://127.0.0.1:5192';
  const calls: {actor: string; fn: string}[] = [];
  const service = (name: string) => createAPWorkspaceService({
    agent: f.t as unknown as ConvexHttpClient,
    human: {
      query: async (ref: unknown, args: unknown) => {
        calls.push({actor: name, fn: getFunctionName(ref as never)});
        return (f.humans[name]!.query as (ref: unknown, args: unknown) => Promise<unknown>)(ref, args);
      },
      mutation: async (ref: unknown, args: unknown) => {
        calls.push({actor: name, fn: getFunctionName(ref as never)});
        return (f.humans[name]!.mutation as (ref: unknown, args: unknown) => Promise<unknown>)(ref, args);
      },
    } as unknown as ConvexHttpClient,
    scope: f.scope,
    apCredential: {seatId: 'ap_clerk', token: 'token-ap'},
    paymentsCredential: {seatId: 'payments', token: 'token-payments'},
    controllerCredential: {seatId: 'controller', token: 'token-controller'},
    parseUploads: async () => {throw new Error('No provider allowed');}, runtime: () => ({}),
  });
  const server = createAPSystemServer({runtime: () => ({})} as APWorkspaceService, {
    port: 0, runId: f.scope.runId, storageRoot: '/private/tmp', allowedOrigins: [origin],
    auth: {publicConfig: {mode: 'auth0', domain: 'synthetic.invalid', clientId: 'synthetic-only'}, authenticate: async token => {
      if (!['owner', 'second'].includes(token)) throw new APHttpError('authentication_required', 401, 'Synthetic identity unavailable');
      return {subject: `synthetic|${token}`, issuer: 'synthetic', approved: true, service: service(token)};
    }},
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ap-system`;
  async function session(name: string) {
    const response = await fetch(base + '/cases', {headers: {Authorization: `Bearer ${name}`}});
    expect(response.status).toBe(200);
    return {Authorization: `Bearer ${name}`, cookie: response.headers.get('set-cookie')!.split(';')[0]!, origin, 'Content-Type': 'application/json', 'X-AP-System-Session': '1'};
  }
  const owner = await session('owner'), second = await session('second');
  const post = (op: string, input: unknown, headers = owner) => fetch(base + `/physical-lines/${op}`, {method: 'POST', headers, body: JSON.stringify(input)});
  const proposal = {caseId: f.detail.caseId, expectedRevision: f.detail.revision, snapshotHash: f.detail.snapshotHash,
    source: f.input.purchasingEvidence[1]!.source, physicalLines: physical,
    links: f.input.purchasingEvidence[1]!.lines.map((line, i) => ({parserLineId: line.lineId, physicalLineId: i ? 'south' : 'north', quantity: i ? '1.5' : '0.5'})),
    reason: 'Independent HTTP original-derived physical map'};
  expect((await post('propose', {idempotencyKey: 'empty-http-map', proposal: {...proposal, links: []}})).status).toBe(400);
  expect((await f.snapshot()).mappings).toHaveLength(0);
  const input = {idempotencyKey: 'v9-http-map', proposal};
  const response = await post('propose', input); expect(response.status).toBe(200);
  const mapping = await response.json() as {reviewId: string; hash: string};
  expect(await (await post('propose', input)).json()).toEqual(mapping);
  const decision = {reviewId: mapping.reviewId, expectedHash: mapping.hash, outcome: 'approved', reason: 'Independently checked both original spans'};
  expect((await post('decide', decision, owner)).ok).toBe(false);
  expect((await post('decide', {...decision, scope: {...f.scope, accountId: 'foreign'}}, second)).status).toBe(400);
  expect((await post('decide', decision, {...second, Authorization: 'Bearer owner'})).status).toBe(403);
  expect((await f.snapshot()).catalogs).toHaveLength(0);
  expect((await post('decide', decision, second)).status).toBe(200);
  expect((await post('decide', decision, second)).status).toBe(200);
  const read = await fetch(base + `/physical-lines?caseId=${encodeURIComponent(f.detail.caseId)}`, {headers: second});
  expect(read.status).toBe(200); const text = await read.text();
  expect(text).not.toMatch(/token-controller|token-ap|originalBase64|originalRef/);
  const view = JSON.parse(text) as PhysicalLineView;
  expect(view.reviews).toHaveLength(1);
  expect(view.reviews[0]!.decision).toMatchObject({subject: 'https://ap-demo.invalid|second', seatId: 'human-second', outcome: 'approved'});
  expect(view.catalogs[0]!.capacities.map(c => c.remainingQuantity)).toEqual(['0.5', '1.5']);
  expect(calls).toContainEqual({actor: 'second', fn: 'apPhysicalLines:decide'});
  const snapshot = await f.snapshot(); expect(snapshot.catalogs).toHaveLength(1); expect(snapshot.journals).toHaveLength(0); expect(snapshot.bills).toHaveLength(0);
  expect(await f.t.run(ctx => ctx.db.query('demoCommands').collect())).toHaveLength(0);
});

it('rejects empty positive claims without side effects, then permits the explicitly selected original half-unit', async () => {
  const f = await physicalFixture(), mapping = await f.mapping(); await f.approveMapping(mapping);
  const view = await f.humans.second!.query(physicalView, {scope: f.scope}) as PhysicalLineView;
  const accepted = f.accepted(f.input, mapping.reviewId, ['north']);
  const invalid = structuredClone(accepted); invalid.lines[0]!.receipts[0]!.identity!.allocations = [];
  expect(() => validatePhysicalBusiness(view, f.detail, {acceptance: invalid})).toThrow();
  const before = await f.snapshot(); await expect(f.propose(f.detail, invalid, 'v9-http-empty-claim')).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
  expect(() => validatePhysicalBusiness(view, f.detail, {acceptance: accepted})).not.toThrow();
  await f.recognize(f.detail, accepted);
  const after = await f.snapshot(); expect(after.bills).toHaveLength(1); expect(after.bills[0]!.approvedCents).toBe(1925);
  const current = await f.humans.second!.query(physicalView, {scope: f.scope}) as PhysicalLineView;
  expect(current.catalogs[0]!.capacities.map(c => c.remainingQuantity)).toEqual(['0', '1.5']);
  const source = f.input.purchasingEvidence[1]!.source, lineId = f.input.purchasingEvidence[1]!.lines[0]!.lineId;
  const html = renderToStaticMarkup(<APPhysicalAllocation view={view} detail={f.detail} source={source} lineId={lineId} quantity="0.5" value={{reviewId: mapping.reviewId, allocations: []}} onChange={() => {}}/>);
  expect(html).toContain('inputMode="decimal" value=""'); expect(html).not.toContain('inputMode="decimal" value="0.5"');
  const unavailable = renderToStaticMarkup(<APPhysicalAllocation detail={f.detail} source={source} lineId={lineId} quantity="0.5" onChange={() => {}}/>);
  expect(unavailable).toMatch(/unavailable|loading/i); expect(unavailable).not.toContain('inputMode="decimal"');
});

it('invalidates retained physical choices after an actual same-case revision and rejects historical source-only bindings', async () => {
  const f = await physicalFixture(), mapping = await f.mapping(); await f.approveMapping(mapping);
  const view = await f.humans.second!.query(physicalView, {scope: f.scope}) as PhysicalLineView;
  const source = f.input.purchasingEvidence[1]!.source;
  expect(currentPhysicalReviews(view, f.detail, source)).toHaveLength(1);
  expect(physicalAccrualChoices(view, [f.detail], source, f.supplier.supplierId)).toHaveLength(2);
  const historical = {...f.detail, currentSourceBindings: f.detail.currentSourceBindings.filter(s => s.sourceId !== source.sourceId)};
  expect(historical.sources.some(s => s.sha256 === source.sha256)).toBe(true);
  expect(currentPhysicalReviews(view, historical, source)).toHaveLength(0);
  const input = structuredClone(f.input); input.idempotencyKey = 'v9-transport-explicit-revision'; input.explicitRevisionOf = f.detail.caseId;
  input.candidate!.revision = f.detail.revision + 1; input.purchasingEvidence[1]!.lines.forEach(line => line.lineId = 'changed-' + line.lineId);
  const current = await f.reviewed(input); expect(current.caseId).toBe(f.detail.caseId);
  expect(currentPhysicalReviews(view, current, source)).toHaveLength(0);
  expect(physicalAccrualChoices(view, [current], source, f.supplier.supplierId)).toHaveLength(0);
  const retained = f.accepted(input, mapping.reviewId);
  expect(() => validatePhysicalBusiness(view, current, {acceptance: retained})).toThrow(/current/);
  await expect(f.propose(current, retained, 'v9-transport-stale-claim')).rejects.toThrow(/physical_review_stale/);
  expect((await f.snapshot()).bills).toHaveLength(0);
});
