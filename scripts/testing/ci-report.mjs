import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export function metadata() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
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
