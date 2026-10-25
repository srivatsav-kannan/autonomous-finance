import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export function metadata() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return {
    revision: git('rev-parse', 'HEAD'), // PR runs test GitHub's merge commit.
    trackedChanges: git('diff', 'HEAD', '--name-only') !== '',
    recordedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    optionalValidation: {
      liveIncrease: 'NOT_RUN', realJwt: 'NOT_RUN', externalWebhookDelivery: 'NOT_RUN',
    },
  };
}

// Raw CLI errors can contain credentials, provider bodies and assertion values.
// Classify known errors and export only fixed codes + repository-known source locations.
const diagnosticPatterns = [
  ['INVALID_MODULE_PATH', /invalid (?:module|function|file) (?:path|name)|(?:module|function|file) (?:path|name).*invalid/i],
  ['MODULE_NOT_FOUND', /could not resolve|cannot find module|ERR_MODULE_NOT_FOUND/i],
  ['SYNTAX_ERROR', /SyntaxError|unexpected token|expected .{0,30} but found/i],
  ['TYPECHECK_FAILED', /\bTS\d{4,5}\b|typecheck failed/i],
  ['AUTH_CONFIGURATION', /AP_HUMAN_AUTH_(?:ISSUER|AUDIENCE)|auth config.*(?:missing|failed|error)/i],
  ['BUILD_FAILED', /build failed|failed to (?:bundle|push|deploy)|error when pushing|error fetching/i],
  ['BACKEND_START_FAILED', /failed to (?:start|run) (?:the )?backend|backend.*exited/i],
  ['CONNECTION_REFUSED', /ECONNREFUSED/],
  ['ADDRESS_IN_USE', /EADDRINUSE|address already in use/i],
  ['ASSERTION_FAILED', /AssertionError|ERR_ASSERTION/],
  ['FUNCTION_NOT_FOUND', /could not find.*function|function.*not found/i],
];

export function diagnosticCollector(sourceFiles = []) {
  const files = [...new Set(sourceFiles)].filter(file =>
    /^(?:convex|src|scripts|tests)\/[a-zA-Z0-9_./-]+\.(?:ts|tsx|js|mjs)$/.test(file) &&
    file.length <= 180 && !file.split('/').includes('..')).slice(0, 2000);
  const events = [];
  const seen = new Set();
  let pending = '', scannedBytes = 0, truncated = false;
  const inspect = line => {
    const codes = diagnosticPatterns.filter(([, pattern]) => pattern.test(line)).map(([code]) => code);
    const file = files.find(file => [file, file.replace(/^convex\//, '').replace(/\.ts$/, '.js')]
      .some(alias => line.includes(alias)));
    if (!codes.length && file && /:\d+:\d+|\bat\b/.test(line)) codes.push('SOURCE_LOCATION');
    for (const code of codes) {
      const event = { code };
      if (file) {
        event.file = file;
        const location = line.match(/:(\d{1,5}):(\d{1,5})(?:\D|$)/);
        if (location) { event.line = Number(location[1]); event.column = Number(location[2]); }
      }
      const key = JSON.stringify(event);
      if (seen.has(key)) continue;
      if (events.length === 32) { truncated = true; break; }
      seen.add(key); events.push(event);
    }
  };
  return {
    consume(chunk) {
      const remaining = 256 * 1024 - scannedBytes;
      if (remaining <= 0) { truncated = true; return; }
      const input = Buffer.from(chunk);
      scannedBytes += Math.min(remaining, input.length);
      if (input.length > remaining) truncated = true;
      const lines = (pending + input.subarray(0, remaining).toString('utf8')
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) inspect(line.slice(0, 4096));
      if (pending.length > 4096) { inspect(pending.slice(0, 4096)); pending = ''; truncated = true; }
    },
    snapshot() {
      inspect(pending);
      return { events: events.map(event => ({ ...event })), scannedBytes, truncated, rawOutputRetained: false };
    },
  };
}

export async function waitForRequiredStep(predicate, state, milliseconds, signal) {
  const deadline = Date.now() + milliseconds;
  const checkDeadline = () => {
    if (signal.aborted) throw Object.assign(new Error('Recovery interrupted'), { code: 'RECOVERY_ABORTED' });
    if (Date.now() >= deadline) throw Object.assign(new Error('Recovery step timed out'), { code: 'RECOVERY_TIMEOUT' });
  };
  while (true) {
    checkDeadline();
    const complete = await predicate();
    checkDeadline(); // A late successful response cannot turn a timeout into a pass.
    if (state.failed || state.child.signalCode !== null || (state.child.exitCode !== null && state.child.exitCode !== 0)) throw new Error('Required process failed');
    if (complete) return;
    if (state.child.exitCode !== null) throw new Error('Required process exited without completing');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

// No workflow contexts, environment dumps, secrets, or raw suite payloads.
if (process.env.CI_CHECKS) {
  const input = JSON.parse(process.env.CI_CHECKS);
  const checks = {};
  for (const name of ['install', 'applicationTypecheck', 'backendTypecheck', 'testsTypecheck', 'fullTests', 'consoleBuild']) {
    checks[name] = { success: 'PASSED', failure: 'FAILED', cancelled: 'CANCELLED' }[input[name]] ?? 'NOT_RUN';
  }
  fs.mkdirSync('var/ci', { recursive: true });
  fs.writeFileSync('var/ci/checks.json', JSON.stringify({ ...metadata(), checks }, null, 2));
}
