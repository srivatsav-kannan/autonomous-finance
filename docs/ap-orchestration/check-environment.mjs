// Setup checks only. No parsing jobs, workflow actions, bank writes, or service starts.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const args = process.argv.slice(2);
if (args.some(arg => !['--online', '--smoke'].includes(arg))) {
  console.error('Usage: node check-environment.mjs [--online] [--smoke]');
  process.exit(2);
}
const file = process.env.AP_PROVIDER_FILE ?? '/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env';
let env;
try { env = parseEnv(fs.readFileSync(file, 'utf8')); }
catch { console.error('Local provider file unavailable; see API-READINESS.md.'); process.exit(2); }
const has = name => Boolean(env[name]?.trim());
const online = args.includes('--online') || args.includes('--smoke');
const state = name => has(name) ? 'CONFIGURED' : 'NOT_CONFIGURED';

async function request(url, key, body) {
  try {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(body ? 90000 : 20000),
    });
    const data = await response.json().catch(() => null);
    // Never return provider error bodies: they can contain request details.
    return { http: response.status, ok: response.ok, data: response.ok ? data : null };
  } catch { return { http: null, ok: false, data: null }; }
}

async function openai() {
  const out = { service: 'OpenAI', state: state('OPENAI_API_KEY') };
  if (!online || !has('OPENAI_API_KEY')) return out;
  const auth = await request('https://api.openai.com/v1/models', env.OPENAI_API_KEY);
  out.model_list_http = auth.http;
  out.state = auth.ok ? 'AUTH_VERIFIED' : 'CHECK_FAILED';
  if (args.includes('--smoke')) {
    // Test inference even if this key is restricted from listing models.
    const result = await request('https://api.openai.com/v1/responses', env.OPENAI_API_KEY, {
      model: env.AGENT_MODEL || 'gpt-6.1-sol', input: 'Reply with exactly the word READY.',
      reasoning: { effort: 'low' }, max_output_tokens: 256, store: false, service_tier: 'default',
    });
    const output = (result.data?.output ?? []).flatMap(item => item.content ?? [])
      .filter(item => item.type === 'output_text').map(item => item.text).join('').trim();
    out.inference_http = result.http;
    out.state = result.ok && result.data?.status === 'completed' && output === 'READY'
      ? 'INFERENCE_VERIFIED' : 'CHECK_FAILED';
    out.model = result.data?.model ?? null;
  }
  return out;
}

async function llama() {
  const out = { service: 'LlamaParse', state: state('LLAMA_CLOUD_API_KEY'), parsing: 'NOT_RUN' };
  if (!online || !has('LLAMA_CLOUD_API_KEY')) return out;
  const url = new URL('https://api.cloud.llamaindex.ai/api/v2/projects');
  url.searchParams.set('page_size', '1');
  if (has('LLAMA_CLOUD_ORGANIZATION_ID')) url.searchParams.set('organization_id', env.LLAMA_CLOUD_ORGANIZATION_ID);
  const auth = await request(url, env.LLAMA_CLOUD_API_KEY);
  out.http = auth.http;
  out.state = auth.ok ? 'METADATA_ACCESS_VERIFIED' : 'CHECK_FAILED';
  out.note = auth.ok ? 'This utility checks metadata only. Separate parsing evidence and limitations are in LLAMAPARSE-SMOKE.md and LLAMAPARSE-CONTROLS.md.'
    : 'Check project scope/organization and network; this result alone does not establish that the key is invalid.';
  return out;
}

async function increase() {
  const out = { service: 'Increase sandbox', state: state('INCREASE_SANDBOX_API_KEY'), payment: 'NOT_RUN' };
  const fields = ['INCREASE_SANDBOX_ACCOUNT_ID', 'INCREASE_SANDBOX_EXTERNAL_ACCOUNT_ID'];
  out.missing_resource_ids = fields.filter(name => !has(name));
  if (!online || !has('INCREASE_SANDBOX_API_KEY')) return out;
  const auth = await request('https://sandbox.increase.com/accounts?limit=1', env.INCREASE_SANDBOX_API_KEY);
  out.http = auth.http;
  out.state = auth.ok ? 'AUTH_VERIFIED' : 'CHECK_FAILED';
  if (auth.ok) {
    out.resources = [];
    for (const [field, path] of [[fields[0], 'accounts'], [fields[1], 'external_accounts']]) {
      if (!has(field)) continue;
      const result = await request(`https://sandbox.increase.com/${path}/${encodeURIComponent(env[field])}`, env.INCREASE_SANDBOX_API_KEY);
      const matches = result.ok && result.data?.id === env[field];
      out.resources.push({ field, http: result.http, state: matches ? 'RESOURCE_READ_VERIFIED' : 'CHECK_FAILED' });
      if (!matches) out.state = 'CHECK_FAILED';
    }
  }
  return out;
}

const checks = await Promise.all([openai(), llama(), increase()]);
console.log(JSON.stringify({
  checked_at: new Date().toISOString(), provider_file: file,
  private_file_mode: (fs.statSync(file).mode & 0o077) === 0,
  network_checks: online, inference_requested: args.includes('--smoke'), checks,
}, null, 2));
if (checks.some(check => check.state === 'CHECK_FAILED')) process.exitCode = 1;
