import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PAYMENT_EXECUTOR_VERSION, type BankScope, type LeaseProof } from "../contracts";
import { parseBankScope, parseEffectLease } from "../domain/validation";
import type { PaymentKernel } from "../ports/payment-kernel";
import type { KernelTransport } from "./convex-transport";

export function createConvexPaymentKernel(client: KernelTransport, scope: BankScope, token: string): PaymentKernel {
  const auth = { scope: parseBankScope(scope), token, paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION };
  const fence = (lease: LeaseProof) => ({ ...auth, commandId: lease.commandId as Id<"demoCommands">,
    generation: lease.generation, leaseToken: lease.leaseToken });
  return {
    async claim(args) {
      const lease = await client.mutation(api.demoPayments.claim, { ...auth, workerId: args.workerId, leaseToken: args.leaseToken });
      return lease === null ? null : parseEffectLease(lease);
    },
    heartbeat: lease => client.mutation(api.demoPayments.heartbeat, fence(lease)),
    complete: args => client.mutation(api.demoPayments.complete, { ...fence(args), providerTransferId: args.providerTransferId }),
    fail: args => client.mutation(api.demoPayments.fail, { ...fence(args), errorClass: args.errorClass, error: args.error, retryAfterMs: args.retryAfterMs }),
  };
}
