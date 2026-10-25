import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BankScope } from "../contracts";
import { parseBankScope } from "../domain/validation";
import type { PaymentCommands } from "../ports/payment-kernel";
import type { KernelTransport } from "./convex-transport";

export type PaymentActor = { kind: "agent"; seatId: string; token: string } | { kind: "human" };
/** Human clients must already carry their JWT. The server derives issuer|subject and seat. */
export function createConvexPaymentCommands(client: KernelTransport, binding: BankScope, actor: PaymentActor): PaymentCommands {
  const scope = parseBankScope(binding);
  const agent = () => {
    if (actor.kind !== "agent") throw new Error("Agent payment command credential required");
    return { scope, seatId: actor.seatId, token: actor.token };
  };
  const human = () => {
    if (actor.kind !== "human") throw new Error("Authenticated human payment client required");
    return { scope };
  };
  return {
    requestPayment: ({ commandId, command }) => client.mutation(api.demoPayments.requestPayment, {
      ...agent(), requestKey: commandId, billIds: command.billIds as Id<"demoBills">[],
      credits: command.credits.map(credit => ({ ...credit, creditId: credit.creditId as Id<"demoCredits"> })),
    }),
    approveWithinPolicy: ({ command }) => client.mutation(api.demoPayments.approveWithinPolicy, {
      ...agent(), versionId: command.versionId as Id<"demoVersions">, snapshotHash: command.snapshotHash,
    }),
    approveAndQueue: ({ command }) => client.mutation(api.demoPayments.approveAndQueue, {
      ...human(), versionId: command.versionId as Id<"demoVersions">, snapshotHash: command.snapshotHash,
    }),
    async cancel({ command }) { await client.mutation(api.demoPayments.cancel, { ...human(), versionId: command.versionId as Id<"demoVersions"> }); },
    async resume({ command }) { await client.mutation(api.demoPayments.resume, { ...human(), commandId: command.commandId as Id<"demoCommands">, reason: command.reason }); },
    async releaseUnsent({ command }) { await client.mutation(api.demoPayments.releaseUnsent, { ...human(),
      commandId: command.commandId as Id<"demoCommands">, reason: command.reason, providerCheck: command.providerCheck }); },
  };
}
