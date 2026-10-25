import { z } from "zod";
import { makeFunctionReference } from "convex/server";
import type { KernelTransport } from "../payments/adapters/convex-transport";
import type { BankScope } from "../payments/contracts";
import { caseDetailSchema } from "../ap-system/contracts";

export const apAgentToolSchemas = {
  inspect_case: z.object({ caseId: z.string().min(1) }).strict(),
  advance_case: z
    .object({
      caseId: z.string().min(1),
      generation: z.number().int().positive(),
    })
    .strict(),
};
export type APAgentCredential = { seatId: string; token: string };
/** Deliberate narrow registry. No human authorization, role switch, provider dispatch or arbitrary RPC. */
export function createAPCaseAgentTools(
  client: KernelTransport,
  scope: BankScope,
  credential: APAgentCredential,
) {
  const auth = { scope, ...credential };
  return {
    async inspect_case(input: z.input<typeof apAgentToolSchemas.inspect_case>) {
      const data = await client.query(
        makeFunctionReference<"query">("apCaseAgent:inspect"),
        { ...auth, ...apAgentToolSchemas.inspect_case.parse(input) },
      );
      return { ...data, detail: caseDetailSchema.parse(data.detail) };
    },
    async advance_case(input: z.input<typeof apAgentToolSchemas.advance_case>) {
      return client.mutation(
        makeFunctionReference<"mutation">("apCaseAgent:advance"),
        { ...auth, ...apAgentToolSchemas.advance_case.parse(input) },
      );
    },
  };
}
