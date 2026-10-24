import { describe, it } from "vitest";
import { RECOVERY_CASES, runPaymentRecoveryCase } from "../scripts/payment-recovery-live";

// Requires a running LOCAL Convex deployment, CONVEX_URL and KERNEL_ADMIN_SECRET.
// Each test creates a unique run and real child workers; ordinary npm test stays offline.
describe.skipIf(process.env.PAYMENT_RECOVERY_LIVE !== "1")("payment recovery across worker processes", () => {
  it.each(RECOVERY_CASES)("preserves payment and retry invariants for %s", async (kind) => {
    await runPaymentRecoveryCase(kind);
  }, 60_000);
});
