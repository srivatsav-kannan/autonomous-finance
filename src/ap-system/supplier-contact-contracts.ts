import { z } from "zod";
import { sourceBindingSchema } from "./contracts";
const id = z.string().trim().min(1).max(240);
const reason = z.string().trim().min(1).max(2000);
const evidence = z.array(sourceBindingSchema).min(1).max(20);
const timestamp = z.number().int().nonnegative();
/** This is an operator's source attestation, never a claim that this software contacted anyone. */
export const contactOriginSchema = z
  .object({
    kind: z.enum([
      "preexisting_vendor_master",
      "independent_registry",
      "executed_agreement",
    ]),
    acquiredAt: timestamp,
    description: reason,
  })
  .strict();
export const contactChangeProposalSchema = z
  .object({
    supplierId: id,
    expectedRevision: z.number().int().positive(),
    oldContactId: id,
    newContactId: id,
    resolution: z.enum(["replace", "retain_current"]),
    supersedesChangeId: id.optional(),
    oldChannel: z
      .object({
        status: z.enum(["available", "unavailable"]),
        evidence,
        reason,
      })
      .strict(),
    reason,
  })
  .strict()
  .superRefine((p, ctx) => {
    if (
      (p.resolution === "retain_current") !==
      (p.oldContactId === p.newContactId)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Replacement needs a different contact; restoration must retain the existing contact",
      });
  });
export const contactChangeAttestationSchema = z
  .object({
    method: z.enum(["old_channel_confirmation", "independent_reestablishment"]),
    performedAt: timestamp,
    evidence,
    mode: z.enum(["simulated", "operator_recorded"]),
    reason,
  })
  .strict();
export const contactChangeDecisionSchema = z
  .object({
    changeId: id,
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum(["approved", "rejected"]),
    reason,
  })
  .strict();
export type ContactOrigin = z.infer<typeof contactOriginSchema>;
export type ContactChangeProposal = z.infer<typeof contactChangeProposalSchema>;
export type ContactChangeAttestation = z.infer<
  typeof contactChangeAttestationSchema
>;
export type ContactChangeDecision = z.infer<typeof contactChangeDecisionSchema>;
export type ContactChangeReview = ContactChangeAttestation & {
  subject: string;
  seatId: string;
  recordedAt: number;
};
export type ContactChangeView = {
  changeId: string;
  supplierId: string;
  proposal: ContactChangeProposal;
  hash: string;
  policyHash: string;
  supplierHash: string;
  proposedBy: string;
  status: "proposed" | "rejected" | "approved" | "superseded";
  createdAt: number;
  verification: ContactChangeReview | null;
  escalation: ContactChangeReview | null;
  decision: {
    subject: string;
    seatId: string;
    outcome: "approved" | "rejected";
    reason: string;
    recordedAt: number;
  } | null;
};
export type SupplierContactView = {
  changes: ContactChangeView[];
  suppliers: {
    supplierId: string;
    activeRevision: number | null;
    contactReviewId: string | null;
    contactAuthorityId: string | null;
  }[];
  contacts: {
    contactId: string;
    supplierId: string;
    phone: string;
    evidence: z.infer<typeof sourceBindingSchema>[];
    origin: ContactOrigin | null;
    recordedBy: string;
    recordedSeatId: string | null;
    mode: string;
    createdAt: number;
  }[];
};

/** Browser transport omits actor/scope; the service supplies the current session or controller credential. */
const reviewRequest = z
  .object({
    changeId: id,
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    attestation: contactChangeAttestationSchema,
  })
  .strict();
export const contactChangeOperationSchemas = {
  propose: z
    .object({ idempotencyKey: id, proposal: contactChangeProposalSchema })
    .strict(),
  verify: reviewRequest,
  escalate: reviewRequest,
  decide: contactChangeDecisionSchema,
};
export type ContactChangeOperation = keyof typeof contactChangeOperationSchemas;
export type ContactChangeInputs = {
  [K in ContactChangeOperation]: z.infer<
    (typeof contactChangeOperationSchemas)[K]
  >;
};
