import { convexTest, type TestConvex } from "convex-test";
import { api } from "../convex/_generated/api";
import { vi } from "vitest";
import schema from "../convex/schema";
import { sha256Hex } from "../convex/lib/kernel";
import type { BankScope } from "../src/integrations/contracts";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");
export { api };
/** Project only the fenced proof; claim metadata is not a mutation argument. */
export function paymentLeaseProof(lease: { commandId: Id<"demoCommands">; generation: number; leaseToken: string }) {
  return { commandId: lease.commandId, generation: lease.generation, leaseToken: lease.leaseToken };
}

/** `t` reuses one deployment for a second run (rebinding AP_BANK_SCOPE, as an operator would). */
export async function demoFixture(runId = "demo-test", scopeOverrides: Partial<BankScope> = {},
  options: { t?: TestConvex<typeof schema>; activitySince?: string } = {}) {
  vi.stubEnv("KERNEL_ADMIN_SECRET", "test-admin");
  vi.stubEnv("AP_DISPATCH_SECRET", "test-dispatcher");
  vi.stubEnv("AP_EVIDENCE_SECRET", "test-evidence");
  const t: TestConvex<typeof schema> = options.t ?? convexTest(schema, modules);
  const scope: BankScope = { organizationId: "org-1", runId, provider: "fake", environment: "local", accountId: "usd-account-1", ...scopeOverrides };
  vi.stubEnv("AP_BANK_SCOPE", JSON.stringify(scope));
  const humanIdentity = { subject: "human", issuer: "https://demo.invalid", tokenIdentifier: "https://demo.invalid|human" };
  const human = t.withIdentity(humanIdentity);
  const roles = ["ap_clerk", "payments", "controller", "human_cfo", "treasury", "fpa", "cash_application", "integrations_engineer", "auditor", "cfo_agent"];
  const seats = await Promise.all(roles.map(async role => ({ seatId: role, role, name: role, kind: role === "human_cfo" ? "human" as const : "agent" as const, tokenHash: await sha256Hex(`token-${role}`) })));
  await t.mutation(api.admin.createRun, { secret: "test-admin", runId, label: "Demo", company: "Demo", simDate: "2026-10-23", seats, periods: ["2026-10"] });
  await t.mutation(api.demoPayments.configure, { scope, secret: "test-admin", beneficiary: { vendor: "vendor-1", externalAccountId: "external-account-1", version: "beneficiary-v1" }, policyVersion: "policy-v1", controllerLimitCents: 1_000_000, humanSubjects: [{ subject: humanIdentity.tokenIdentifier, seatId: "human_cfo" }],
    ...(options.activitySince ? { activitySince: options.activitySince } : {}) });
  const auth = (seatId: string) => ({ scope, seatId, token: `token-${seatId}` });
  const ap = auth("ap_clerk"), payments = auth("payments"), controller = auth("controller");
  let invoice = 0;
  async function bill(amount = 10_000) {
    const { billId } = await t.mutation(api.demoPayments.recordBill, { ...ap, vendor: "vendor-1", invoiceNumber: `INV-${++invoice}`, invoiceDate: "2026-10-23", originalCents: amount, expenseAccount: "5000", evidence: [`invoice:${invoice}`, `receipt:${invoice}`] });
    await t.mutation(api.demoPayments.acceptBill, { ...controller, billId, approvedCents: amount });
    return billId as Id<"demoBills">;
  }
  async function queued(amount = 10_000, credits: {creditId: Id<"demoCredits">;amountCents:number}[] = []) {
    const billId = await bill(amount);
    const requested = await t.mutation(api.demoPayments.requestPayment, { ...payments, requestKey: `pay:${billId}`, billIds: [billId], credits });
    const { commandId } = await human.mutation(api.demoPayments.approveAndQueue, { scope, ...requested });
    return { billId, ...requested, commandId: commandId as Id<"demoCommands"> };
  }
  return { t, human, scope, auth, ap, payments, controller, bill, queued, dispatcherToken: "test-dispatcher", evidenceToken: "test-evidence", humanIdentity };
}
