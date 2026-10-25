/** Offline pinning tool: node scripts/testing/pin-increase-spec.mjs /tmp/upstream.json */
import fs from 'node:fs';
import crypto from 'node:crypto';
const raw = fs.readFileSync(process.argv[2]);
const upstream = JSON.parse(raw);
const paths = ['/ach_transfers', '/ach_transfers/{ach_transfer_id}', '/transactions', '/transactions/{transaction_id}', '/events', '/accounts/{account_id}/balance', '/simulations/ach_transfers/{ach_transfer_id}/submit', '/simulations/ach_transfers/{ach_transfer_id}/settle', '/simulations/ach_transfers/{ach_transfer_id}/return'];
const selected = Object.fromEntries(paths.map(p => [p, upstream.paths[p]]));
if (Object.values(selected).some(v => !v)) throw new Error('Pinned endpoint missing');
// Remove prose and documentation extensions, not schema constraints, required fields or examples.
function compact(v) {
  if (Array.isArray(v)) return v.map(compact);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('x-') && !['description', 'title', 'summary'].includes(k)).map(([k, x]) => [k, k === 'properties' ? Object.fromEntries(Object.entries(x).map(([name, property]) => [name, compact(property)])) : k === 'example' ? x : compact(x)]));
}
const subset = {openapi: upstream.openapi, info: {title: 'Increase AP demo endpoint subset', version: '2026-10-23'}, servers: [{url:'https://sandbox.increase.com'}], security:upstream.security, paths:compact(selected), components:{securitySchemes:upstream.components.securitySchemes}};
function refs(v) {
  if (!v || typeof v !== 'object') return;
  if (v.$ref) {
    const [,a,b,c] = v.$ref.split('/');
    if (a !== 'components') throw new Error('Nonlocal reference');
    subset.components[b] ??= {};
    if (!subset.components[b][c]) {subset.components[b][c]=compact(upstream.components[b][c]); refs(subset.components[b][c]);}
  }
  for (const value of Object.values(v)) refs(value);
}
refs(subset.paths);
// OpenAPI response descriptions remain required even after removing long prose.
for(const path of Object.values(subset.paths)) for(const operation of Object.values(path)) for(const r of Object.values(operation.responses ?? {})) if (!r.$ref) r.description = 'Pinned upstream response';
for(const r of Object.values(subset.components.responses ?? {})) r.description = 'Pinned upstream error';
const output=JSON.stringify(subset,null,2)+'\n';
fs.writeFileSync('src/integrations/fixtures/increase/openapi.json',output);
const fixturePath = 'src/integrations/fixtures/increase/lifecycle.json';
const fixture = fs.existsSync(fixturePath) ? { fixtureSha256: crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex'), fixtures: 'Hand-authored sandbox-shaped examples derived from pinned upstream examples; no live provider execution claimed.' } : {};
fs.writeFileSync('src/integrations/fixtures/increase/provenance.json',JSON.stringify({...fixture,source:'https://increase.com/openapi_3_0.json',retrievedOn:'2026-10-23',upstreamInfoVersion:upstream.info.version,upstreamSha256:crypto.createHash('sha256').update(raw).digest('hex'),subsetSha256:crypto.createHash('sha256').update(output).digest('hex'),transformation:'Selected endpoint paths and transitive component references; stripped descriptions/titles/summaries/x-* documentation metadata; no schema constraints changed; restored required response descriptions.',paths},null,2)+'\n');
