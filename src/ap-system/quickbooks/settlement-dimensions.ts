import {
  assertAccountingBindingCoverage,
  paymentAccountingBindingSchema,
  type PaymentAccountingBinding,
} from "../../payments/domain/accounting-binding";
import type {
  AccountingExport,
  Mappings,
  RecognizedInvoice,
  RecognizedCredit,
} from "./types";
import { documentDimensions } from "./dimensions";
import { hash, QboError } from "./private-store";
export function bindingLocation(
  binding: PaymentAccountingBinding | undefined,
  m: Mappings,
) {
  if (!binding) return {};
  if (!paymentAccountingBindingSchema.safeParse(binding).success)
    throw new QboError("settlement_accounting_binding_invalid");
  return documentDimensions(
    [{ store: null, department: binding.department, project: null }],
    m,
  );
}
function checkRecognition(
  r: RecognizedInvoice | RecognizedCredit,
  b:
    | PaymentAccountingBinding["bills"][number]
    | PaymentAccountingBinding["credits"][number],
  binding: PaymentAccountingBinding,
) {
  const a = r.settlementAuthority;
  if (
    !a ||
    a.version !== "ap-settlement-dimensions-v1" ||
    a.mode !== binding.mode ||
    a.department !== binding.department ||
    b.recognitionEntryId !== r.journalId ||
    b.approvalId !== r.approvalId ||
    b.approvalHash !== a.approvalHash ||
    b.policyHash !== a.policyHash ||
    b.accountingAuthorityHash !==
      hash({
        caseId: r.caseId,
        billId: r.billId,
        creditId: r.creditId,
        supplierId: r.supplierId,
        currency: "USD",
        amountCents: r.amountCents,
        settlementAuthority: a,
      })
  )
    throw new QboError("settlement_accounting_binding_invalid");
}
/** Receives only authenticated immutable exports, never a caller's department preference. */
export function settlementLocation(e: AccountingExport, m: Mappings) {
  const app = e.settlement ?? e.creditApplication;
  if (!app) throw new QboError("settlement_accounting_binding_invalid");
  const r = e.recognizedInvoice,
    credits = app.credits ?? [],
    binding = app.accountingBinding;
  if (!binding) {
    if (
      r?.settlementAuthority ||
      r?.allocations.some((a) => a.department != null) ||
      credits.some(
        (c) =>
          c.recognition.settlementAuthority ||
          c.recognition.allocations.some((a) => a.department != null),
      )
    )
      throw new QboError("department_settlement_authority_required");
    return {};
  }
  if (!r) throw new QboError("settlement_accounting_binding_invalid");
  const amount = e.settlement
    ? (e.settlement.grossAppliedCents ?? e.settlement.amountCents)
    : e.creditApplication!.amountCents;
  try {
    assertAccountingBindingCoverage({
      bills: [{ billId: r.billId, amountCents: amount }],
      credits: credits.map((c) => ({
        creditId: c.recognition.creditId,
        amountCents: c.amountCents,
      })),
      accountingBinding: binding,
    });
  } catch {
    throw new QboError("settlement_accounting_binding_invalid");
  }
  checkRecognition(r, binding.bills[0]!, binding);
  for (const c of credits) {
    if (c.recognition.supplierId !== r.supplierId)
      throw new QboError("settlement_accounting_binding_invalid");
    checkRecognition(
      c.recognition,
      binding.credits.find((b) => b.creditId === c.recognition.creditId)!,
      binding,
    );
  }
  return bindingLocation(binding, m);
}
