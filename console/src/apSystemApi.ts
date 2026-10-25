import type {TaxState} from "../../src/ap-system/tax-adjustment-contracts";
import {physicalLineOperationSchemas,type PhysicalLineInputs} from "../../src/ap-system/physical-line-contracts";
import type {PhysicalLineOperation,PhysicalLineWorkspaceView} from "../../src/ap-system/physical-line-operations";
import {contactChangeOperationSchemas,type ContactChangeOperation,type ContactChangeInputs} from "../../src/ap-system/supplier-contact-contracts";
import type {SupplierContactWorkspaceView} from "../../src/ap-system/supplier-contact-operations";
import type {OperationalTimings} from "../../src/ap-system/operational-timing";
import type {CostState} from "../../src/ap-system/cost-contracts";
import {closeOperationSchemas,periodSchema,type CloseOperation,type CloseInputs,type CloseView} from "../../src/ap-system/close-operations";
import {accountingCorrectionRequestSchema,domainVoteSchema,type CorrectionView,type CorrectionVote} from "../../src/ap-system/correction-operations";
import type {AccountingCorrectionRequest} from "../../src/ap-system/quickbooks/corrections";
import type {QBOPreview,QBOSubmit,QBOVerify} from "../../src/ap-system/quickbooks/runtime";
import {closeExportRequestSchema,type CloseExportRequest} from "../../src/ap-system/close-contracts";
import type {QBOCloseStatus,QBOClosePreview,QBOCloseSubmit,QBOCloseVerify} from "../../src/ap-system/quickbooks/close-runtime";
import { ZodError } from "zod";
import { domainOperationSchemas, type DomainOperation, type DomainInputs, type GovernanceView, type BusinessProposal } from "../../src/ap-system/domain-operations";
import { caseDetailSchema, type APCaseDetail, type BillApprovalRequest, type ReviewRequest, type SourceBinding, type SourceDocument } from "../../src/ap-system/contracts";
import type { PaymentApproval, PaymentSnapshot } from "../../src/payments/contracts";
import type { BankTransaction, TransferObservation } from "../../src/integrations/contracts";

import type { PaymentRunDetail, PaymentRunRequest, PaymentRunSummary, AccountingStatus } from "../../src/ap-system/workspace-operations";
import type { QBOReceipt } from "../../src/ap-system/quickbooks/runtime";
import type { CreditApplication, Plan } from "../../src/ap-system/quickbooks/types";
import { APSystemApiError, apProtectedFetch, closeAPSession } from "./apAuthSession";
export { APSystemApiError } from "./apAuthSession";
export type PaymentDetail = { snapshotHash: string; snapshot: PaymentSnapshot; approvals: PaymentApproval[]; observations: TransferObservation[]; transactions: BankTransaction[] };
const base = "/api/ap-system";
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  let assertCurrent: () => void;
  try {
    ({ response, assertCurrent } = await apProtectedFetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", signal: signal ?? AbortSignal.timeout(180_000),
      headers: body === undefined ? undefined : { "X-AP-System-Session": "1", ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    }));
  } catch (error) {
    if (signal?.aborted || error instanceof APSystemApiError || (error instanceof DOMException && error.name === "AbortError")) throw error;
    throw new APSystemApiError("The AP service could not be reached. Refresh to check the outcome, or retry the same action safely.", 0, "connection");
  }
  const data = await response.json().catch(() => null);
  assertCurrent();
  if (!response.ok) throw new APSystemApiError(data?.error?.reason ?? `The AP service returned ${response.status}. Please retry.`, response.status, data?.error?.code ?? "service_error");
  if (data === null) throw new APSystemApiError("The AP service returned an unreadable response.", 502, "invalid_response");
  return data as T;
}
function parseCase(data: unknown): APCaseDetail {
  const result = caseDetailSchema.safeParse(data);
  if (!result.success) throw new APSystemApiError("The case response does not match the current evidence contract. Refresh after the service is updated.", 502, "contract_mismatch");
  return result.data;
}
export const apSourceUrl = (source: SourceBinding) => `${base}/sources/${encodeURIComponent(source.sourceId)}/revisions/${source.revision}?sha256=${encodeURIComponent(source.sha256)}`;
export const apPageUrl = (source: SourceBinding, page: number) => `${base}/sources/${encodeURIComponent(source.sourceId)}/revisions/${source.revision}/pages/${page}?sha256=${encodeURIComponent(source.sha256)}`;
export async function loadPage(source: SourceBinding, page: number, signal: AbortSignal): Promise<Blob> {
  const { response, assertCurrent } = await apProtectedFetch(apPageUrl(source, page), { signal });
  if (!response.ok) throw new Error("The source page preview is unavailable. Inspect the original file and text citation.");
  if (response.headers.get("X-AP-Source-SHA256") !== source.sha256 || response.headers.get("X-AP-Source-Revision") !== String(source.revision) || response.headers.get("X-AP-Page") !== String(page)) throw new Error("The page preview does not match this source version. Highlights are hidden.");
  const blob = await response.blob();
  assertCurrent();
  if (!["image/png", "image/jpeg", "image/webp"].includes(blob.type)) throw new Error("The source preview is not a supported page image.");
  return blob;
}
export async function loadOriginal(source: SourceDocument, signal: AbortSignal): Promise<Blob> {
  const { response, assertCurrent } = await apProtectedFetch(apSourceUrl(source), { signal });
  if (!response.ok) throw new Error("The original file could not be retrieved. Please retry.");
  const blob = await response.blob();
  const bytes = await blob.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  assertCurrent();
  if (digest !== source.sha256) throw new Error("The original bytes do not match this source version. Preview and download were blocked.");
  return new Blob([bytes], { type: source.mimeType });
}
export async function downloadOriginal(source: SourceDocument): Promise<void> {
  const blob = await loadOriginal(source, AbortSignal.timeout(30_000));
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = source.name.replace(/[\\/\u0000-\u001f]/g, "_"); link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export type APPaymentRequest = { expectedRevision: number; snapshotHash: string; idempotencyKey: string; executionDate?: string; amountCents?: number; credits?: { creditId: string; amountCents: number }[] };
export function validatePaymentRequest(input: APPaymentRequest) {
  if (input.executionDate !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(input.executionDate) || !Number.isFinite(Date.parse(input.executionDate)) || new Date(input.executionDate).toISOString().slice(0, 10) !== input.executionDate)) throw new APSystemApiError("Choose a valid calendar date for payment initiation.", 400, "invalid_request");
  const cents = (value: number) => Number.isSafeInteger(value) && value > 0;
  if ((input.amountCents !== undefined && !cents(input.amountCents)) || input.credits?.some(c => !c.creditId.trim() || !cents(c.amountCents)) || new Set(input.credits?.map(c => c.creditId)).size !== (input.credits?.length ?? 0)) throw new APSystemApiError("Payment and credit amounts must be positive whole cents with unique credit references.", 400, "invalid_request");
  return input;
}
export type APAccountingSelection={paymentVersionId?:string;creditApplicationId?:string;correctionId?:string};
export function accountingSelection(value?:APAccountingSelection|string):APAccountingSelection{
 const input=typeof value==="string"?{paymentVersionId:value}:value??{};
 if([input.paymentVersionId,input.creditApplicationId,input.correctionId].filter(Boolean).length>1||Object.keys(input).some(key=>!["paymentVersionId","creditApplicationId","correctionId"].includes(key))||Object.values(input).some(value=>typeof value!=="string"||!value.trim()))throw new APSystemApiError("Choose one recorded settlement, credit application or approved correction.",400,"invalid_request");
 return input;
}
export const apSystemApi = {
  physicalLines:(caseId?:string,signal?:AbortSignal)=>request<PhysicalLineWorkspaceView>(`/physical-lines${caseId?`?caseId=${encodeURIComponent(caseId)}`:""}`,undefined,signal),
  physicalLine:<K extends PhysicalLineOperation>(operation:K,input:PhysicalLineInputs[K])=>request<unknown>(`/physical-lines/${operation}`,physicalLineOperationSchemas[operation].parse(input)),
  supplierContacts:(signal?:AbortSignal)=>request<SupplierContactWorkspaceView>("/supplier-contacts",undefined,signal),
  contactChange:<K extends ContactChangeOperation>(operation:K,input:ContactChangeInputs[K])=>request<unknown>(`/supplier-contacts/${operation}`,contactChangeOperationSchemas[operation].parse(input)),
  operationalTimings:(signal?:AbortSignal)=>request<OperationalTimings>("/metrics",undefined,signal),
  creditApplication:(caseId:string,applicationId:string,signal?:AbortSignal)=>request<CreditApplication>(`/cases/${encodeURIComponent(caseId)}/credit-applications/${encodeURIComponent(applicationId)}`,undefined,signal),
  taxState:(originalEntryId:string,signal?:AbortSignal)=>request<TaxState>(`/close/tax-state/${encodeURIComponent(originalEntryId)}`,undefined,signal),
  costState:(originalEntryId:string,signal?:AbortSignal)=>request<CostState>(`/close/cost-state/${encodeURIComponent(originalEntryId)}`,undefined,signal),
  closeAccountingStatus:(selection:CloseExportRequest,signal?:AbortSignal)=>request<QBOCloseStatus>("/close/accounting/status",{request:closeExportRequestSchema.strict().parse(selection)},signal),
  closeAccountingPreview:(selection:CloseExportRequest)=>request<QBOClosePreview>("/close/accounting/preview",{request:closeExportRequestSchema.strict().parse(selection)}),
  closeAccountingSubmit:(selection:CloseExportRequest,expectedPlanHash:string)=>request<QBOCloseSubmit>("/close/accounting/submit",{request:closeExportRequestSchema.strict().parse(selection),expectedPlanHash}),
  closeAccountingVerify:(selection:CloseExportRequest)=>request<QBOCloseVerify>("/close/accounting/verify",{request:closeExportRequestSchema.strict().parse(selection)}),
  corrections:(caseId:string,signal?:AbortSignal)=>request<CorrectionView>(`/cases/${encodeURIComponent(caseId)}/corrections`,undefined,signal),
  proposeCorrection:(input:AccountingCorrectionRequest)=>request<unknown>(`/cases/${encodeURIComponent(input.caseId)}/corrections/propose`,accountingCorrectionRequestSchema.parse(input)),
  voteCorrection:(caseId:string,input:CorrectionVote)=>request<unknown>(`/cases/${encodeURIComponent(caseId)}/corrections/vote`,domainVoteSchema.strict().parse(input)),
  closeView:(period:string,signal?:AbortSignal)=>request<CloseView>(`/close/${periodSchema.parse(period)}`,undefined,signal),
  close:<K extends CloseOperation>(operation:K,input:CloseInputs[K])=>request<unknown>(`/close/${operation}`,closeOperationSchemas[operation].parse(input)),
  governance: (signal?:AbortSignal) => request<GovernanceView>("/business",undefined,signal),
  businessProposals: (signal?:AbortSignal) => request<BusinessProposal[]>("/business/proposals",undefined,signal),
  business: <K extends DomainOperation>(operation:K,input:DomainInputs[K]) => request<unknown>(`/business/${operation}`,domainOperationSchemas[operation].parse(input)),
  whoami: () => request<{ tokenIdentifier: string; issuer: string; approved: boolean }>("/whoami"),
  logout: closeAPSession,
  list: async (signal?: AbortSignal) => {
    const data = await request<unknown>("/cases", undefined, signal);
    if (!Array.isArray(data)) throw new APSystemApiError("The AP case list is unreadable.", 502, "invalid_response");
    return data.map(parseCase);
  },
  detail: async (id: string, signal?: AbortSignal) => parseCase(await request(`/cases/${encodeURIComponent(id)}`, undefined, signal)),
  review: (input: ReviewRequest) => request<unknown>(`/cases/${encodeURIComponent(input.caseId)}/review`, input),
  approve: (input: BillApprovalRequest) => request<unknown>(`/cases/${encodeURIComponent(input.caseId)}/approve`, input),
  payment: (id: string, signal?: AbortSignal) => request<PaymentDetail>(`/payments/${encodeURIComponent(id)}`, undefined, signal),
  preparePayment: (caseId: string, input: APPaymentRequest) => request<{versionId:string;snapshotHash:string}>(`/cases/${encodeURIComponent(caseId)}/payments`, validatePaymentRequest(input)),
  authorizePayment: (caseId:string, versionId:string, input:{expectedRevision:number;snapshotHash:string;paymentSnapshotHash:string}) => request<{commandId:string}>(`/cases/${encodeURIComponent(caseId)}/payments/${encodeURIComponent(versionId)}/authorize`, input),
  cancelPayment: (caseId:string, versionId:string, input:{expectedRevision:number;snapshotHash:string}) => request<unknown>(`/cases/${encodeURIComponent(caseId)}/payments/${encodeURIComponent(versionId)}/cancel`, input),
  paymentRuns: (signal?:AbortSignal) => request<PaymentRunSummary[]>("/payment-runs",undefined,signal),
  paymentRun: (runId:string,signal?:AbortSignal) => request<PaymentRunDetail>(`/payment-runs/${encodeURIComponent(runId)}`,undefined,signal),
  prepareRun: (input:PaymentRunRequest) => request<{runId:string;snapshotHash:string}>("/payment-runs",input),
  authorizeRun: (runId:string,snapshotHash:string) => request<{commandIds:string[]}>(`/payment-runs/${encodeURIComponent(runId)}/authorize`,{snapshotHash}),
  cancelRun: (runId:string,snapshotHash:string) => request<{ok:true}>(`/payment-runs/${encodeURIComponent(runId)}/cancel`,{snapshotHash}),
  accountingStatus: (caseId:string,signal?:AbortSignal) => request<AccountingStatus>(`/cases/${encodeURIComponent(caseId)}/accounting`,undefined,signal),
  accountingPreview: (caseId:string,selection?:APAccountingSelection|string) => request<QBOPreview>(`/cases/${encodeURIComponent(caseId)}/accounting/preview`,accountingSelection(selection)),
  accountingSubmit: (caseId:string,expectedPlanHash:string,selection?:APAccountingSelection|string) => request<QBOSubmit>(`/cases/${encodeURIComponent(caseId)}/accounting/submit`,{expectedPlanHash,...accountingSelection(selection)}),
  accountingVerify: (caseId:string,selection?:APAccountingSelection|string) => request<QBOVerify>(`/cases/${encodeURIComponent(caseId)}/accounting/verify`,accountingSelection(selection)),
  intake: (files: { file: File; kind: SourceDocument["kind"] }[], key: string) => {
    const data = new FormData(); files.forEach(({ file }) => data.append("documents", file));
    data.append("kinds", JSON.stringify(files.map(f => f.kind))); data.append("idempotencyKey", key);
    return request<{ caseId: string }>("/intake", data);
  },
};
export const apError = (error: unknown) => error instanceof ZodError ? `Check the proposed values: ${error.issues.slice(0,3).map(issue=>`${issue.path.join(" / ") || "Request"}: ${issue.message}`).join("; ")}` : error instanceof Error ? error.message : "The request failed. Please retry.";
