import {mkdtemp, readdir, readFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach, expect, it} from 'vitest';
import {ProjectCatalogClient, PROJECT_SCOPE, PROJECT_ENDPOINT, type ProjectGrant, type ProjectCatalogConfig} from '../../src/ap-system/quickbooks/project-catalog';
import {PrivateStore} from '../../src/ap-system/quickbooks/private-store';
import type {Transport} from '../../src/ap-system/quickbooks/oauth';
const dirs: string[] = [];
afterEach(async () => {await Promise.all(dirs.splice(0).map(p => rm(p, {recursive: true, force: true})));});
const epoch = 1793476800000;
const config: ProjectCatalogConfig = {version: 'ap-qbo-project-catalog-v1', environment: 'sandbox', realmId: '123', ttlMs: 60000, acceptedStatuses: ['ACTIVE']};
const grant = (): ProjectGrant => ({version: 'ap-qbo-project-grant-v1', environment: 'sandbox', realmId: '123', grantId: 'synthetic-exact-grant', clientHash: 'c'.repeat(64), scopes: [PROJECT_SCOPE], authorizedAt: epoch - 1000, expiresAt: epoch + 120000, accessToken: 'synthetic-private-catalog-token'});
const body = (id: string, account = '123') => ({data: {projectManagementProject: {id, name: `Project ${id}`, status: 'ACTIVE', account: {id: account}, customer: {id: '12'}}}});
async function setup(transport: Transport, getGrant = async () => grant(), clock = () => epoch) {
  const root = await mkdtemp('/private/tmp/ap97-v10-catalog-'); dirs.push(root);
  const store = new PrivateStore(root), calls: {url: string; init: RequestInit}[] = [];
  const client = new ProjectCatalogClient(config, getGrant, store, async (url, init = {}) => {calls.push({url: String(url), init}); return transport(url, init);}, clock, async () => {});
  return {client, store, calls};
}

it('returns only a complete realm-checked catalog and keeps successful proof bytes private', async () => {
  const f = await setup(async (_url, init) => {const id = JSON.parse(String(init?.body)).variables.id; return new Response(JSON.stringify(body(id)));});
  const receipt = await f.client.verify({realmId: '123', projectIds: ['21', '11']});
  expect(receipt.projects.map(p => p.id)).toEqual(['11', '21']); expect(receipt.validUntil).toBe(epoch + 60000);
  for (const call of f.calls) {expect(call.url).toBe(PROJECT_ENDPOINT); expect(call.init.redirect).toBe('error'); const request = JSON.parse(String(call.init.body)); expect(request.query).toMatch(/^query /); expect(request.query).not.toContain('mutation'); expect(Object.keys(request.variables)).toEqual(['id']);}
  for (const file of await readdir(f.store.root)) {
    const text = await readFile(join(f.store.root, file), 'utf8'); expect(text).not.toContain('synthetic-private-catalog-token'); expect((await stat(join(f.store.root, file))).mode & 0o777).toBe(0o600);
    const artifact = JSON.parse(text); if (artifact.raw) expect(createHash('sha256').update(artifact.raw).digest('hex')).toBe(artifact.responseSha256);
  }
  const bad = await setup(async (_url, init) => {const id = JSON.parse(String(init?.body)).variables.id; return new Response(JSON.stringify(body(id, id === '21' ? '999' : '123')));});
  await expect(bad.client.verify({realmId: '123', projectIds: ['11', '21']})).rejects.toThrow(/identity_or_status_conflict/);
  expect((await readdir(bad.store.root)).filter(n => n.startsWith('project-catalog-'))).toEqual([]);
});

it('expires the grant between project reads without returning a partial catalog or issuing the next request', async () => {
  let time = epoch; const g = {...grant(), expiresAt: epoch + 2000};
  const f = await setup(async (_url, init) => {time = epoch + 1500; return new Response(JSON.stringify(body(JSON.parse(String(init?.body)).variables.id)));}, async () => g, () => time);
  await expect(f.client.verify({realmId: '123', projectIds: ['11', '21']})).rejects.toThrow(/project_authorized_grant_required/);
  expect(f.calls).toHaveLength(1); expect((await readdir(f.store.root)).filter(n => n.startsWith('project-catalog-'))).toEqual([]);
});

it.each(['clientHash', 'grantId', 'authorizedAt', 'scopes'] as const)('rejects %s changes during 401 rotation before sending the replacement token', async field => {
  const original = grant(), replacement = {...grant(), accessToken: 'synthetic-replacement-token'};
  if (field === 'clientHash') replacement.clientHash = 'd'.repeat(64);
  if (field === 'grantId') replacement.grantId = 'another-grant';
  if (field === 'authorizedAt') replacement.authorizedAt--;
  if (field === 'scopes') replacement.scopes = [PROJECT_SCOPE, 'additional-scope'];
  let reads = 0;
  const f = await setup(async () => new Response('private upstream diagnostic', {status: 401}), async () => ++reads === 1 ? original : replacement);
  await expect(f.client.verify({realmId: '123', projectIds: ['11']})).rejects.toThrow(/project_grant_reauthorization_required/);
  expect(f.calls).toHaveLength(1); expect(reads).toBe(2); expect(await readdir(f.store.root)).toEqual([]);
});

it('rejects overlarge streamed bodies and hostile request identities without leaking provider diagnostics', async () => {
  let cancelled = false;
  const f = await setup(async () => new Response(new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array(256 * 1024)); controller.enqueue(new Uint8Array(1));}, cancel() {cancelled = true;}})));
  await expect(f.client.verify({realmId: '123', projectIds: ['11']})).rejects.toThrow(/project_catalog_response_too_large/);
  expect(cancelled).toBe(true); expect(await readdir(f.store.root)).toEqual([]);
  const invalid = await setup(async () => {throw Error('synthetic-private-catalog-token transport diagnostic');});
  for (const ids of [[], ['11', '11'], ['11\" } mutation { '], Array.from({length: 26}, (_, i) => String(i + 1))]) await expect(invalid.client.verify({realmId: '123', projectIds: ids})).rejects.toThrow(/project_catalog_request_invalid/);
  await expect(invalid.client.verify({realmId: '999', projectIds: ['11']})).rejects.toThrow(/project_catalog_request_invalid/);
  expect(invalid.calls).toHaveLength(0);
  await expect(invalid.client.verify({realmId: '123', projectIds: ['11']})).rejects.toThrow(/^project_catalog_transport_failed$/);
});

it('never returns a completed catalog after TTL expires while receiving the last body', async () => {
  let time = epoch;
  const f = await setup(async () => {time += 61000; return new Response(JSON.stringify(body('11')));}, async () => grant(), () => time);
  await expect(f.client.verify({realmId: '123', projectIds: ['11']})).rejects.toThrow(/project_catalog_expired_during_read/);
  expect((await readdir(f.store.root)).filter(n => n.startsWith('project-catalog-'))).toEqual([]);
});
