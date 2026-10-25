import { z } from "zod";
import { canonicalJson } from "../../integrations/contracts";
const id = z.string().min(1).max(240),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const cents = z
  .number()
  .refine(Number.isSafeInteger)
  .refine((n) => n > 0);
const authority = {
  recognitionEntryId: id,
  approvalId: id,
  approvalHash: digest,
  policyHash: digest,
  accountingAuthorityHash: digest,
  appliedCents: cents,
};
export const paymentAccountingBindingSchema = z
  .object({
    version: z.literal("ap-payment-accounting-v1"),
    mode: z.literal("department_as_location"),
    department: id.nullable(),
    bills: z
      .array(z.object({ billId: id, ...authority }).strict())
      .min(1)
      .max(100),
    credits: z
      .array(z.object({ creditId: id, ...authority }).strict())
      .max(100),
  })
  .strict();
export type PaymentAccountingBinding = z.infer<
  typeof paymentAccountingBindingSchema
>;
export type BindingSnapshot = {
  bills: readonly { billId: string; amountCents: number }[];
  credits: readonly { creditId: string; amountCents: number }[];
  accountingBinding?: PaymentAccountingBinding;
};
/** Exact IDs/amounts, no partial binding or implicit split. Hashing is also checked at the trusted boundary. */
export function assertAccountingBindingCoverage(snapshot: BindingSnapshot) {
  const value = snapshot.accountingBinding;
  if (!value) return;
  paymentAccountingBindingSchema.parse(value);
  for (const kind of ["bills", "credits"] as const) {
    const key = kind === "bills" ? "billId" : "creditId";
    const rows = value[kind] as Array<Record<string, unknown>>;
    const selected = snapshot[kind] as unknown as Array<
      Record<string, unknown>
    >;
    if (
      rows.length !== selected.length ||
      new Set(rows.map((r) => r[key])).size !== rows.length ||
      selected.some(
        (s) =>
          !rows.some(
            (r) => r[key] === s[key] && r.appliedCents === s.amountCents,
          ),
      )
    )
      throw Error("accounting_binding_coverage_mismatch");
  }
}
export async function accountingBindingHash(binding: PaymentAccountingBinding) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(binding)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function assertCommandAccountingBinding(
  snapshot: BindingSnapshot,
  command: { accountingBindingHash?: string },
) {
  assertAccountingBindingCoverage(snapshot);
  const expected = snapshot.accountingBinding
    ? await accountingBindingHash(snapshot.accountingBinding)
    : undefined;
  if (command.accountingBindingHash !== expected)
    throw Error("command_accounting_binding_mismatch");
}
export function settlementPostingLines(
  amount: number,
  returning: boolean,
  binding?: PaymentAccountingBinding,
) {
  const dims = binding?.department
    ? { dims: { department: binding.department } }
    : {};
  return returning
    ? [
        { account: "1000", debit: amount, credit: 0, ...dims },
        { account: "2000", debit: 0, credit: amount, ...dims },
      ]
    : [
        { account: "2000", debit: amount, credit: 0, ...dims },
        { account: "1000", debit: 0, credit: amount, ...dims },
      ];
}
