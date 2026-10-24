/** Create a local USD invoice workspace without model calls or external transactions. */
import "../src/core/env";
import fs from "node:fs";
import path from "node:path";
import { AdminClient, api, hashToken, newToken } from "../src/core/kernel-client";

const args = process.argv.slice(2);
const value = (flag: string, fallback: string) => {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const result = args[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
  return result;
};
const runId = value("--run-id", "invoice-demo");
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(runId)) throw new Error("Use a run ID of 1–100 letters, digits, dashes or underscores.");
const company = value("--company", "Demo Services Company");
const url = new URL(process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL ?? "");
if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("This initializer supports an explicit local HTTP Convex deployment only.");
const directory = path.resolve("var", "invoice-mvp", runId);
const seatsFile = path.join(directory, "seats.json");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const tokens: Record<string, string> = fs.existsSync(seatsFile)
  ? JSON.parse(fs.readFileSync(seatsFile, "utf8"))
  : { "human-cfo": newToken(), "invoice-investigator": newToken() };
if (!["human-cfo", "invoice-investigator"].every((id) => typeof tokens[id] === "string" && tokens[id]!.length >= 32)) throw new Error("Invalid saved seat file; preserve it and choose a new run ID.");
// Save before network mutation so a lost create response cannot strand the credentials.
if (!fs.existsSync(seatsFile)) fs.writeFileSync(seatsFile, JSON.stringify(tokens), { flag: "wx", mode: 0o600 });
fs.chmodSync(seatsFile, 0o600);
const admin = new AdminClient();
const created = await admin.client.mutation(api.admin.createRun, {
  secret: admin.secret, runId, label: "Invoice evidence workspace", company,
  simDate: "2026-10-24", periods: [],
  seats: [
    { seatId: "human-cfo", role: "human_cfo", name: "Local operator (simulated identity)", kind: "human", tokenHash: hashToken(tokens["human-cfo"]!) },
    { seatId: "invoice-investigator", role: "ar_clerk", name: "Invoice investigator", kind: "agent", tokenHash: hashToken(tokens["invoice-investigator"]!) },
  ],
});
if (!created.ok && created.code !== "exists") throw new Error(`Workspace initialization failed: ${created.code}`);
// Verify both saved identities before telling the operator the workspace is ready.
for (const seatId of ["human-cfo", "invoice-investigator"]) {
  const verified = await admin.client.query(api.invoiceCases.workspace, { runId, seatId, token: tokens[seatId]! });
  if (!verified.ok) throw new Error(`Workspace identity verification failed: ${verified.code}. Deploy the invoice schema or choose a new run ID; existing state was preserved.`);
}
const runtimeFile = path.join(directory, "runtime.env");
fs.writeFileSync(runtimeFile, [
  `CONVEX_URL=${url.href.replace(/\/$/, "")}`,
  `INVOICE_MVP_RUN_ID=${runId}`,
  `INVOICE_MVP_SEATS_FILE=${seatsFile}`,
  "INVOICE_MVP_MODE=deterministic",
].join("\n") + "\n", { mode: 0o600 });
fs.chmodSync(runtimeFile, 0o600);
console.log(JSON.stringify({ status: created.ok ? "created" : "reused", runId, company, runtimeFile, seatsFile, identity: "simulated local operator", modelCalls: 0 }, null, 2));
