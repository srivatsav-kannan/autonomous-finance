import { makeFunctionReference } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";
import type { BankScope } from "../payments/contracts";
export type APCasePaymentBinding={caseId:string;expectedRevision:number;snapshotHash:string};
/** Uses the original scoped AP payment engine. Clients select an explicit allocation/date; backend bounds amounts and resolves the trusted beneficiary. */
export function createAPCasePayments(agent:ConvexHttpClient,human:ConvexHttpClient,scope:BankScope,credential:{seatId:string;token:string}) {
  return {
    request:(input:APCasePaymentBinding&{idempotencyKey:string;executionDate?:string;amountCents?:number;credits?:{creditId:string;amountCents:number}[]})=>agent.mutation(makeFunctionReference<"mutation">("apCasePayments:request"),{scope,...credential,...input}) as Promise<{versionId:string;snapshotHash:string}>,
    authorize:(input:APCasePaymentBinding&{versionId:string;paymentSnapshotHash:string})=>human.mutation(makeFunctionReference<"mutation">("apCasePayments:authorize"),{scope,...input}) as Promise<{commandId:string}>,
    cancel:(input:APCasePaymentBinding&{versionId:string})=>human.mutation(makeFunctionReference<"mutation">("apCasePayments:cancel"),{scope,...input}) as Promise<{ok:true}>,
    detail:(versionId:string)=>human.query(makeFunctionReference<"query">("apCasePayments:detail"),{scope,versionId}),
  };
}
