import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const backendVersion = 'precompiled-2026-10-10-72ce13c';
const root = process.cwd();
const random = () => randomBytes(32).toString('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function privateJson(filename, value) {
  fs.writeFileSync(filename, JSON.stringify(value, null, 2), { mode: 0o600 });
}
function origin(raw, local) {
  const url = new URL(raw);
  if (url.origin !== raw || url.username || url.password || url.search || url.hash ||
      (local ? url.protocol !== 'http:' || url.hostname !== '127.0.0.1' : url.protocol !== 'https:')) {
    throw new Error('Unsafe target origin');
  }
  return raw;
}
function fakeScope(scope) {
  if (!scope || Object.keys(scope).sort().join(',') !== 'accountId,environment,organizationId,provider,runId' ||
      scope.provider !== 'fake' || scope.environment !== 'local' || scope.organizationId !== 'payment-browser-smoke' ||
      !/^payment-browser-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope.runId) ||
      scope.accountId !== `payment-browser-account-${scope.runId.slice('payment-browser-'.length)}`) {
    throw new Error('Isolated fake/local scope required');
  }
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

/** No inherited model, bank, deploy, JWT or admin credentials enter any child environment. */
export async function runBrowser(mode) {
  if (!['local', 'staging'].includes(mode)) throw new Error('Unknown browser mode');
  const output = path.join(root, 'var/ci', `payment-browser-${mode}`);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  // Remove only these known reports: no old success can satisfy a new failed run.
  for (const name of ['summary.json', 'playwright.json', 'proof.json']) fs.rmSync(path.join(output, name), { force: true });
  const report = {
    revision: git('rev-parse', 'HEAD'),
    trackedChanges: git('diff', 'HEAD', '--name-only') !== '',
    untrackedSource: git('ls-files', '--others', '--exclude-standard') !== '',
    recordedAt: new Date().toISOString(), mode, status: 'FAILED', stage: 'preflight',
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    identityMode: mode === 'local' ? 'signed_test_issuer_rs256_inline_jwks' : 'staging_supplied_signed_jwt',
    optionalValidation: { staging: 'NOT_RUN', externalIdentityProvider: 'NOT_RUN', liveIncrease: 'NOT_RUN', externalWebhooks: 'NOT_RUN' },
  };
  const save = () => privateJson(path.join(output, 'summary.json'), report);
  save();
  const children = [];
  let project;
  let interrupted = false;
  const timer = setTimeout(() => { interrupted = true; }, 360_000);
  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const env = { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: os.tmpdir(),
    CONVEX_AGENT_MODE: 'anonymous', CONVEX_DISABLE_TELEMETRY: '1', CI: 'true', NO_COLOR: '1', NODE_NO_WARNINGS: '1' };
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
  function start(args, extraEnv = {}, cwd = project) {
    const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { child, ready: false, failed: false, diagnostic: undefined };
    let tail = '';
    const consume = chunk => {
      tail = (tail + chunk.toString()).slice(-8192);
      if (tail.includes('Convex functions ready!')) state.ready = true;
      // Bounded categorical diagnostics, never a raw CLI/browser log containing credentials.
      for (const [needle, category] of [['Download failed', 'download'], ['Could not resolve', 'module-resolution'],
        ['Failed to push', 'convex-push'], ['Port', 'port'], ["Executable doesn't exist", 'missing-browser']]) {
        if (tail.includes(needle)) state.diagnostic = category;
      }
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.on('error', () => { state.failed = true; });
    children.push(state);
    return state;
  }
  async function until(predicate, child, milliseconds) {
    const deadline = Date.now() + milliseconds;
    while (!await predicate()) {
      if (interrupted || Date.now() > deadline || child.failed || child.child.exitCode !== null || child.child.signalCode !== null) {
        if (child.diagnostic) report.diagnostic = child.diagnostic;
        if (child.child.exitCode !== null) report.childExitCode = child.child.exitCode;
        throw new Error('Runner step failed');
      }
      await delay(150);
    }
    if (interrupted) throw new Error('Interrupted');
  }
  const stage = value => { report.stage = value; save(); console.log(`Payment browser ${mode}: ${value}`); };
  try {
    if (!['linux', 'darwin'].includes(process.platform)) throw new Error('POSIX process groups required');
    let config;
    if (mode === 'staging') {
      if (process.env.PAYMENT_BROWSER_ALLOW_STAGING !== 'isolated-fake-only' || !process.env.PAYMENT_BROWSER_STAGING_FIXTURE ||
          !fs.existsSync(process.env.PAYMENT_BROWSER_STAGING_FIXTURE)) {
        report.status = 'NOT_RUN'; report.stage = 'missing-staging-opt-in-or-fixture'; process.exitCode = 2;
        return;
      }
      const filename = process.env.PAYMENT_BROWSER_STAGING_FIXTURE;
      if (!path.isAbsolute(filename) || (fs.statSync(filename).mode & 0o077) !== 0) throw new Error('Private manifest required');
      const supplied = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (supplied.targetEnvironment !== 'staging' || !/^[a-f0-9]{40}$/.test(supplied.targetRevision)) throw new Error('Explicit staging deployment identity required');
      fakeScope(supplied.scope);
      config = { mode, consoleUrl: origin(supplied.consoleUrl, false), convexUrl: origin(supplied.convexUrl, false), scope: supplied.scope };
      for (const key of ['humanJwt', 'unauthorizedJwt', 'humanSubject', 'kernelAdminSecret', 'dispatcherToken', 'evidenceToken']) {
        if (typeof supplied[key] !== 'string' || supplied[key].length < 10) throw new Error('Missing fixture credential');
        config[key] = supplied[key];
      }
      if (new Set([config.kernelAdminSecret, config.dispatcherToken, config.evidenceToken]).size !== 3) throw new Error('Distinct service credentials required');
      report.targetRevision = supplied.targetRevision;
      report.targetRevisionSource = 'operator-supplied; not independently attested by console';
      report.optionalValidation.staging = 'FAILED';
    } else {
      // Do not let the pinned CLI fall back to an existing global/user deployment.
      for (const item of ['config.json', 'anonymous-convex-backend-state/anonymous-agent']) {
        if (fs.existsSync(path.join(os.homedir(), '.convex', item))) throw new Error('Unconfigured Convex user required');
      }
    }
    project = fs.mkdtempSync(path.join(os.tmpdir(), `payment-browser-${mode}-`));
    // No .env files, CLI state, existing data or credentials copied from the checkout.
    for (const item of ['convex', 'src', 'company', 'console', 'package.json', 'package-lock.json', 'tsconfig.json']) {
      if (mode === 'local') fs.cpSync(path.join(root, item), path.join(project, item), {
        recursive: true, filter: source => !['node_modules', 'dist', '.env', '.env.local', '.convex'].includes(path.basename(source)),
      });
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(project, 'node_modules'), 'dir');
    if (mode === 'local') {
      const uuid = randomUUID();
      const scope = { organizationId: 'payment-browser-smoke', runId: `payment-browser-${uuid}`, provider: 'fake', environment: 'local', accountId: `payment-browser-account-${uuid}` };
      fakeScope(scope);
      const issuer = `https://payment-browser.invalid/${uuid}`;
      const audience = 'payment-browser-smoke';
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: uuid, alg: 'RS256', use: 'sig' }] };
      const jwt = subject => {
        const base64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        const body = `${base64({ alg: 'RS256', typ: 'JWT', kid: uuid })}.${base64({ iss: issuer, aud: audience, sub: subject, iat: now, exp: now + 600 })}`;
        return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
      };
      // Override only the disposable copy. Production OIDC config remains untouched.
      fs.writeFileSync(path.join(project, 'convex/auth.config.ts'), `export default ${JSON.stringify({ providers: [{
        type: 'customJwt', applicationID: audience, issuer, algorithm: 'RS256',
        jwks: `data:text/plain;charset=utf-8;base64,${Buffer.from(JSON.stringify(jwks)).toString('base64')}`,
      }] })};\n`);
      config = { mode, scope, humanJwt: jwt('browser-human'), unauthorizedJwt: jwt('unbound-human'),
        humanSubject: `${issuer}|browser-human`, kernelAdminSecret: random(), dispatcherToken: random(), evidenceToken: random() };
      report.backendVersion = backendVersion;
      stage('backend-start');
      const cloudPort = await freePort();
      let sitePort = await freePort();
      while (sitePort === cloudPort) sitePort = await freePort();
      const backend = start(['node_modules/convex/bin/main.js', 'dev', '--codegen', 'disable', '--typecheck', 'disable', '--tail-logs', 'disable', '--local-backend-version', backendVersion,
        '--local-cloud-port', String(cloudPort), '--local-site-port', String(sitePort)]);
      const configPath = path.join(project, '.convex/local/default/config.json');
      await until(() => fs.existsSync(configPath), backend, 180_000);
      const local = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (local.ports?.cloud !== cloudPort || local.ports?.site !== sitePort || !local.adminKey || local.backendVersion !== backendVersion) throw new Error('Unexpected local config');
      config.convexUrl = origin(`http://127.0.0.1:${local.ports.cloud}`, true);
      stage('backend-ready');
      await until(async () => {
        try {
          const response = await fetch(`${config.convexUrl}/instance_name`, { redirect: 'error', signal: AbortSignal.timeout(1000) });
          return response.ok && await response.text() === local.deploymentName;
        } catch { return false; }
      }, backend, 60_000);
      const response = await fetch(`${config.convexUrl}/api/update_environment_variables`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Convex ${local.adminKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: Object.entries({ KERNEL_ADMIN_SECRET: config.kernelAdminSecret,
          AP_DISPATCH_SECRET: config.dispatcherToken, AP_EVIDENCE_SECRET: config.evidenceToken, AP_BANK_SCOPE: JSON.stringify(scope),
        }).map(([name, value]) => ({ name, value })) }),
      });
      if (!response.ok) throw new Error('Local environment setup failed');
      stage('backend-deploy');
      await until(() => backend.ready, backend, 90_000);
      stage('console-build');
      const build = start(['node_modules/vite/bin/vite.js', 'build', '--config', 'console/vite.config.ts'], { VITE_CONVEX_URL: config.convexUrl });
      await until(() => build.child.exitCode === 0, build, 60_000);
      stage('console-start');
      const port = await freePort();
      config.consoleUrl = origin(`http://127.0.0.1:${port}`, true);
      const consoleServer = start(['node_modules/vite/bin/vite.js', 'preview', '--config', 'console/vite.config.ts', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { VITE_CONVEX_URL: config.convexUrl });
      await until(async () => {
        try { return (await fetch(`${config.consoleUrl}/ap-demo`, { redirect: 'error', signal: AbortSignal.timeout(1000) })).ok; }
        catch { return false; }
      }, consoleServer, 30_000);
    }
    config.bankPath = path.join(project, 'browser-bank.sqlite');
    const fixturePath = path.join(project, 'browser-fixture.json');
    privateJson(fixturePath, config); // Never uploaded; removed in finally.
    stage('playwright');
    const browser = start([path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', path.join(root, 'playwright.payment.config.ts')], {
      PAYMENT_BROWSER_FIXTURE: fixturePath, PAYMENT_BROWSER_ARTIFACTS: output,
      PAYMENT_BROWSER_PRIVATE_OUTPUT: path.join(project, 'playwright-private'),
    }, root);
    await until(() => browser.child.exitCode === 0, browser, 180_000);
    stage('verify-evidence');
    const suite = JSON.parse(fs.readFileSync(path.join(output, 'playwright.json'), 'utf8'));
    const proof = JSON.parse(fs.readFileSync(path.join(output, 'proof.json'), 'utf8'));
    if (suite.status !== 'passed' || suite.runnerErrors || suite.tests.length !== 3 || suite.tests.some(test => test.status !== 'passed') ||
        proof.status !== 'PASSED' || proof.stage !== 'complete' || proof.settled?.externalTransfers !== 1 || proof.settled?.settlementEntries !== 1) {
      throw new Error('Incomplete browser proof');
    }
    if (mode === 'local') {
      stage('verify-local-journal');
      const raw = execFileSync(process.execPath, ['node_modules/convex/bin/main.js', 'data', 'journalEntries', '--format', 'json', '--limit', '1000'],
        { cwd: project, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
      const journal = JSON.parse(raw.trim() || '[]');
      if (!Array.isArray(journal) || journal.length >= 1000) throw new Error('Incomplete journal evidence');
      const settlement = journal.filter(entry => entry.runId === config.scope.runId && entry.source?.kind === 'payment_settlement');
      const cashCredits = settlement.flatMap(entry => entry.lines).filter(line => line.account === '1000').reduce((sum, line) => sum + line.credit - line.debit, 0);
      if (settlement.length !== 1 || cashCredits !== proof.settled.billPaidCents) throw new Error('Settlement journal invariant');
      report.localJournal = { settlementEntries: settlement.length, cashCreditCents: cashCredits };
    }
    report.status = 'PASSED';
    if (mode === 'staging') report.optionalValidation.staging = 'PASSED';
    report.stage = 'complete';
  } catch {
    report.status = 'FAILED'; report.failureKind = interrupted ? 'interrupted-or-timeout' : 'runner-or-assertion';
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    const stop = signal => {
      for (const { child } of children) if (child.pid) {
        try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    try {
      stop('SIGTERM'); await delay(500); stop('SIGKILL');
      if (project) fs.rmSync(project, { force: true, recursive: true });
    } catch { report.status = 'FAILED'; report.stage = 'cleanup'; process.exitCode = 1; }
    save();
    console.log(`Payment browser ${mode} ${report.status}: var/ci/payment-browser-${mode}/summary.json`);
  }
}
