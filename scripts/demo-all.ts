// One command for the whole local demo on ONE database: Convex 3250/3251 → configure → seed the
// simulated Sweetgreen run and a scored eval (model off, free) → AP gateway 8823 → human gateway → console.
//   npm run demo [-- --no-seed]
// Ports: GATEWAY_PORT (8787), CONSOLE_PORT (5173). Convex 3250/3251 and AP 8823 are fixed by
// src/ap-system/local-runtime.ts. Logs go to var/one/<name>.log and are echoed with a prefix. Ctrl-C stops all.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const noSeed = process.argv.includes("--no-seed");
const GATEWAY_PORT = process.env.GATEWAY_PORT ?? "8787";
const CONSOLE_PORT = process.env.CONSOLE_PORT ?? "5173";
const CONVEX = "http://127.0.0.1:3250";
const hosts = (port: string) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
const ORIGINS = [...new Set([...hosts(CONSOLE_PORT), ...hosts("5173")])].join(",");
const LOGS = path.join("var", "one");
const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string): never => { console.error(`demo stopped: ${msg}`); for (const c of children) c.kill("SIGTERM"); process.exit(1); };
fs.mkdirSync(LOGS, { recursive: true });

function stopAll(code = 0) {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

/** Long-running child: output prefixed on the terminal and kept in var/one/<name>.log. */
function start(name: string, cmd: string, args: string[], env: Record<string, string> = {}) {
  const log = fs.createWriteStream(path.join(LOGS, `${name}.log`));
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout!, child.stderr!]) {
    let rest = "";
    stream.on("data", (chunk: Buffer) => {
      log.write(chunk);
      const lines = (rest + chunk.toString()).split("\n");
      rest = lines.pop()!;
      for (const line of lines) if (line.trim()) console.log(`[${name}] ${line}`);
    });
  }
  child.on("exit", (code) => { if (code && code !== 143) console.error(`[${name}] exited with ${code}; see ${LOGS}/${name}.log`); });
  children.push(child);
  return child;
}

/** One-shot step: inherits the terminal, stops the demo on failure. */
function step(label: string, args: string[], env: Record<string, string> = {}) {
  console.log(`\n== ${label}`);
  const r = spawnSync("npm", ["run", ...args], { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) fail(`${label} failed (npm run ${args.join(" ")})`);
}

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs = 120_000) {
  for (const until = Date.now() + timeoutMs; Date.now() < until; await sleep(1000)) if (await check().catch(() => false)) return;
  fail(`${label} did not come up within ${timeoutMs / 1000}s`);
}
const answers = (url: string) => () => fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.status < 500);
const listening = async (port: string) => answers(`http://127.0.0.1:${port}/`)().catch(() => false);

if (!fs.existsSync(".env.local")) step("first-time setup", ["setup", "--", "--skip-bench"]);
for (const port of ["3250", "8823", GATEWAY_PORT, CONSOLE_PORT]) if (await listening(port)) fail(`port ${port} is already in use; stop what holds it or pick another port`);

start("convex", "npx", ["convex", "dev", "--tail-logs", "disable", "--local-cloud-port", "3250", "--local-site-port", "3251"], { CONVEX_AGENT_MODE: "anonymous" });
await waitFor("Convex on 3250", answers(`${CONVEX}/instance_name`));
// Sets KERNEL_ADMIN_SECRET and the local auth placeholders, points .env.local at 3250, waits for functions.
step("configure backend", ["backend:configure"]);

const offline = { AGENT_LLM: "off" }; // deterministic agents, no model spend
if (noSeed) console.log("\n== seeding skipped (--no-seed)");
else {
  step("seed scenario-1 (14 days, 3 stores, CFO inbox)", ["scenario"], offline); // rerun-safe: reprints its briefing
  const { api, convex } = await import("../src/core/kernel-client");
  const runs = await convex().query(api.admin.runs, {});
  if (runs.some((r) => r.runId.startsWith("eval-"))) console.log("\n== scored eval run already present; skipped");
  else step("seed one scored eval run", ["eval", "--", "--stores", "3", "--days", "14", "--seed", "7", "--label", "one-seed7"], offline);
}

start("ap", "npx", ["tsx", "scripts/ap-system/server.ts"], { AP_SYSTEM_ALLOWED_ORIGINS: ORIGINS });
await waitFor("AP gateway on 8823", answers("http://127.0.0.1:8823/api/ap-system/runtime"));
start("gateway", "npx", ["tsx", "src/human/gateway.ts"], { GATEWAY_PORT, GATEWAY_ALLOWED_ORIGINS: ORIGINS });
start("console", "npx", ["vite", "--config", "console/vite.config.ts", "--port", CONSOLE_PORT, "--strictPort"], {
  VITE_GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}`, VITE_CONVEX_URL: CONVEX, VITE_CONVEX_SITE_URL: "http://127.0.0.1:3251",
});
await waitFor("console", () => listening(CONSOLE_PORT));
console.log(`\nReady. Console http://127.0.0.1:${CONSOLE_PORT}/?view=inbox#scenario-1 · AP cases http://127.0.0.1:${CONSOLE_PORT}/ap-system · Ctrl-C stops everything.`);
