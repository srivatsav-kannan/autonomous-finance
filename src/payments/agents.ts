import { api } from "../../convex/_generated/api";
import type { BankScope } from "../integrations/contracts";
import type { KernelTransport } from "./evidence";
import type { Id } from "../../convex/_generated/dataModel";

/** Narrow demo agent handles: no bank, service token, human credential, or simulator controls. */
export class DemoAPAgent {
  constructor(private readonly kernel: KernelTransport, private readonly auth: {scope: BankScope; seatId: string; token: string}) {}
  recordInvoice(input: {vendor: string; invoiceNumber: string; invoiceDate: string; originalCents: number; evidence: string[]}) {
    return this.kernel.mutation(api.demoPayments.recordBill, { ...this.auth, ...input, expenseAccount: "5000" });
  }
  attachEvidence(billId: Id<"demoBills">, evidence: string) { return this.kernel.mutation(api.demoPayments.attachEvidence, { ...this.auth, billId, evidence }); }
  flagDiscrepancy(billId: Id<"demoBills">, reason: string) { return this.kernel.mutation(api.demoPayments.flagException, { ...this.auth, billId, reason }); }
}
export class DemoPaymentsAgent {
  constructor(private readonly kernel: KernelTransport, private readonly auth: {scope: BankScope; seatId: string; token: string}) {}
  requestPayment(billIds: Id<"demoBills">[], requestKey: string) { return this.kernel.mutation(api.demoPayments.requestPayment, { ...this.auth, billIds, requestKey, credits: [] }); }
  getPaymentStatus() { return this.kernel.query(api.demoPayments.view, this.auth); }
}
