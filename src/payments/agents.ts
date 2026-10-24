import { api } from "../../convex/_generated/api";
import type { BankScope } from "../integrations/contracts";
import type { KernelTransport } from "./adapters/convex-transport";
import { createConvexPaymentCommands } from "./adapters/convex-payment-commands";
import { createPaymentCommandService } from "./application/payment-commands";
import type { PaymentCommands } from "./ports/payment-kernel";
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
  private readonly commands: PaymentCommands;
  constructor(private readonly kernel: KernelTransport, private readonly auth: {scope: BankScope; seatId: string; token: string}) {
    this.commands = createPaymentCommandService(createConvexPaymentCommands(kernel, auth.scope, { kind: "agent", seatId: auth.seatId, token: auth.token }));
  }
  requestPayment(billIds: Id<"demoBills">[], requestKey: string) {
    return this.commands.requestPayment({ commandId: requestKey, command: { type: "RequestPayment", billIds, credits: [] } });
  }
  getPaymentStatus() { return this.kernel.query(api.demoPayments.view, this.auth); }
}
