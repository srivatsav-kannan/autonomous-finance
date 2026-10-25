import type {z} from "zod";
import {domainVoteSchema,type ApprovalStep} from "./domain-contracts";
import {accountingCorrectionRequestSchema,type AccountingCorrectionRequest} from "./quickbooks/corrections";
import type {BankReturnEvidence,PaymentAllocationEvidence} from "./quickbooks/types";
export {accountingCorrectionRequestSchema,domainVoteSchema};
export type CorrectionVote=z.infer<typeof domainVoteSchema>;
export type CorrectionProposal={_id:string;caseId:string;request:AccountingCorrectionRequest;payload:BankReturnEvidence|PaymentAllocationEvidence;hash:string;amountCents:number;route:ApprovalStep[];stage:number;votes:{subject:string;principal:string;groupId:string;stage:number;at:number;delegationId:string|null}[];status:"pending"|"approved"|"rejected";proposedBy:string;createdAt:number;completedAt?:number};
export type CorrectionView={proposals:CorrectionProposal[];controllerProposalAvailable:boolean};
export type CorrectionOperations={list:(caseId:string)=>Promise<CorrectionView>;propose:(input:AccountingCorrectionRequest)=>Promise<unknown>;vote:(caseId:string,input:CorrectionVote)=>Promise<unknown>};
