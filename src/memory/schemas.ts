import { z } from "zod";

// Every file in company memory has a schema. Writes that don't validate are rejected,
// so memory can't drift into contradicting free text.

const cents = z.number().int();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const RemitTo = z.object({
  bank: z.string(),
  accountLast4: z.string().regex(/^\d{4}$/),
  verifiedOn: date,
  verifiedBy: z.string(),
  method: z.enum(["onboarding", "callback_known_number", "crs_verified"]),
});

export const Vendor = z.object({
  id: z.string(),
  legalName: z.string(),
  category: z.enum(["produce", "protein", "dairy", "packaging", "beverage", "supplies", "facilities", "tech", "utilities", "landlord", "marketing", "services"]),
  expenseAccount: z.string(),
  termsNetDays: z.number().int().min(0),
  status: z.enum(["active", "blocked"]),
  remitTo: RemitTo,
  contacts: z.array(z.object({ name: z.string(), email: z.string(), phone: z.string(), source: z.string() })),
  contractPrices: z.array(
    z.object({ sku: z.string(), description: z.string(), unitCents: cents, uom: z.string(), effectiveFrom: date, effectiveTo: date.optional() }),
  ),
  credits: z.array(
    z.object({ id: z.string(), amountCents: cents, reason: z.string(), issuedOn: date, appliedTo: z.string().optional() }),
  ),
  notes: z.array(z.object({ on: date, by: z.string(), text: z.string() })),
});
export type Vendor = z.infer<typeof Vendor>;

export const Store = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string(),
  openedOn: date,
  lease: z.object({
    landlord: z.string(),
    baseRentCents: cents,
    camCapCents: cents,
    startDate: date,
    endDate: date,
  }),
  cardProcessor: z.object({ name: z.string(), contractedRateBps: z.number().int(), perTxnCents: cents }),
  deliveryPlatforms: z.array(z.object({ platform: z.string(), storeRef: z.string(), commissionBps: z.number().int() })),
});
export type Store = z.infer<typeof Store>;

export const ApprovalLimits = z
  .object({
    autoApproveCents: cents,
    dualApprovalCents: cents,
    humanApprovalCents: cents,
  })
  .refine((p) => p.autoApproveCents <= p.dualApprovalCents && p.dualApprovalCents <= p.humanApprovalCents, {
    message: "limits must satisfy auto <= dual <= human",
  });

export const Materiality = z.object({
  priceVarianceBps: z.number().int(), // allowed unit price variance vs contract
  quantityToleranceUnits: z.number(),
  payoutToleranceCents: cents,
  bankMatchToleranceCents: cents,
});

export const PaymentsPolicy = z.object({
  remitChangeRequires: z.array(z.enum(["callback_known_number", "crs_check", "controller_approval", "cooling_off_days"])),
  coolingOffDays: z.number().int(),
  paymentRunDaysBeforeDue: z.number().int(),
});

export const Person = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  seat: z.string(),
  authority: z.array(z.string()),
});

export const SeatDef = z.object({
  id: z.string(),
  role: z.string(),
  name: z.string(),
  reportsTo: z.string().optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  mandate: z.string(),
});

export const Playbook = z.object({
  role: z.string(),
  version: z.number().int(),
  steps: z.array(z.object({ id: z.string(), when: z.string(), do: z.string(), checks: z.array(z.string()) })),
  escalate: z.array(z.object({ condition: z.string(), to: z.string() })),
});

export const Fact = z.object({
  key: z.string(),
  value: z.unknown(),
  source: z.object({ kind: z.enum(["event", "memory", "ledger", "ask", "external"]), ref: z.string(), sha: z.string().optional() }),
});

export const Decision = z.object({
  id: z.string(),
  on: date,
  seat: z.string(),
  task: z.string().optional(),
  kind: z.string(),
  subject: z.object({ type: z.string(), id: z.string() }),
  outcome: z.enum(["act", "ask", "hold", "reject"]),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  facts: z.array(Fact),
  rules: z.array(z.object({ path: z.string(), key: z.string() })),
  amountCents: cents.optional(),
  model: z.string().optional(),
});
export type Decision = z.infer<typeof Decision>;

export const Company = z.object({
  id: z.string(),
  legalName: z.string(),
  ticker: z.string(),
  fiscalYearEnd: z.string(),
  calibration: z.record(z.string(), z.object({ value: z.number(), unit: z.string(), source: z.string() })),
  disclaimer: z.string(),
});

/** Which schema governs a path. Unknown paths are rejected. */
export function schemaFor(path: string): z.ZodType | null {
  if (path === "company.yaml") return Company;
  if (path === "policies/approval-limits.yaml") return ApprovalLimits;
  if (path === "policies/materiality.yaml") return Materiality;
  if (path === "policies/payments.yaml") return PaymentsPolicy;
  if (/^vendors\/[a-z0-9-]+\.yaml$/.test(path)) return Vendor;
  if (/^stores\/[a-z0-9-]+\.yaml$/.test(path)) return Store;
  if (/^people\/[a-z0-9-]+\.yaml$/.test(path)) return Person;
  if (/^seats\/[a-z0-9-]+\.yaml$/.test(path)) return SeatDef;
  if (/^playbooks\/[a-z0-9_-]+\.yaml$/.test(path)) return Playbook;
  if (/^decisions\/\d{4}-\d{2}\/[a-zA-Z0-9_.-]+\.yaml$/.test(path)) return Decision;
  return null;
}

/**
 * Controlled changes need a proposal branch and a different seat's merge.
 * Returns a reason if the change from `before` to `after` is controlled.
 */
export function controlledReason(path: string, before: unknown, after: unknown): string | null {
  if (path.startsWith("policies/") || path.startsWith("seats/") || path.startsWith("people/") || path.startsWith("playbooks/")) {
    return before === undefined && path.startsWith("playbooks/") ? null : `${path.split("/")[0]} changes require approval`;
  }
  if (path.startsWith("vendors/") && before !== undefined) {
    const b = before as Vendor;
    const a = after as Vendor;
    const fields: (keyof Vendor)[] = ["remitTo", "contractPrices", "status", "termsNetDays", "expenseAccount", "legalName"];
    const changed = fields.filter((f) => JSON.stringify(b[f]) !== JSON.stringify(a[f]));
    if (changed.length) return `vendor ${changed.join(", ")} changes require approval`;
  }
  if (path.startsWith("stores/") && before !== undefined) return "store master data changes require approval";
  return null;
}
