// One-time local setup, safe to rerun. Checks tools, writes .env.local without overwriting your
// values, generates the local secrets, and prepares the external benchmark fixtures.
//   npm run setup [-- --skip-bench]
// It never prints secret values. It does not start the backend: `convex dev` needs its own
// terminal (npm run backend), followed once by `npm run backend:configure`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ENV_FILE, isPlaceholderSecret, mergeExample, newSecret, parseEnv, readEnvFile, upsertEnv, writeEnvFile } from "./lib/env-file";

const args = process.argv.slice(2);
const skipBench = args.includes("--skip-bench");
const VENV = path.join("var", "benchmarks", ".venv");
const done: string[] = [];
const ok = (msg: string) => { done.push(msg); console.log(`  ok  ${msg}`); };
const fail = (msg: string): never => { console.error(`\nsetup stopped: ${msg}`); process.exit(1); };
const version = (text: string) => (/(\d+)\.(\d+)(?:\.(\d+))?/.exec(text) ?? []).slice(1, 4).map((n) => Number(n ?? 0));
const atLeast = (have: number[], want: number[]) => {
  for (let i = 0; i < want.length; i++) if ((have[i] ?? 0) !== want[i]) return (have[i] ?? 0) > want[i]!;
  return true;
};
const run = (cmd: string, cmdArgs: string[], opts: { quiet?: boolean } = {}) =>
  spawnSync(cmd, cmdArgs, { encoding: "utf8", stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : "inherit" });

console.log("Checking tools");
const node = version(process.versions.node);
if (!atLeast(node, [24, 18, 0])) fail(`Node ${process.versions.node} found; 24.18.0 or later is required (see package.json engines).`);
ok(`node ${process.versions.node}`);

const gitOut = run("git", ["--version"], { quiet: true });
if (gitOut.status !== 0) fail("git not found; install git (company memory is a git repository).");
ok(gitOut.stdout.trim());

/** First interpreter that is Python 3.11+: EXTERNAL_BENCH_PYTHON, the existing venv, then python3.x on PATH. */
function findPython(): { bin: string; version: string } | undefined {
  const candidates = [process.env.EXTERNAL_BENCH_PYTHON, path.join(VENV, "bin", "python"), "python3", "python3.14", "python3.13", "python3.12", "python3.11"].filter(Boolean) as string[];
  for (const bin of candidates) {
    const r = run(bin, ["--version"], { quiet: true });
    if (r.status === 0 && atLeast(version(r.stdout || r.stderr), [3, 11])) return { bin, version: (r.stdout || r.stderr).trim() };
  }
  return undefined;
}
const python = findPython();
if (!python) fail("Python 3.11 or later not found. Install it, or set EXTERNAL_BENCH_PYTHON to its path.");
ok(`${python!.version} (${python!.bin})`);

console.log("\nConfiguring .env.local");
const example = fs.readFileSync(".env.example", "utf8");
let text = readEnvFile();
if (!fs.existsSync(ENV_FILE)) {
  text = example;
  ok(`created ${ENV_FILE} from .env.example`);
} else {
  const merged = mergeExample(text, example);
  text = merged.text;
  ok(merged.added.length ? `added missing settings to ${ENV_FILE}: ${merged.added.join(", ")}` : `${ENV_FILE} already has every setting in .env.example; existing values kept`);
}
if (isPlaceholderSecret(parseEnv(text).get("KERNEL_ADMIN_SECRET"))) {
  text = upsertEnv(text, { KERNEL_ADMIN_SECRET: newSecret() }, ["KERNEL_ADMIN_SECRET"]).text;
  ok("generated KERNEL_ADMIN_SECRET");
} else ok("KERNEL_ADMIN_SECRET already set; kept");
writeEnvFile(text);

if ((parseEnv(readEnvFile()).get("VITE_GATEWAY_TOKEN") ?? "").length >= 32) ok("VITE_GATEWAY_TOKEN already set; kept (npm run gateway:token rotates it)");
else {
  // gateway-token.ts prints only that it wrote the token, never the token itself.
  const r = run(process.execPath, ["--import", "tsx", "scripts/gateway-token.ts"], { quiet: true });
  if (r.status !== 0) fail("gateway token generation failed (npm run gateway:token)");
  ok("generated VITE_GATEWAY_TOKEN (gateway and console token)");
}

if (skipBench) console.log("\nSkipping benchmark fixtures (--skip-bench)");
else {
  console.log("\nPreparing external benchmark fixtures (downloads pinned public data once, then reuses the cache)");
  const venvPython = path.join(VENV, "bin", "python");
  if (!fs.existsSync(venvPython)) {
    fs.mkdirSync(path.dirname(VENV), { recursive: true });
    if (run(python!.bin, ["-m", "venv", VENV]).status !== 0) fail(`could not create ${VENV}`);
    ok(`created ${VENV}`);
  } else ok(`${VENV} exists`);
  if (run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", "scripts/external-bench/requirements.txt"]).status !== 0) fail("pip install of scripts/external-bench/requirements.txt failed");
  ok("installed benchmark readers (openpyxl, pypdf, python-docx)");
  const env = { ...process.env, EXTERNAL_BENCH_PYTHON: venvPython };
  for (const batch of ["eight", "extra"]) {
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/evals/external/main.ts", "prepare", "--batch", batch], { stdio: "inherit", env });
    if (r.status !== 0) fail(`bench:prepare --batch ${batch} failed`);
    ok(`prepared benchmark batch "${batch}" (${batch === "eight" ? "3 APEX + 5 DABstep" : "1 Invoice Sandbox + 6 FinBalance"})`);
  }
}

const final = parseEnv(readEnvFile());
const hasModel = Boolean(final.get("OPENAI_API_KEY")?.trim());
console.log(`
Setup complete. What's left:

  1. Start the backend in its own terminal and leave it running:
       npm run backend
  2. Once it prints "Convex functions ready!" (or an auth-config error on the very first start),
     run this once in another terminal:
       npm run backend:configure
  3. ${hasModel ? "OPENAI_API_KEY is set in .env.local; model-backed agents are on." : "Optional: add OPENAI_API_KEY=... to .env.local to turn on the model. Without it everything\n     runs on deterministic paths and says so."}

Then: npm run scenario, npm run ask -- "Why is the close blocked?", npm run evals.`);
