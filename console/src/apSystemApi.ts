import { domainOperationSchemas, type DomainOperation, type DomainInputs, type GovernanceView, type BusinessProposal } from "../../src/ap-system/domain-operations";
import { caseDetailSchema, type APCaseDetail, type BillApprovalRequest, type ReviewRequest, type SourceBinding, type SourceDocument } from "../../src/ap-system/contracts";
import type { PaymentApproval, PaymentSnapshot } from "../../src/payments/contracts";
import type { BankTransaction, TransferObservation } from "../../src/integrations/contracts";

import type { PaymentRunDetail, PaymentRunRequest, PaymentRunSummary, AccountingStatus } from "../../src/ap-system/workspace-operations";
import type { QBOReceipt } from "../../src/ap-system/quickbooks/runtime";
import type { Plan } from "../../src/ap-system/quickbooks/types";
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
export async function downloadOriginal(source: SourceDocument): Promise<void> {
  const { response, assertCurrent } = await apProtectedFetch(apSourceUrl(source), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("The original file could not be retrieved. Please retry.");
  const blob = await response.blob();
  const bytes = await blob.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  assertCurrent();
  if (digest !== source.sha256) throw new Error("The downloaded bytes do not match this source version. Download was blocked.");
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
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
export const apSystemApi = {
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
  accountingPreview: (caseId:string,paymentVersionId?:string) => request<{plan:Plan;planHash:string;externalWrites:0}>(`/cases/${encodeURIComponent(caseId)}/accounting/preview`,{paymentVersionId}),
  accountingSubmit: (caseId:string,expectedPlanHash:string,paymentVersionId?:string) => request<{operation:QBOReceipt}>(`/cases/${encodeURIComponent(caseId)}/accounting/submit`,{expectedPlanHash,paymentVersionId}),
  accountingVerify: (caseId:string,paymentVersionId?:string) => request<{operation:QBOReceipt;verifiedAt:number}>(`/cases/${encodeURIComponent(caseId)}/accounting/verify`,{paymentVersionId}),
  intake: (files: { file: File; kind: SourceDocument["kind"] }[], key: string) => {
    const data = new FormData(); files.forEach(({ file }) => data.append("documents", file));
    data.append("kinds", JSON.stringify(files.map(f => f.kind))); data.append("idempotencyKey", key);
    return request<{ caseId: string }>("/intake", data);
  },
};
export const apError = (error: unknown) => error instanceof Error ? error.message : "The request failed. Please retry.";
