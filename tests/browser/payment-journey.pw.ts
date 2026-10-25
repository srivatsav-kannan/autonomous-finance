import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { createBrowserFixture } from "../../scripts/testing/payment-browser-fixture";

test.describe.configure({ mode: "serial" });
let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
const proof: Record<string, unknown> = { status: "FAILED", stage: "seed", scenario: "human-approval-pending-verified-settlement" };
function save(stage: string) {
  proof.stage = stage;
  fs.writeFileSync(path.join(process.env.PAYMENT_BROWSER_ARTIFACTS!, "proof.json"), JSON.stringify(proof, null, 2), { mode: 0o600 });
}
async function connect(page: Page, jwt: string, scope = fixture.config.scope) {
  await page.getByLabel("Account scope from the demo report").fill(JSON.stringify(scope));
  await page.getByLabel("Human identity token").fill(jwt);
  await page.getByRole("button", { name: "Connect and load review" }).click();
}
async function noStoredCredentials(page: Page) {
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(await page.context().cookies()).toEqual([]);
}
test.beforeAll(async () => {
  save("seed");
  fixture = await createBrowserFixture();
  proof.scope = fixture.config.scope;
  proof.identityMode = fixture.config.mode === "local" ? "signed_test_issuer_rs256_inline_jwks" : "staging_supplied_signed_jwt";
  save("seeded-awaiting-human");
});
test.afterAll(() => fixture?.bank.close());

test("console loads with human-only login and no persisted credentials", async ({ page }) => {
  save("console-load");
  const errors: string[] = [];
  page.on("pageerror", () => errors.push("pageerror"));
  const response = await page.goto(`${fixture.config.consoleUrl}/ap-demo`);
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "Accounts payable review" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect as a human approver" })).toBeVisible();
  await expect(page.getByLabel("Human identity token")).toHaveAttribute("type", "password");
  await noStoredCredentials(page);
  expect(errors).toEqual([]);
  proof.consoleLoad = "PASSED";
  save("console-loaded");
});

test("missing, invalid, unbound and cross-account identities cannot review or approve", async ({ page }) => {
  save("authorization");
  const { scope, convexUrl } = fixture.config;
  const anonymous = new ConvexHttpClient(convexUrl, { logger: false });
  await expect(anonymous.query(api.demoPayments.humanReview, { scope })).rejects.toThrow(/Forbidden/);
  const approval = { scope, ...fixture.requested, versionId: fixture.requested.versionId as Id<"demoVersions"> };
  await expect(anonymous.mutation(api.demoPayments.approveAndQueue, approval)).rejects.toThrow(/Forbidden/);
  await page.goto(`${fixture.config.consoleUrl}/ap-demo`);
  await connect(page, "invalid-test-token");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payment versions" })).toHaveCount(0);
  await expect(page.getByLabel("Human identity token")).toHaveValue("");
  // This JWT is validly signed by the accepted issuer but has no human CFO binding.
  await connect(page, fixture.config.unauthorizedJwt);
  await expect(page.getByRole("alert")).toContainText("Forbidden");
  const unbound = new ConvexHttpClient(convexUrl, { logger: false });
  unbound.setAuth(fixture.config.unauthorizedJwt);
  await expect(unbound.mutation(api.demoPayments.approveAndQueue, approval)).rejects.toThrow(/Forbidden/);
  await connect(page, fixture.config.humanJwt, { ...scope, accountId: `${scope.accountId}-foreign` });
  await expect(page.getByRole("alert")).toContainText("mismatch");
  await expect(page.getByRole("button", { name: "Approve this version and queue payment" })).toHaveCount(0);
  await noStoredCredentials(page);
  expect((await fixture.review()).commands).toHaveLength(0);
  expect(fixture.bank.harness.inspect().transfers).toHaveLength(0);
  proof.authorization = { missing: "REJECTED", invalid: "REJECTED", unbound: "REJECTED", crossAccount: "REJECTED" };
  save("authorization-rejected");
});

test("human reviews invoice, approves, sees pending then verified settlement and journal history", async ({ page }) => {
  save("human-review");
  let backendRequests = 0;
  let browserErrors = 0;
  let failedRequests = 0;
  page.on("pageerror", () => browserErrors++);
  page.on("requestfailed", () => failedRequests++);
  page.on("request", request => {
    if (request.url().startsWith(`${fixture.config.convexUrl}/api/`)) backendRequests++;
  });
  await page.goto(`${fixture.config.consoleUrl}/ap-demo`);
  await connect(page, fixture.config.humanJwt);
  await expect(page.getByRole("heading", { name: "Payment versions" })).toBeVisible();
  // #56: the read-only operator health view loads with the review and labels thresholds as targets.
  const health = page.locator("section").filter({ has: page.getByRole("heading", { name: "Operator health", exact: true }) });
  await expect(health).toContainText("Targets, not measurements");
  await expect(health.getByRole("button")).toHaveCount(0);
  const versions = page.locator("section").filter({ has: page.getByRole("heading", { name: "Payment versions", exact: true }) });
  const dispatch = page.locator("section").filter({ has: page.getByRole("heading", { name: "Dispatch and recovery", exact: true }) });
  // Seed 7 supplies INV-1001; the kernel's canonical invoice identity is 1001.
  await expect(versions).toContainText("1001");
  await expect(versions).toContainText(fixture.billId);
  await expect(versions).toContainText("external-browser-vendor");
  await expect(versions).toContainText("browser-beneficiary-v1");
  await expect(versions).toContainText("browser-policy-v1");
  await expect(versions).toContainText(fixture.requested.snapshotHash);
  await versions.getByText("Exact immutable payment details", { exact: true }).click();
  await expect(versions.locator("pre")).toContainText(String(fixture.source.invoice.totalCents));
  const approve = page.getByRole("button", { name: "Approve this version and queue payment" });
  await expect(approve).toBeDisabled();
  await page.getByRole("checkbox", { name: "I approve the displayed USD amount" }).check();
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByText("Human approval recorded for the reviewed payment version.", { exact: false })).toBeVisible();
  await expect(dispatch).toContainText("queued / unposted");
  const queued = await fixture.review();
  expect(queued.commands).toHaveLength(1);
  expect(queued.versions[0]?.approvals.some(approval => approval.kind === "human" && approval.seatId === "human")).toBe(true);
  const frozen = structuredClone(queued.commands[0]!.command);
  expect(fixture.bank.harness.inspect().transfers).toHaveLength(0);
  save("accepted-pending");
  const dispatched = await fixture.dispatcher.tick();
  expect(dispatched.error).toBeUndefined();
  expect(dispatched.providerTransferId).toBeTruthy();
  // Poll real bank evidence while the transfer is still accepted/pending.
  expect(await fixture.worker.tick()).toEqual({ posted: 0, errors: [] });
  const pending = await fixture.review();
  expect(pending.commands[0]?.execution).toBe("pending");
  expect(pending.commands[0]?.posting).toBe("unposted");
  expect(pending.bills[0]?.paidCents).toBe(0);
  expect(pending.bills[0]?.reservedVersionId).toBe(fixture.requested.versionId);
  expect((await fixture.evidence()).transactions.filter(record => record.entryId)).toHaveLength(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(dispatch).toContainText("pending / unposted");
  await expect(dispatch).toContainText("Await verified bank settlement");
  await expect(page.getByText("No verified bank transactions have been imported.", { exact: true })).toBeVisible();
  proof.pending = { execution: "pending", posting: "unposted", billPaidCents: 0, reserved: true, settlementEntries: 0 };
  save("bank-settled-without-evidence");
  const accepted = fixture.bank.harness.inspect().transfers[0]!;
  fixture.bank.harness.settle(accepted.id);
  fixture.bank.harness.drainNotifications({ drop: true });
  // The bank's status alone cannot change the application; verify before evidence worker runs.
  expect((await fixture.review()).bills[0]?.paidCents).toBe(0);
  expect((await fixture.review()).commands[0]?.execution).toBe("pending");
  expect(await fixture.worker.tick()).toEqual({ posted: 1, errors: [] });
  expect(await fixture.worker.tick()).toEqual({ posted: 0, errors: [] });
  const settled = await fixture.review();
  const evidence = await fixture.evidence();
  expect(settled.commands[0]?.command).toEqual(frozen);
  expect(settled.commands[0]?.execution).toBe("settled");
  expect(settled.commands[0]?.posting).toBe("posted");
  expect(settled.commands[0]?.reconciliation).toBe("matched");
  expect(settled.bills[0]?.paidCents).toBe(fixture.source.invoice.totalCents);
  expect(settled.bills[0]?.reservedVersionId).toBeUndefined();
  expect(evidence.transactions).toHaveLength(1);
  expect(evidence.blockers).toEqual([]);
  const transaction = evidence.transactions[0]!;
  expect(transaction.transaction.status).toBe("posted");
  expect(transaction.transaction.amountCents).toBe(-fixture.source.invoice.totalCents);
  expect(transaction.transaction.purpose).toBe("debit");
  expect(transaction.entryId).toBeTruthy();
  const bank = fixture.bank.harness.inspect();
  expect(bank.transfers).toHaveLength(1);
  expect(bank.transactions.filter(t => t.status === "posted" && t.purpose === "debit")).toHaveLength(1);
  expect(bank.calls.createTransfer).toBe(1);
  save("visible-evidence-history");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(dispatch).toContainText("settled / posted / matched");
  const transactionRow = page.getByRole("row").filter({ hasText: transaction.transaction.id });
  await expect(transactionRow).toContainText("debit · posted");
  await expect(transactionRow).toContainText(transaction.entryId!);
  await expect(transactionRow).toContainText(accepted.id);
  await expect(dispatch).toContainText(frozen.idempotencyKey);
  await expect(dispatch).toContainText(frozen.requestHash);
  await expect(page.getByRole("heading", { name: "Close blockers · 0" })).toBeVisible();
  await noStoredCredentials(page);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByLabel("Human identity token")).toHaveValue("");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Connect as a human approver" })).toBeVisible();
  await noStoredCredentials(page);
  expect(browserErrors).toBe(0);
  expect(failedRequests).toBe(0);
  expect(backendRequests).toBeGreaterThan(0);
  proof.settled = { execution: "settled", posting: "posted", reconciliation: "matched", externalTransfers: bank.transfers.length,
    createTransferCalls: bank.calls.createTransfer, postedDebits: 1, settlementEntries: 1,
    billPaidCents: settled.bills[0]!.paidCents, operationKeyUnchanged: true, requestBytesUnchanged: true, replayPosted: 0 };
  proof.browser = { realBackendRequests: backendRequests, pageErrors: browserErrors, failedRequests,
    storageEmpty: true, journalLinkVisible: true, transactionVisible: true, historyVisible: true };
  proof.status = "PASSED";
  save("complete");
});
