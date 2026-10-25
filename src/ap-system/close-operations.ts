/** Browser-safe close requests. Scope, credentials and original file metadata stay server-owned. */
import {z} from "zod";
import type {CostState} from "./cost-contracts";
import {sourceBindingSchema,type SourceDocument} from "./contracts";
import {periodSchema,statementSchema,statementReviewSchema,closeProposalSchema,closeVoteSchema,type PeriodView,type CloseAction,type SupplierStatement,type StatementReview} from "./close-contracts";
import type {ApprovalStep} from "./domain-contracts";
const id=z.string().trim().min(1).max(240);
export const closeOperationSchemas={
 retainEvidence:z.object({source:sourceBindingSchema.strict()}).strict(),
 proposeStatement:z.object({idempotencyKey:id,statement:statementSchema}).strict(),
 reviewStatement:statementReviewSchema.strict(),
 propose:closeProposalSchema.strict(),
 vote:closeVoteSchema.strict(),
};
export {periodSchema};
export type CloseOperation=keyof typeof closeOperationSchemas;
export type CloseInputs={[K in CloseOperation]:z.infer<(typeof closeOperationSchemas)[K]>};
export type CloseActionRecord={_id:string;kind:CloseAction["kind"];payload:CloseAction;hash:string;amountCents:number;route:ApprovalStep[];stage:number;votes:{subject:string;principal:string;groupId:string;stage:number;at:number;delegationId:string|null}[];status:string;proposedBy:string;createdAt:number;approvedBy?:string;entryId?:string;result?:Record<string,unknown>};
export type CloseView=PeriodView&{controllerProposalAvailable:boolean;retainedSources:Pick<SourceDocument,"sourceId"|"revision"|"sha256"|"name"|"kind"|"pageStatus">[];actions:CloseActionRecord[];statementRecords:{_id:string;payload:SupplierStatement;hash:string;status:string;review?:StatementReview;reviewedBy?:string;reviewedAt?:number}[]};
export type CloseOperations={costState:(originalEntryId:string)=>Promise<CostState>;view:(period:string)=>Promise<CloseView>;execute:<K extends CloseOperation>(operation:K,input:CloseInputs[K])=>Promise<unknown>};
