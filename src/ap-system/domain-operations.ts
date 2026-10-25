/** Public operation models; caller identity and scope are deliberately absent. */
import { z } from "zod";
import { contactOriginSchema, type ContactOrigin } from "./supplier-contact-contracts";
import { sourceBindingSchema } from "./contracts";
import { businessPolicySchema, supplierProposalSchema, supplierVerificationSchema, domainRequestSchema, domainVoteSchema, delegationSchema, type BusinessPolicy, type SupplierProposal, type SupplierVerification, type Delegation, type DomainRequest, type ApprovalStep } from "./domain-contracts";
const id=z.string().trim().min(1).max(240),reason=id,hash=z.string().regex(/^[a-f0-9]{64}$/),key={idempotencyKey:id};
export const domainOperationSchemas={
 propose:domainRequestSchema,
 vote:domainVoteSchema,
 applyCredits:z.object({caseId:id,expectedRevision:z.number().int().positive(),snapshotHash:hash,billVersion:z.number().int().positive(),...key,reason,credits:z.array(z.object({creditId:id,amountCents:z.number().int().positive().safe()}).strict()).min(1).max(100).refine(items=>new Set(items.map(i=>i.creditId)).size===items.length)}).strict(),
 proposePolicy:z.object({...key,policy:businessPolicySchema}).strict(),
 activatePolicy:z.object({policyId:id,expectedHash:hash,reason}).strict(),
 registerTrustedContact:z.object({...key,supplierId:id,phone:z.string().regex(/^\+[1-9]\d{7,14}$/),evidence:z.array(sourceBindingSchema).min(1),mode:z.enum(["simulated","operator_recorded"]),origin:contactOriginSchema.optional()}).strict(),
 proposeSupplier:z.object({...key,proposal:supplierProposalSchema}).strict(),
 verifySupplier:z.object({revisionId:id,verification:supplierVerificationSchema}).strict(),
 approveSupplier:z.object({revisionId:id,expectedHash:hash,reason}).strict(),
 delegate:z.object({...key,delegation:delegationSchema}).strict(),
 revokeDelegation:z.object({delegationId:id,reason}).strict(),
};
export type DomainOperation=keyof typeof domainOperationSchemas;
export type DomainInputs={ [K in DomainOperation]:z.infer<(typeof domainOperationSchemas)[K]> };
export type GovernanceView={
 policies:{_id:string;version:string;hash:string;policy:BusinessPolicy;status:string;proposedBy:string;approvedBy?:string;createdAt:number;approvedAt?:number}[];
 suppliers:{_id:string;supplierId:string;activeRevision?:number;createdAt:number}[];
 revisions:{_id:string;supplierId:string;revision:number;proposal:SupplierProposal;hash:string;status:string;proposedBy:string;verification?:SupplierVerification;verifiedBy?:string;approvedBy?:string;createdAt:number}[];
 contacts:{_id:string;supplierId:string;phone:string;evidence:z.infer<typeof sourceBindingSchema>[];mode:"simulated"|"operator_recorded";recordedBy:string;recordedSeatId?:string;origin?:ContactOrigin;createdAt:number}[];
 delegations:{_id:string;grantor:string;delegation:Delegation;revokedAt?:number;createdAt:number}[];
 controllerProposalAvailable:boolean;
};
export type BusinessProposal={_id:string;caseId:string;request:DomainRequest;hash:string;amountCents:number;route:ApprovalStep[];stage:number;stageStartedAt:number;votes:{subject:string;principal:string;groupId:string;stage:number;at:number;delegationId:string|null}[];status:string;proposedBy:string;createdAt:number};
export type DomainOperations={view:()=>Promise<GovernanceView>;proposals:()=>Promise<BusinessProposal[]>;execute:<K extends DomainOperation>(operation:K,input:DomainInputs[K])=>Promise<unknown>};
