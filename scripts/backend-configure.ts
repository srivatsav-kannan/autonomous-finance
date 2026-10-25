// Run once after `npm run backend` is up (and again after resetting it). Copies the deployment
// settings from .env.local to the running deployment with `npx convex env set`, passing each
// value on stdin so it never appears in output or the process list.
//   npm run backend:configure
// Sets KERNEL_ADMIN_SECRET (from .env.local) and the local AP_HUMAN_AUTH_ISSUER /
// AP_HUMAN_AUTH_AUDIENCE placeholders (or your own values, if .env.local sets them).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { ENV_FILE, isPlaceholderSecret, parseEnv, readEnvFile, upsertEnv, writeEnvFile } from "./lib/env-file";

export const LOCAL_AUTH_PLACEHOLDERS = { AP_HUMAN_AUTH_ISSUER: "https://ap-demo.invalid", AP_HUMAN_AUTH_AUDIENCE: "ap-demo" } as const;
const LOCAL_CONFIG = path.join(".convex", "local", "default", "config.json");
const CONVEX_CLI = path.join("node_modules", "convex", "bin", "main.js"); // what `npx convex` runs
const fail = (msg: string): never => { console.error(`backend:configure stopped: ${msg}`); process.exit(1); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(ENV_FILE)) fail(`${ENV_FILE} not found; run npm run setup first.`);
let env = parseEnv(readEnvFile());
const secret = env.get("KERNEL_ADMIN_SECRET");
if (isPlaceholderSecret(secret)) fail("KERNEL_ADMIN_SECRET in .env.local is missing or the placeholder; run npm run setup first.");

// A local deployment records its ports here. Keep the console's URL in step with it, since
// `convex dev` writes CONVEX_URL but a non-default port would otherwise leave VITE_CONVEX_URL stale.
if (fs.existsSync(LOCAL_CONFIG)) {
  const { ports } = JSON.parse(fs.readFileSync(LOCAL_CONFIG, "utf8")) as { ports: { cloud: number } };
  const url = `http://127.0.0.1:${ports.cloud}`;
  const up = await fetch(`${url}/instance_name`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  if (!up) fail(`no backend answering on ${url}. Start it with npm run backend in another terminal and wait for it to start.`);
  const { text, changed } = upsertEnv(readEnvFile(), { CONVEX_URL: url, VITE_CONVEX_URL: url }, ["CONVEX_URL", "VITE_CONVEX_URL"]);
  if (changed.length) { writeEnvFile(text); console.log(`  ok  ${changed.join(" and ")} in .env.local now point at ${url}`); }
  env = parseEnv(readEnvFile());
} else if (!env.get("CONVEX_DEPLOYMENT")) {
  fail("no Convex deployment found for this checkout. Start npm run backend in another terminal first.");
}

const wanted: Record<string, string> = {
  KERNEL_ADMIN_SECRET: secret!,
  AP_HUMAN_AUTH_ISSUER: env.get("AP_HUMAN_AUTH_ISSUER") || LOCAL_AUTH_PLACEHOLDERS.AP_HUMAN_AUTH_ISSUER,
  AP_HUMAN_AUTH_AUDIENCE: env.get("AP_HUMAN_AUTH_AUDIENCE") || LOCAL_AUTH_PLACEHOLDERS.AP_HUMAN_AUTH_AUDIENCE,
};
const convexCli = (cliArgs: string[], input?: string) =>
  spawnSync(process.execPath, [CONVEX_CLI, ...cliArgs], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CONVEX_AGENT_MODE: process.env.CONVEX_AGENT_MODE ?? "anonymous" } });

for (const [name, value] of Object.entries(wanted)) {
  const current = convexCli(["env", "get", name]);
  if (current.status === 0 && current.stdout.trim() === value) { console.log(`  ok  ${name} already set on the deployment`); continue; }
  const set = convexCli(["env", "set", name], value);
  // Never echo CLI output: it can contain the value.
  if (set.status !== 0) fail(`npx convex env set ${name} failed (exit ${set.status}). Is npm run backend running in this checkout?`);
  console.log(`  ok  set ${name} on the deployment${name === "KERNEL_ADMIN_SECRET" ? " (value from .env.local)" : ""}`);
}

// The auth settings change auth.config, which `convex dev` redeploys. Wait until functions answer
// and the admin secret is accepted before saying we're done.
const url = env.get("CONVEX_URL") ?? env.get("VITE_CONVEX_URL");
if (url) {
  const client = new ConvexHttpClient(url);
  let last = "";
  for (let i = 0; i < 60; i++) {
    try {
      const r = await client.mutation(api.admin.setSimDate, { secret: secret!, runId: "__backend-configure-probe__", simDate: "2026-01-01" });
      // A valid secret gets past the admin check and fails only on the unknown run.
      if (r.ok || !/admin/.test(r.code)) { last = ""; break; }
      last = r.code;
    } catch (e) { last = e instanceof Error ? e.message.split("\n")[0]! : String(e); }
    await sleep(1000);
  }
  if (last) fail(`the deployment is not accepting the admin secret yet (${last}). If npm run backend shows an error, restart it and rerun this.`);
  console.log(`  ok  backend at ${url} is serving functions and accepts KERNEL_ADMIN_SECRET`);
}
console.log("\nBackend configured. Next: npm run scenario (or npm run evals).");
