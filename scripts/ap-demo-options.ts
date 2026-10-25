/** Command-line options and secret handling for scripts/ap-demo.ts, unit tested in tests/ap-demo-options.test.ts. */
import fs from "node:fs";
import { ENV_FILE, isPlaceholderSecret, newSecret, readEnvFile, upsertEnv, writeEnvFile } from "./lib/env-file";

/** Must equal LEASE_MS in convex/lib/payments/applyEffect.ts (asserted by tests/ap-demo-options.test.ts). */
export const DISPATCH_LEASE_MS = 30_000;
/** Default and minimum wait after the SIGKILL: the 30 s lease plus a 1 s margin. */
export const MIN_LEASE_WAIT_MS = DISPATCH_LEASE_MS + 1_000;
const MAX_LEASE_WAIT_MS = 10 * 60_000;
/** How long the browser-approval mode waits for a human to approve in /ap-demo. */
export const BROWSER_APPROVAL_TIMEOUT_MS = 10 * 60_000;

export type DemoOptions = { profile: "local" | "sandbox"; browserApproval: boolean; leaseWaitMs: number };
export const DEMO_USAGE = "Usage: npm run demo:local [-- --browser-approval] [--lease-wait-seconds <31-600>] | npm run demo:sandbox";

/** `args` is process.argv.slice(2): the profile, then flags. */
export function parseDemoArgs(args: readonly string[]): DemoOptions {
  const [profile = "local", ...flags] = args;
  if (profile !== "local" && profile !== "sandbox") throw new Error(DEMO_USAGE);
  let browserApproval = false;
  let leaseWaitMs = MIN_LEASE_WAIT_MS;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (flag === "--browser-approval") { browserApproval = true; continue; }
    const [name, inline] = flag.split("=", 2) as [string, string | undefined];
    if (name !== "--lease-wait-seconds") throw new Error(`Unknown option ${flag}. ${DEMO_USAGE}`);
    const value = inline ?? flags[++i];
    const seconds = Number(value);
    // A shorter wait cannot work: the restarted dispatcher would find the killed worker's lease
    // still live. Shortening the lease itself would change the production dispatch kernel, so
    // the demo may only wait longer (for example to narrate), never shorter.
    if (!value || !Number.isInteger(seconds) || seconds * 1000 < MIN_LEASE_WAIT_MS || seconds * 1000 > MAX_LEASE_WAIT_MS) {
      throw new Error(`--lease-wait-seconds must be a whole number from ${MIN_LEASE_WAIT_MS / 1000} to ${MAX_LEASE_WAIT_MS / 1000}`);
    }
    leaseWaitMs = seconds * 1000;
  }
  if (profile === "sandbox" && (browserApproval || leaseWaitMs !== MIN_LEASE_WAIT_MS)) {
    throw new Error("--browser-approval and --lease-wait-seconds apply to the local crash-recovery demo only");
  }
  return { profile, browserApproval, leaseWaitMs };
}

/**
 * The kernel admin secret the local demo writes to the deployment. World, eval, agents and
 * control tests all read KERNEL_ADMIN_SECRET from .env.local, so the demo must reuse that value:
 * replacing the deployment's secret with a random one breaks every other runner with
 * bad_admin_secret. A secret is generated only when none is set (missing, empty or the
 * `change-me` placeholder), and it is saved to .env.local, when that file exists, so the
 * deployment and the other runners keep agreeing.
 */
export function resolveAdminSecret(env: Record<string, string | undefined>, envFile = ENV_FILE): { secret: string; source: "env" | "generated_saved" | "generated_unsaved" } {
  const current = env.KERNEL_ADMIN_SECRET;
  if (!isPlaceholderSecret(current)) return { secret: current!.trim(), source: "env" };
  const secret = newSecret();
  env.KERNEL_ADMIN_SECRET = secret;
  if (!fs.existsSync(envFile)) return { secret, source: "generated_unsaved" };
  writeEnvFile(upsertEnv(readEnvFile(envFile), { KERNEL_ADMIN_SECRET: secret }, ["KERNEL_ADMIN_SECRET"]).text, envFile);
  return { secret, source: "generated_saved" };
}
