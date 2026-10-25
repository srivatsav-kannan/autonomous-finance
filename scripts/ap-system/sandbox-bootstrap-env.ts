/** Explicit launcher for existing processes. Does not configure a backend or bind a human. */
import path from "node:path";
import { spawn } from "node:child_process";
import { PrivateStore } from "../../src/ap-system/quickbooks/private-store";
const [mode, ...args] = process.argv.slice(2);
try {
  if (
    !["gateway", "dispatch", "evidence"].includes(mode ?? "") ||
    args.some((a) => a !== "--once") ||
    (args.length && mode === "gateway")
  )
    throw Error();
  const store = new PrivateStore(
    path.join(process.cwd(), "var/auth0-bootstrap"),
  );
  const env = await store.read<Record<string, string>>(`${mode}.json`);
  if (!env) throw Error();
  const common = ["PATH", "HOME", "TMPDIR", "LANG"];
  const allowed =
    mode === "gateway"
      ? [
          ...common,
          "LLAMA_CLOUD_API_KEY",
          "QBO_CLIENT_ID",
          "QBO_CLIENT_SECRET",
          "QBO_REALM_ID",
          "QBO_REDIRECT_URI",
          "QBO_ENVIRONMENT",
          "QBO_PRIVATE_DIR",
        ]
      : [
          ...common,
          "INCREASE_SANDBOX_API_KEY",
          "INCREASE_SANDBOX_WEBHOOK_SECRET",
        ];
  const inherited = Object.fromEntries(
    allowed
      .filter((k) => process.env[k] !== undefined)
      .map((k) => [k, process.env[k]!]),
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      mode === "gateway"
        ? "scripts/ap-system/sandbox-server.ts"
        : "scripts/ap-worker.ts",
      ...(mode === "gateway" ? [] : [mode!, ...args]),
    ],
    { cwd: process.cwd(), env: { ...inherited, ...env }, stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => child.kill(signal));
  child.on("error", () => {
    console.error("Sandbox process failed; private details withheld.");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} catch {
  console.error(
    "Explicit sandbox process configuration required; private details withheld.",
  );
  process.exitCode = 1;
}
