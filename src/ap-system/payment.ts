import { makeFunctionReference } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";
import type { BankScope } from "../payments/contracts";
export type APCasePaymentBinding={caseId:string;expectedRevision:number;snapshotHash:string};
/** Uses the original scoped AP payment engine. Clients cannot supply beneficiary or amount. */
export function createAPCasePayments(agent:ConvexHttpClient,human:ConvexHttpClient,scope:BankScope,credential:{seatId:string;token:string}) {
  return {
    request:(input:APCasePaymentBinding&{idempotencyKey:string})=>agent.mutation(makeFunctionReference<"mutation">("apCasePayments:request"),{scope,...credential,...input}) as Promise<{versionId:string;snapshotHash:string}>,
    authorize:(input:APCasePaymentBinding&{versionId:string;paymentSnapshotHash:string})=>human.mutation(makeFunctionReference<"mutation">("apCasePayments:authorize"),{scope,...input}) as Promise<{commandId:string}>,
    detail:(versionId:string)=>human.query(makeFunctionReference<"query">("apCasePayments:detail"),{scope,versionId}),
  };
}
