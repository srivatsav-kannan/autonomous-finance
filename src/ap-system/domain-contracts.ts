import { z } from "zod";

export const AP_BUSINESS_VERSION = "ap-business-v1" as const;
const id = z.string().trim().min(1).max(240);
const cents = z.number().int().safe().nonnegative();
const qty = z.string().regex(/^\d+(\.\d{1,6})?$/);
const timestamp = z.number().int().nonnegative();
const binding = z.object({
  sourceId: id,
  revision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const allocation = z.object({
  account: id,
  amountCents: cents,
  store: z.string().nullable(),
  department: z.string().nullable(),
  project: z.string().nullable(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  treatment: z.enum([
    "expense",
    "inventory",
    "fixed_asset",
    "prepayment",
    "tax",
  ]),
});
export const approvalStepSchema = z.object({
  groupId: id,
  quorum: z.number().int().min(1).max(20),
  escalateAfterMs: z.number().int().min(60_000),
  escalationGroupId: id.nullable(),
});
export const businessPolicySchema = z
  .object({
    version: id,
    groups: z
      .array(z.object({ groupId: id, members: z.array(id).min(1) }))
      .min(1),
    supplierVerificationGroup: id,
    supplierApprovalGroup: id,
    varianceApprovalGroup: id,
    bands: z
      .array(
        z.object({
          upToCents: cents,
          steps: z.array(approvalStepSchema).min(1),
        }),
      )
      .min(1),
    accounts: z
      .array(z.object({ account: id, treatment: allocation.shape.treatment }))
      .min(1),
    stores: z.array(id),
    taxCodes: z
      .array(
        z.object({
          code: id,
          mode: z.enum(["none", "nonrecoverable", "recoverable"]),
        }),
      )
      .min(1),
    maxPriceVarianceBps: z.number().int().min(0).max(10_000),
    maxDelegationMs: z
      .number()
      .int()
      .min(60_000)
      .max(366 * 24 * 60 * 60_000),
  })
  .superRefine((p, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const groups = new Set(p.groups.map((g) => g.groupId));
    if (
      groups.size !== p.groups.length ||
      p.groups.some((g) => new Set(g.members).size !== g.members.length)
    )
      fail("Duplicate approval group/member");
    for (const group of [
      p.supplierVerificationGroup,
      p.supplierApprovalGroup,
      p.varianceApprovalGroup,
      ...p.bands.flatMap((b) =>
        b.steps.flatMap((s) => [
          s.groupId,
          ...(s.escalationGroupId ? [s.escalationGroupId] : []),
        ]),
      ),
    ])
      if (!groups.has(group)) fail("Unknown configured approval group");
    if (
      p.bands.some(
        (b, i) => i > 0 && b.upToCents <= p.bands[i - 1]!.upToCents,
      ) ||
      p.bands.at(-1)!.upToCents !== Number.MAX_SAFE_INTEGER
    )
      fail(
        "Approval thresholds must increase and cover every safe-cent amount",
      );
    for (const b of p.bands)
      for (const s of b.steps)
        if (
          p.groups.find((g) => g.groupId === s.groupId)!.members.length <
            s.quorum ||
          (s.escalationGroupId &&
            p.groups.find((g) => g.groupId === s.escalationGroupId)!.members
              .length < s.quorum)
        )
          fail("Approval group cannot satisfy quorum");
    if (
      new Set(p.accounts.map((a) => a.account)).size !== p.accounts.length ||
      new Set(p.taxCodes.map((t) => t.code)).size !== p.taxCodes.length
    )
      fail("Duplicate account or tax code");
  });
export const supplierProposalSchema = z
  .object({
    supplierId: id,
    legalName: id,
    aliases: z.array(id),
    contactId: id,
    expectedRevision: z.number().int().nonnegative(),
    externalAccountId: id,
    currency: z.string().regex(/^[A-Z]{3}$/),
    catalog: z
      .array(z.object({ sku: id, unit: id, unitPriceCents: cents }))
      .min(1),
    evidence: z.array(binding).min(1),
    reason: id,
  })
  .superRefine((s, ctx) => {
    if (new Set(s.catalog.map((c) => c.sku)).size !== s.catalog.length)
      ctx.addIssue({ code: "custom", message: "Duplicate supplier SKU" });
  });
export const supplierVerificationSchema = z.object({
  contactId: id,
  method: z.literal("callback_previously_held_contact"),
  result: z.enum(["confirmed", "rejected"]),
  performedAt: timestamp,
  evidence: z.array(binding).min(1),
  mode: z.enum(["simulated", "operator_recorded"]),
  reason: id,
});
export const receiptClaimSchema = z.object({
  source: binding,
  lineId: id,
  quantity: qty,
});
export const acceptedLineSchema = z.object({
  lineId: id,
  quantity: qty,
  netCents: cents,
  taxCents: cents,
  taxCode: id,
  allocations: z.array(allocation),
  procurement: z.enum(["po", "non_po"]),
  agreement: z.object({ source: binding, lineId: id }).nullable(),
  receipts: z.array(receiptClaimSchema),
});
export const businessAcceptanceSchema = z.object({
  lines: z.array(acceptedLineSchema).min(1),
  freightCents: cents,
  freightAllocations: z.array(allocation),
  discountCents: cents,
  discountAllocations: z.array(allocation),
  reason: id,
  resolutions: z.array(
    z.object({
      code: z.literal("price_variance"),
      lineId: id,
      reason: id,
      evidence: z.array(binding).min(1),
    }),
  ),
});
export const creditPlanSchema = z.object({
  originalCaseId: id,
  originalApprovalId: id,
  freightCents: cents.default(0),
  discountCents: cents.default(0),
  lines: z
    .array(
      z.object({
        creditLineId: id,
        originalLineId: id,
        basis: z.enum([
          "quantity_return",
          "price_adjustment",
          "tax_adjustment",
        ]),
        quantity: qty,
        netCents: cents,
        taxCents: cents,
        returnEvidence: z.array(binding),
      }),
    )
    .min(1),
  reason: id,
});
export const domainRequestSchema = z
  .object({
    caseId: id,
    expectedRevision: z.number().int().positive(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: id,
    policyVersion: id,
    supplierRevision: z.number().int().positive(),
    acceptance: businessAcceptanceSchema.optional(),
    credit: creditPlanSchema.optional(),
  })
  .refine(
    (r) => Number(!!r.acceptance) + Number(!!r.credit) === 1,
    "Choose exactly one invoice acceptance or linked credit plan",
  );
export const domainVoteSchema = z.object({
  proposalId: id,
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: id,
  outcome: z.enum(["approved", "rejected"]),
  reason: id,
  delegationId: id.optional(),
});
export const delegationSchema = z
  .object({
    groupId: id,
    toSubject: id,
    maxCents: cents,
    validFrom: timestamp,
    validUntil: timestamp,
    reason: id,
  })
  .refine(
    (d) => d.validUntil > d.validFrom,
    "Delegation must expire after it starts",
  );
export const domainCaseProjectionSchema = z.object({
  policyVersion: id.nullable(),
  supplierId: id.nullable(),
  supplierRevision: z.number().int().positive().nullable(),
  approvalId: z.string().nullable(),
  approvalHash: z.string().nullable(),
  approvalStatus: z.enum([
    "not_proposed",
    "pending",
    "approved",
    "rejected",
    "stale",
  ]),
  route: z.array(approvalStepSchema),
  stage: z.number().int().nonnegative(),
  stageStartedAt: timestamp.nullable(),
  votes: z.array(
    z.object({
      subject: id,
      principal: id,
      groupId: id,
      stage: z.number().int().nonnegative(),
      at: timestamp,
      delegationId: z.string().nullable(),
    }),
  ),
  acceptance: businessAcceptanceSchema.nullable(),
  credit: creditPlanSchema.nullable(),
  creditApplications: z.array(z.object({applicationId:id,billId:id,creditId:id,amountCents:cents,actor:id,at:timestamp})).optional(),
  creditLinks: z.array(
    z.object({
      caseId: id,
      creditId: id,
      originalBillId: id,
      amountCents: cents,
      consumedCents: cents,
      reservedCents: cents,
      entryId: id,
    }),
  ),
  recognizedCents: cents,
  appliedCreditCents: cents,
  availableSupplierCreditCents: cents,
  cashSettledCents: cents,
});
export type BusinessPolicy = z.infer<typeof businessPolicySchema>;
export type SupplierProposal = z.infer<typeof supplierProposalSchema>;
export type SupplierVerification = z.infer<typeof supplierVerificationSchema>;
export type BusinessAcceptance = z.infer<typeof businessAcceptanceSchema>;
export type AcceptedLine = z.infer<typeof acceptedLineSchema>;
export type CreditPlan = z.infer<typeof creditPlanSchema>;
export type DomainRequest = z.infer<typeof domainRequestSchema>;
export type DomainVote = z.infer<typeof domainVoteSchema>;
export type DomainCaseProjection = z.infer<typeof domainCaseProjectionSchema>;
export type ApprovalStep = z.infer<typeof approvalStepSchema>;
export type Delegation = z.infer<typeof delegationSchema>;
