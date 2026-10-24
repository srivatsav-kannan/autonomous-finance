import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { parseBankScope } from "../../src/payments/domain/validation";
import { PAYMENT_EXECUTOR_VERSION } from "../../src/payments/contracts";
import { DemoAPAgent, DemoPaymentsAgent } from "../../src/payments/agents";
import { PaymentDispatcher } from "../../src/payments/dispatcher";
import { EvidenceWorker } from "../../src/payments/evidence";
import { demoInvoice } from "../../src/payments/demo-invoice";
import type { BankScope } from "../../src/integrations/contracts";

export type BrowserFixtureConfig = {
  mode: "local" | "staging";
  consoleUrl: string;
  convexUrl: string;
  scope: BankScope;
  humanJwt: string;
  unauthorizedJwt: string;
  humanSubject: string;
  kernelAdminSecret: string;
  dispatcherToken: string;
  evidenceToken: string;
  bankPath: string;
};

export function readFixture(): BrowserFixtureConfig {
  const filename = process.env.PAYMENT_BROWSER_FIXTURE;
  assert.ok(filename, "Runner-owned fixture required");
  assert.equal(fs.statSync(filename).mode & 0o077, 0, "Private fixture permissions required");
  const config = JSON.parse(fs.readFileSync(filename, "utf8")) as BrowserFixtureConfig;
  assert.ok(config.mode === "local" || config.mode === "staging");
  const scope = parseBankScope(config.scope);
  // Always check before constructing any bank/client or performing a write.
  assert.equal(scope.provider, "fake");
  assert.equal(scope.environment, "local");
  assert.equal(scope.organizationId, "payment-browser-smoke");
  const suffix = scope.runId.slice("payment-browser-".length);
  assert.match(scope.runId, /^payment-browser-[0-9a-f-]{36}$/);
  assert.equal(scope.accountId, `payment-browser-account-${suffix}`);
  assert.equal(fs.existsSync(config.bankPath), false, "Never reuse a bank database");
  for (const field of ["humanJwt", "unauthorizedJwt", "humanSubject", "kernelAdminSecret", "dispatcherToken", "evidenceToken"] as const) {
    assert.ok(typeof config[field] === "string" && config[field].length > 10);
  }
  assert.equal(new Set([config.kernelAdminSecret, config.dispatcherToken, config.evidenceToken]).size, 3);
  for (const raw of [config.consoleUrl, config.convexUrl]) {
    const url = new URL(raw);
    assert.equal(url.username + url.password + url.search + url.hash, "");
    if (config.mode === "local") {
      assert.equal(url.protocol, "http:");
      assert.equal(url.hostname, "127.0.0.1");
    } else {
      assert.equal(url.protocol, "https:");
    }
  }
  return config;
}

/** Test process only. Agents receive their own seat handles; the browser gets only human JWTs. */
export async function createBrowserFixture() {
  const config = readFixture();
  const { scope } = config;
  const client = new ConvexHttpClient(config.convexUrl, { logger: false });
  const human = new ConvexHttpClient(config.convexUrl, { logger: false });
  human.setAuth(config.humanJwt);
  const source = demoInvoice(7, "2026-01-05");
  const random = () => randomBytes(32).toString("hex");
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const tokens = { ap: random(), payments: random(), controller: random() };
  const seats = [
    ...Object.entries(tokens).map(([seatId, token]) => ({ seatId, role: seatId === "ap" ? "ap_clerk" : seatId, kind: "agent" as const, name: seatId, tokenHash: hash(token) })),
    { seatId: "human", role: "human_cfo", kind: "human" as const, name: "Browser smoke human CFO", tokenHash: hash(random()) },
  ];
  const result = await client.mutation(api.admin.createRun, {
    secret: config.kernelAdminSecret, runId: scope.runId, label: "Isolated browser payment smoke",
    company: "Browser smoke fixture", simDate: source.invoice.invoiceDate, seats, periods: ["2026-01"],
  });
  assert.equal(result.ok, true);
  // Configure rejects existing financial/configuration rows. A consumed fixture is never reset.
  await client.mutation(api.demoPayments.configure, {
    scope, secret: config.kernelAdminSecret, paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
    beneficiary: { vendor: source.vendor, externalAccountId: "external-browser-vendor", version: "browser-beneficiary-v1" },
    policyVersion: "browser-policy-v1", controllerLimitCents: 5_000_000,
    humanSubjects: [{ subject: config.humanSubject, seatId: "human" }],
  });
  // Check the deployment's service account binding before any browser approval.
  await client.query(api.demoEvidence.work, { scope, token: config.evidenceToken });
  const ap = new DemoAPAgent(client, { scope, seatId: "ap", token: tokens.ap });
  const payments = new DemoPaymentsAgent(client, { scope, seatId: "payments", token: tokens.payments });
  const { billId } = await ap.recordInvoice({
    vendor: source.vendor, invoiceNumber: source.invoice.invoiceNumber, invoiceDate: source.invoice.invoiceDate,
    originalCents: source.invoice.totalCents, evidence: [source.event.externalId],
  });
  await client.mutation(api.demoPayments.acceptBill, {
    scope, seatId: "controller", token: tokens.controller, billId, approvedCents: source.invoice.totalCents,
  });
  const requested = await payments.requestPayment([billId], `browser:${source.event.externalId}`);
  const review = () => human.query(api.demoPayments.humanReview, { scope });
  const evidence = () => human.query(api.demoEvidence.humanView, { scope });
  const initial = await review();
  assert.equal(initial.commands.length, 0);
  assert.equal(initial.versions.length, 1);
  assert.equal(initial.versions[0]?.status, "awaiting_approval");
  assert.equal(initial.bills[0]?.paidCents, 0);
  const bank = openFakeBank({
    path: config.bankPath, scope, seed: 7, startTime: "2026-01-05T12:00:00.000Z", initialBalanceCents: 10_000_000,
  });
  const dispatcher = new PaymentDispatcher(client, scope, config.dispatcherToken, bank.provider, "browser-dispatcher");
  const worker = new EvidenceWorker(client, scope, config.evidenceToken, bank.provider);
  return { config, source, billId, requested, human, client, bank, dispatcher, worker, review, evidence };
}
