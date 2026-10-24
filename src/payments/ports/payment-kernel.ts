import type {
  ApprovePayment, ApproveWithinPolicy, CancelPayment, CommandEnvelope, DispatchFailure,
  EffectLease, LeaseProof, PaymentRequestResult, RequestPayment, ResumePayment,
} from "../contracts";

/** Authenticated and full-scope-bound by the adapter. No credentials in domain payloads.
 * Every financial check/write remains in the existing atomic Convex mutation. */
export interface PaymentCommands {
  requestPayment(envelope: CommandEnvelope<RequestPayment>): Promise<PaymentRequestResult>;
  approveWithinPolicy(envelope: CommandEnvelope<ApproveWithinPolicy>): Promise<{ status: "awaiting_human_approval" }>;
  approveAndQueue(envelope: CommandEnvelope<ApprovePayment>): Promise<{ commandId: string }>;
  cancel(envelope: CommandEnvelope<CancelPayment>): Promise<void>;
  resume(envelope: CommandEnvelope<ResumePayment>): Promise<void>;
}

/** Method names deliberately map 1:1 to demoPayments endpoints. Rejections throw. */
export interface PaymentKernel {
  claim(args: { workerId: string; leaseToken: string }): Promise<EffectLease | null>;
  heartbeat(lease: LeaseProof): Promise<{ ok: true }>;
  /** Acceptance only: no cash entry, no bill-paid effect, no reservation release. */
  complete(args: LeaseProof & { providerTransferId: string }): Promise<{ ok: true }>;
  fail(args: LeaseProof & DispatchFailure): Promise<{ execution: "unknown" | "exception"; nextAttemptAt: number }>;
}
