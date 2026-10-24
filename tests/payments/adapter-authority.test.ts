import { describe, expect, it } from "vitest";
import { getFunctionName } from "convex/server";
import { createConvexPaymentKernel } from "../../src/payments/adapters/convex-payment-kernel";
import { createConvexPaymentEvidence } from "../../src/payments/adapters/convex-payment-evidence";
import type { KernelTransport } from "../../src/payments/adapters/convex-transport";
import { PAYMENT_EXECUTOR_VERSION, type BankScope } from "../../src/payments/contracts";

const scope: BankScope = { organizationId: "bound-org", runId: "bound-run", provider: "fake", environment: "local", accountId: "bound-account" };
const injected = { scope: { ...scope, accountId: "other-account" }, token: "caller-supplied-token", paymentExecutorVersion: "legacy" };
function transport() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client: KernelTransport = {
    mutation: async (reference, args) => { calls.push({ name: getFunctionName(reference), args: args ?? {} }); return null as never; },
    query: async (reference, args) => { calls.push({ name: getFunctionName(reference), args: args ?? {} }); return null as never; },
  };
  return { client, calls };
}

describe("adapter authority stays bound when structurally typed inputs contain extra fields", () => {
  it("keeps all dispatcher operations on the original scope, service token and executor", async () => {
    const { client, calls } = transport();
    const kernel = createConvexPaymentKernel(client, scope, "bound-dispatcher-token");
    const claim = { workerId: "worker", leaseToken: "unique-lease-token", ...injected };
    const proof = { commandId: "command-row", generation: 2, leaseToken: "unique-lease-token", ...injected };
    // These values are valid structural TypeScript arguments without casts.
    // Additional caller fields must not replace the adapter's authority.
    await kernel.claim(claim);
    await kernel.heartbeat(proof);
    await kernel.complete({ ...proof, providerTransferId: "original-transfer" });
    await kernel.fail({ ...proof, errorClass: "transport", error: "connection lost" });
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.args).toMatchObject({ scope, token: "bound-dispatcher-token", paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION });
  });

  it("keeps evidence reads and posting bound to their original scope and service token", async () => {
    const { client, calls } = transport();
    const evidence = createConvexPaymentEvidence(client, scope, "bound-evidence-token");
    await evidence.resolveCommand({ idempotencyKey: "original-operation", ...injected });
    await evidence.postTransaction({ transactionId: "posted-bank-transaction", ...injected });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args).toMatchObject({ scope, token: "bound-evidence-token" });
      expect(call.args).not.toHaveProperty("paymentExecutorVersion");
    }
  });
});
