import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { metadata, diagnosticCollector, waitForRequiredStep } from './ci-report.mjs';
import { recoveryEvidence } from './recovery-evidence.mjs';

// Pinned separately from the npm CLI. Bump deliberately and rerun the recovery proof.
const backendVersion = 'precompiled-2026-10-10-72ce13c';
const root = process.cwd();
const output = path.join(root, 'var/ci/recovery.json');
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
const result = { backendVersion, scenario: 'accepted-transfer-sigkill-lookup-polling', status: 'FAILED', stage: 'metadata' };
const save = () => fs.writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600 });
save(); // A killed run must never leave yesterday's passing report.
const abort = new AbortController();
const timer = setTimeout(() => abort.abort('timeout'), 360_000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => abort.abort('cancelled'));
const children = [];
let project;
let sourceFiles = [];
let commandDiagnostics = diagnosticCollector();

async function availablePorts() {
  const reservations = [];
  try {
    for (let i = 0; i < 2; i++) {
      const server = createServer(); reservations.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    }
    return reservations.map(server => server.address().port);
  } finally {
    await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
  }
}

// Deliberate allowlist: no bank/JWT/admin/deploy credentials or NODE_OPTIONS.
const childEnv = {
  PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: os.tmpdir(),
  CONVEX_AGENT_MODE: 'anonymous', CONVEX_DISABLE_TELEMETRY: '1',
  CI: 'true', NO_COLOR: '1', NODE_NO_WARNINGS: '1',
};
function start(role, args) {
  const child = spawn(process.execPath, args, {
    cwd: project, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, role, ready: false, failed: false, diagnostics: diagnosticCollector(sourceFiles) };
  // Never print/persist raw CLI output: it may contain generated admin credentials.
  let tail = '';
  const consume = chunk => {
    state.diagnostics.consume(chunk);
    tail = (tail + chunk.toString()).slice(-4096);
    if (tail.includes('Convex functions ready!')) state.ready = true;
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.on('error', () => { state.failed = true; });
  children.push(state);
  return state;
}
async function until(predicate, state, milliseconds) {
  await waitForRequiredStep(predicate, state, milliseconds, abort.signal);
}
function table(name) {
  const raw = execFileSync(process.execPath, [
    'node_modules/convex/bin/main.js', 'data', name, '--format', 'json', '--limit', '1000',
  ], { cwd: project, env: childEnv, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  // This pinned CLI exits 0 with empty stdout (not JSON []) for an empty table.
  // execFileSync still throws on command failure; never interpret that as empty.
  const rows = JSON.parse(raw.trim() || '[]');
  if (!Array.isArray(rows) || rows.length >= 1000) throw new Error('Incomplete table evidence');
  return rows;
}
try {
  Object.assign(result, metadata());
  sourceFiles = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0');
  commandDiagnostics = diagnosticCollector(sourceFiles);
  result.stage = 'isolation'; save();
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Requires POSIX process groups');
  // The pinned CLI may reuse a legacy global anonymous-agent deployment.
  // Refuse that layout and logged-in global CLI state, never delete or reuse it.
  for (const candidate of ['config.json', 'anonymous-convex-backend-state/anonymous-agent']) {
    if (fs.existsSync(path.join(os.homedir(), '.convex', candidate))) throw new Error('Requires an unconfigured Convex user');
  }
  // Stay outside the checkout so a concurrent `npm test` cannot discover copied suites.
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ci-recovery-'));
  // Own Git metadata preserves the exact source revision for the existing demo report.
  execFileSync('git', ['clone', '--no-hardlinks', '--no-checkout', '--quiet', root, project], {
    env: childEnv, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Copy only source inputs; never copy .env*, .convex, bank files, or runtime state.
  for (const item of ['convex', 'src', 'scripts', 'company', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.tests.json']) {
    fs.cpSync(path.join(root, item), path.join(project, item), { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(project, 'node_modules'), 'dir');
  result.stage = 'backend-start'; save();
  console.log('Starting a fresh anonymous local Convex backend (raw output withheld).');
  const [cloudPort, sitePort] = await availablePorts();
  const backend = start('backend', ['node_modules/convex/bin/main.js', 'dev', '--codegen', 'disable', '--typecheck', 'disable', '--tail-logs', 'disable', '--local-backend-version', backendVersion,
    '--local-cloud-port', String(cloudPort), '--local-site-port', String(sitePort)]);
  const configPath = path.join(project, '.convex/local/default/config.json');
  await until(() => fs.existsSync(configPath), backend, 180_000);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.ports.cloud !== cloudPort || config.ports.site !== sitePort || !config.adminKey || config.backendVersion !== backendVersion) throw new Error('Unexpected local backend configuration');
  // The CLI writes config before the downloaded backend finishes starting.
  // Wait for this instance, not merely for its config file, before sending auth.
  result.stage = 'backend-ready'; save();
  await until(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${config.ports.cloud}/instance_name`, {
        redirect: 'error', signal: AbortSignal.timeout(1000),
      });
      return response.ok && await response.text() === config.deploymentName;
    } catch { return false; }
  }, backend, 60_000);
  result.stage = 'backend-deploy'; save();
  const response = await fetch(`http://127.0.0.1:${config.ports.cloud}/api/update_environment_variables`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Convex ${config.adminKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: [
      { name: 'AP_HUMAN_AUTH_ISSUER', value: 'https://ap-demo.invalid' },
      { name: 'AP_HUMAN_AUTH_AUDIENCE', value: 'ap-demo' },
    ] }),
  });
  if (!response.ok) { result.httpStatus = response.status; throw new Error('Fixture auth setup failed'); }
  await until(() => backend.ready && backend.child.exitCode === null, backend, 90_000);
  result.stage = 'crash-and-recovery'; save();
  console.log('Running the worker-crash and missing-webhook scenario; lease recovery takes about 31 seconds.');
  const demo = start('demo', ['--import', 'tsx', 'scripts/ap-demo.ts', 'local']);
  try { await until(() => demo.child.exitCode === 0, demo, 90_000); }
  catch (error) {
    // Keep the demo's own exit status; the generic wait error does not carry it.
    result.childExitCode = demo.child.exitCode;
    result.childSignal = ['SIGKILL', 'SIGTERM', 'SIGINT'].includes(demo.child.signalCode) ? demo.child.signalCode : null;
    throw error;
  }
  result.stage = 'verify-evidence'; save();
  const runs = fs.readdirSync(path.join(project, 'var/ap-demo'));
  if (runs.length !== 1) throw new Error('Expected exactly one fresh run');
  const report = JSON.parse(fs.readFileSync(path.join(project, 'var/ap-demo', runs[0], 'report.json'), 'utf8'));
  if (report.commit !== result.revision) throw new Error('Revision mismatch');
  result.stage = 'read-journal'; save();
  const journal = table('journalEntries');
  // Notifications were dropped: recovery must come from a completed polling scan (checked inside).
  const tables = { inbox: table('demoInbox'), cursors: table('demoCursors') };
  result.stage = 'verify-invariants'; save();
  result.proof = recoveryEvidence(report, journal, tables);
  // A same-key retry that hit the bank's unique key or an idempotency conflict is a regression
  // even if later polling hides it.
  result.stage = 'verify-no-idempotency-errors'; save();
  if (children.some(({ diagnostics }) => diagnostics.snapshot().events.some(event => event.code === 'IDEMPOTENCY_CONFLICT'))) {
    throw Object.assign(new Error('Idempotency conflict in run output'), { code: 'ERR_ASSERTION', generatedMessage: false });
  }
  if (abort.signal.aborted) throw new Error('Run interrupted');
  if (backend.failed || backend.child.exitCode !== null || backend.child.signalCode !== null) throw new Error('Required backend stopped');
  result.status = 'PASSED';
  result.stage = 'complete';
} catch (error) {
  if (error?.stdout) commandDiagnostics.consume(error.stdout);
  if (error?.stderr) commandDiagnostics.consume(error.stderr);
  if (error?.code === 'RECOVERY_TIMEOUT' || abort.signal.reason === 'timeout') result.status = 'TIMED_OUT';
  else if (abort.signal.aborted) result.status = 'CANCELLED';
  // Do not stringify errors: assertion diffs or HTTP/CLI errors can include secrets.
  result.failureKind = error?.code === 'ERR_ASSERTION' ? 'invariant' : 'runner';
  const line = String(error?.stack).match(/recovery-evidence\.mjs:(\d+):\d+/)?.[1];
  if (line) result.invariantLine = Number(line);
  // Explicit invariant messages are fixed source strings (no values), so they are safe to keep.
  if (error?.code === 'ERR_ASSERTION' && error.generatedMessage === false) result.invariant = String(error.message).split('\n')[0].slice(0, 200);
  if (Number.isInteger(error?.status)) result.childExitCode = error.status;
  console.error(`Local recovery ${result.status} at ${result.stage}; allowlisted diagnostics are in var/ci/recovery.json. See docs/ci.md.`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  result.diagnostics = {
    commands: commandDiagnostics.snapshot(),
    processes: children.map(({ role, child, failed, diagnostics }) => ({
      role, spawnFailed: failed, exitCode: child.exitCode,
      signal: ['SIGKILL', 'SIGTERM', 'SIGINT'].includes(child.signalCode) ? child.signalCode : null,
      ...diagnostics.snapshot(),
    })),
  };
  // Stop only the process groups created by this runner, including worker descendants.
  const stop = signal => {
    for (const { child } of children) if (child.pid) {
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  try {
    stop('SIGTERM'); await delay(1000); stop('SIGKILL');
    if (project) fs.rmSync(project, { recursive: true, force: true });
  } catch {
    result.status = 'FAILED'; result.stage = 'cleanup'; process.exitCode = 1;
  }
  if (abort.signal.aborted) {
    result.status = abort.signal.reason === 'timeout' ? 'TIMED_OUT' : 'CANCELLED';
    process.exitCode = 1;
  }
  save();
  console.log(`Local recovery ${result.status}: var/ci/recovery.json`);
}
