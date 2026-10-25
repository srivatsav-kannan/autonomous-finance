/** Local-only OIDC fixture for browser -> JWT verification -> AP -> bank -> close testing.
 * It never loads provider credentials or connects to a remote Convex deployment.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, createHash, sign } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { PaymentDispatcher } from "../../src/payments/dispatcher";
import { EvidenceWorker } from "../../src/payments/evidence";
import type { BankScope } from "../../src/integrations/contracts";

const local = JSON.parse(fs.readFileSync(path.resolve(".convex/local/default/config.json"), "utf8")) as { ports: { cloud: number }; adminKey: string };
const url = `http://127.0.0.1:${local.ports.cloud}`;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "ap-browser-test", alg: "RS256", use: "sig" };
let issuer = "";
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/.well-known/openid-configuration") res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json`, response_types_supported: ["id_token"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] }));
  else if (req.url === "/.well-known/jwks.json") res.end(JSON.stringify({ keys: [jwk] }));
  else { res.statusCode = 404; res.end("{}"); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
issuer = `http://127.0.0.1:${port}`;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const bytes = `${encode({ alg: "RS256", typ: "JWT", kid: jwk.kid })}.${encode({ iss: issuer, sub: "browser-human", aud: "ap-browser-test", iat: now, exp: now + 3600, ...overrides })}`;
  return `${bytes}.${sign("RSA-SHA256", Buffer.from(bytes), privateKey).toString("base64url")}`;
}
const random = () => randomBytes(32).toString("hex");
const secrets = { admin: random(), dispatcher: random(), evidence: random() };
const runId = `ap-browser-${Date.now()}`;
const scope: BankScope = { organizationId: "ap-demo", runId, provider: "fake", environment: "local", accountId: "browser-usd" };
const updated = await fetch(`${url}/api/update_environment_variables`, { method: "POST", headers: { Authorization: `Convex ${local.adminKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ changes: Object.entries({ KERNEL_ADMIN_SECRET: secrets.admin, AP_DISPATCH_SECRET: secrets.dispatcher, AP_EVIDENCE_SECRET: secrets.evidence, AP_BANK_SCOPE: JSON.stringify(scope), AP_HUMAN_AUTH_ISSUER: issuer, AP_HUMAN_AUTH_AUDIENCE: "ap-browser-test" }).map(([name, value]) => ({ name, value })) }) });
assert.ok(updated.ok, "Local environment configuration failed");
const client = new ConvexHttpClient(url), human = new ConvexHttpClient(url);
const jwt = token(); human.setAuth(jwt);
const tokens = { ap: random(), payments: random(), controller: random() };
const date = new Date().toISOString().slice(0, 10), period = date.slice(0, 7);
const seats = [...Object.entries(tokens).map(([seatId, value]) => ({ seatId, role: seatId === "ap" ? "ap_clerk" : seatId, name: seatId, kind: "agent" as const, tokenHash: createHash("sha256").update(value).digest("hex") })), { seatId: "human", role: "human_cfo", name: "Local OIDC test human", kind: "human" as const, tokenHash: createHash("sha256").update(random()).digest("hex") }];
assert.ok((await client.mutation(api.admin.createRun, { secret: secrets.admin, runId, company: "Browser fixture", label: "Local OIDC browser test", simDate: date, seats, periods: [period] })).ok);
await client.mutation(api.demoPayments.configure, { scope, secret: secrets.admin, beneficiary: { vendor: "vendor-1", externalAccountId: "external-vendor", version: "v1" }, policyVersion: "v1", controllerLimitCents: 100000, humanSubjects: [{ subject: `${issuer}|browser-human`, seatId: "human" }] });
const { billId } = await client.mutation(api.demoPayments.recordBill, { scope, seatId: "ap", token: tokens.ap, vendor: "vendor-1", invoiceNumber: "INVOICE-001", invoiceDate: date, originalCents: 10000, expenseAccount: "5000", evidence: ["local-browser-invoice"] });
await client.mutation(api.demoPayments.acceptBill, { scope, seatId: "controller", token: tokens.controller, billId, approvedCents: 10000 });
const requested = await client.mutation(api.demoPayments.requestPayment, { scope, seatId: "payments", token: tokens.payments, requestKey: "browser-payment", billIds: [billId], credits: [] });
const pause = () => new Promise(resolve => setTimeout(resolve, 1000));
// The running convex dev process may need a moment to deploy the changed auth config.
for (let attempt = 0; ; attempt++) {
  try { await human.query(api.demoPayments.humanReview, { scope }); break; }
  catch (error) { if (attempt >= 30) throw error; await pause(); }
}
const wrongAudience = new ConvexHttpClient(url); wrongAudience.setAuth(token({ aud: "wrong-audience" }));
const expired = new ConvexHttpClient(url); expired.setAuth(token({ exp: 1 }));
await assert.rejects(wrongAudience.query(api.demoPayments.humanReview, { scope }));
await assert.rejects(expired.query(api.demoPayments.humanReview, { scope }));
const artifactDir = path.resolve("var/ap-demo", runId); fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
const credentialsPath = path.join(artifactDir, "browser-session.json");
fs.writeFileSync(credentialsPath, JSON.stringify({ scope, jwt }), { mode: 0o600 });
console.log(JSON.stringify({ status: "awaiting_browser_approval", identityMode: "local_oidc_test_identity", credentialsPath, scope, amountCents: 10000, negativeAuthChecks: ["wrong_audience_rejected", "expired_token_rejected"] }, null, 2));
let command;
for (let attempt = 0; attempt < 300; attempt++) {
  command = (await human.query(api.demoPayments.humanReview, { scope })).commands[0];
  if (command) break;
  await pause();
}
assert.ok(command, "Browser approval timed out after five minutes");
assert.equal(command.command.commandId, requested.versionId);
const bank = openFakeBank({ path: path.join(artifactDir, "bank.sqlite"), scope, seed: 7, startTime: `${date}T12:00:00.000Z`, initialBalanceCents: 100000 });
try {
  await new PaymentDispatcher(client, scope, secrets.dispatcher, bank.provider, "browser-dispatcher").tick();
  assert.equal(bank.harness.inspect().transfers.length, 1);
  bank.harness.settle(bank.harness.inspect().transfers[0]!.id);
  bank.harness.drainNotifications({ drop: true });
  const worker = new EvidenceWorker(client, scope, secrets.evidence, bank.provider);
  assert.deepEqual(await worker.tick(), { posted: 1, errors: [] });
  assert.deepEqual(await worker.tick(), { posted: 0, errors: [] });
  assert.equal((await client.mutation(api.demoEvidence.signClose, { scope, period, seatId: "controller", token: tokens.controller })).status, "open");
  assert.equal((await human.mutation(api.demoEvidence.signClose, { scope, period })).status, "closed");
  const review = await human.query(api.demoPayments.humanReview, { scope });
  const evidence = await human.query(api.demoEvidence.humanView, { scope });
  assert.equal(evidence.blockers.length, 0);
  fs.writeFileSync(path.join(artifactDir, "report.json"), JSON.stringify({ status: "passed", identityMode: "local_oidc_test_identity", browserApproval: true, negativeAuthChecks: ["wrong_audience_rejected", "expired_token_rejected"], scope, review, evidence, close: { period, status: "closed" } }, null, 2));
  console.log(JSON.stringify({ status: "passed", reportPath: path.join(artifactDir, "report.json"), close: "closed", note: "Refresh the browser to verify the posted and matched result. Stop this process after inspection." }, null, 2));
} finally { bank.close(); }
// Keep the local test issuer alive for the final UI refresh; Ctrl-C removes the test token.
process.once("SIGINT", () => { fs.rmSync(credentialsPath, { force: true }); server.close(); process.exit(0); });
process.once("SIGTERM", () => { fs.rmSync(credentialsPath, { force: true }); server.close(); process.exit(0); });
