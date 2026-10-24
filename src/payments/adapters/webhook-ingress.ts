import { createHash } from "node:crypto";
import { sameBankScope, type BankScope } from "../contracts";
import type { EvidenceWebhookVerifier, PaymentEvidence } from "../ports/payment-evidence";

/** Authenticate exact bytes and durably ingest the hint before the caller sends HTTP 2xx. */
export async function receiveBankNotice(evidence: PaymentEvidence, scope: BankScope,
  rawBody: Uint8Array, headers: Record<string, string>, verifier: EvidenceWebhookVerifier) {
  const event = await verifier.verifyWebhook(rawBody, headers);
  if (!sameBankScope(event.scope, scope)) throw new Error("Webhook subscription scope mismatch");
  return evidence.ingestNotice({ eventId: event.id, transferId: event.transferId, transactionId: event.transactionId,
    bodyHash: createHash("sha256").update(rawBody).digest("hex") });
}
