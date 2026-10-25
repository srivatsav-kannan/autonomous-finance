import type { PaymentCommands } from "../ports/payment-kernel";
import { parseCommandEnvelope } from "../domain/validation";

/** Validation and orchestration only; authenticated authority stays in the kernel. */
export function createPaymentCommandService(commands: PaymentCommands): PaymentCommands {
  return {
    requestPayment: envelope => { parseCommandEnvelope(envelope); return commands.requestPayment(envelope); },
    approveWithinPolicy: envelope => { parseCommandEnvelope(envelope); return commands.approveWithinPolicy(envelope); },
    approveAndQueue: envelope => { parseCommandEnvelope(envelope); return commands.approveAndQueue(envelope); },
    cancel: envelope => { parseCommandEnvelope(envelope); return commands.cancel(envelope); },
    resume: envelope => { parseCommandEnvelope(envelope); return commands.resume(envelope); },
    releaseUnsent: envelope => { parseCommandEnvelope(envelope); return commands.releaseUnsent(envelope); },
  };
}
