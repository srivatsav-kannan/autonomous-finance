/** Read models shared by the AP HTTP boundary and console. No provider secrets. */
import type { BankScope, PaymentApproval, PaymentSnapshot, PaymentStatus } from "../payments/contracts";
import type { QBOBridge, QBOStatus } from "./quickbooks/runtime";
export type PaymentRunSelection={caseId:string;expectedRevision:number;snapshotHash:string;amountCents?:number;credits?:{creditId:string;amountCents:number}[]};
export type PaymentRunRequest={requestKey:string;selection:PaymentRunSelection[];executionDate?:string};
export type PaymentRunSummary={runId:string;snapshotHash:string;caseIds:string[];executionDate:string|null;createdAt:number};
export type PaymentRunDetail={runId:string;scope:BankScope;requestedBy:string;snapshotHash:string;executionDate:string|null;createdAt:number;items:{caseId:string;caseRevision:number;caseSnapshotHash:string;versionId:string;paymentSnapshotHash:string;payment:{snapshot:PaymentSnapshot;snapshotHash:string;status:PaymentStatus;approvals:PaymentApproval[]}|null}[]};
export type PaymentRunOperations={list:()=>Promise<PaymentRunSummary[]>;detail:(runId:string)=>Promise<PaymentRunDetail>;prepare:(input:PaymentRunRequest)=>Promise<{runId:string;snapshotHash:string}>;authorize:(input:{runId:string;snapshotHash:string})=>Promise<{commandIds:string[]}>;cancel:(input:{runId:string;snapshotHash:string})=>Promise<{ok:true}>};
export type AccountingStatus=QBOStatus&{externalWritesAllowed:boolean};
export type AccountingOperations=Omit<QBOBridge,"status">&{status:(caseId:string)=>Promise<AccountingStatus>};
