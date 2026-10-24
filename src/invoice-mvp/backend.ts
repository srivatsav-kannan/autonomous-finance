import { ConvexHttpClient } from "convex/browser";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type {
  BackendResult, CaseDetail, CaseSummary, DecisionInput, DecisionResult, IngestBatchInput,
  IngestBatchResult, RegisterCustomerInput, SeatAuth, SubmitProposalInput, SubmitProposalResult,
  ToolCallInput, WorkspaceSnapshot, ModelBudget, ModelReservationResult, ReserveModelRequestInput,
} from "./contracts";

export class InvoiceError extends Error {
  constructor(readonly code: string, message: string, readonly status = errorStatus(code)) { super(message); }
}
export function errorStatus(code: string): number {
  if (/unknown_seat|bad_token|unauthenticated|session_required/.test(code)) return 401;
  if (/forbidden|unauthorized|origin|host|seat_retired|membership/.test(code)) return 403;
  if (/stale|conflict|already|superseded|duplicate|not_pending/.test(code)) return 409;
  if (code === "not_found") return 404;
  if (code === "backend_rate_limited") return 429;
  if (code === "not_implemented" || code === "backend_unavailable") return 503;
  return 400;
}
export function unwrap<T>(result: BackendResult<T>): T {
  if (!result.ok) throw new InvoiceError(result.code, result.error);
  return result.value;
}

// Four bounded waits means at most five attempts and 3.75 seconds of backoff.
// This applies only to Convex writes. It never retries model/provider requests.
export const CONVEX_WRITE_RETRY_DELAYS_MS = [250, 500, 1000, 2000] as const;
const sleepForWriteRetry = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
function isWriteRateLimit(error: unknown): boolean {
  // ConvexHttpClient throws the JSON HTTP error body as Error.message for non-UDF
  // failures. Match the structured code, never arbitrary message fragments.
  if (!(error instanceof Error)) return false;
  try {
    const body: unknown = JSON.parse(error.message);
    return typeof body === "object" && body !== null && "code" in body && body.code === "TooManyWrites";
  } catch { return false; }
}

/** Injectable only to support focused tests. Production has exactly one adapter: Convex. */
export interface InvoiceBackend {
  workspace(): Promise<WorkspaceSnapshot>;
  caseDetail(caseId: string): Promise<CaseDetail>;
  pendingCases(): Promise<CaseSummary[]>;
  ingestBatch(input: IngestBatchInput): Promise<IngestBatchResult>;
  beginInvestigation(caseId: string): Promise<CaseSummary>;
  submitProposal(input: SubmitProposalInput): Promise<SubmitProposalResult>;
  decide(input: DecisionInput): Promise<DecisionResult>;
  registerCustomer(input: RegisterCustomerInput): Promise<{ customerId: string }>;
  recordToolCall(caseId: string, evidenceVersion: number, call: ToolCallInput, idempotencyKey: string): Promise<{ auditId: string }>;
  reserveModelRequest?(input: ReserveModelRequestInput): Promise<ModelReservationResult & { replayed: boolean }>;
  modelBudget?(): Promise<ModelBudget | null>;
}

export class ConvexInvoiceBackend implements InvoiceBackend {
  constructor(private readonly client: ConvexHttpClient, private readonly human: SeatAuth, private readonly investigator: SeatAuth, private readonly waitForWriteRetry = sleepForWriteRetry) {
    if (human.runId !== investigator.runId || human.seatId === investigator.seatId) throw new InvoiceError("invalid_identity", "Separate human and investigator seats in the same run are required.");
  }
  private async mutation<M extends FunctionReference<"mutation">>(operation: M, payload: FunctionArgs<M>): Promise<FunctionReturnType<M>> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.client.mutation(operation, payload); }
      catch (error) {
        if (!isWriteRateLimit(error)) throw error;
        const delay = CONVEX_WRITE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw new InvoiceError("backend_rate_limited", "Invoice storage is busy after five attempts. Retry the operation with the same idempotency key, or import smaller batches.", 429);
        await this.waitForWriteRetry(delay);
      }
    }
  }
  async workspace() { return unwrap(await this.client.query(api.invoiceCases.workspace, this.human)); }
  async caseDetail(caseId: string) { return unwrap(await this.client.query(api.invoiceCases.caseDetail, { ...this.human, caseId })); }
  async pendingCases() { return unwrap(await this.client.query(api.invoiceCases.pendingCases, this.investigator)); }
  async ingestBatch(input: IngestBatchInput) { return unwrap(await this.mutation(api.invoiceCases.ingestBatch, { ...input, ...this.human })); }
  async beginInvestigation(caseId: string) { return unwrap(await this.mutation(api.invoiceCases.beginInvestigation, { caseId, ...this.investigator })); }
  async submitProposal(input: SubmitProposalInput) { return unwrap(await this.mutation(api.invoiceCases.submitProposal, { ...input, ...this.investigator })); }
  async decide(input: DecisionInput) { return unwrap(await this.mutation(api.invoiceCases.decide, { ...input, ...this.human })); }
  async registerCustomer(input: RegisterCustomerInput) { return unwrap(await this.mutation(api.invoiceCases.registerCustomer, { ...input, ...this.investigator })); }
  async recordToolCall(caseId: string, evidenceVersion: number, call: ToolCallInput, idempotencyKey: string) {
    return unwrap(await this.mutation(api.invoiceCases.recordToolCall, { caseId, evidenceVersion, call, idempotencyKey, ...this.investigator }));
  }
  async reserveModelRequest(input: ReserveModelRequestInput) {
    const result = await this.mutation(api.invoiceCases.reserveModelRequest, { ...input, ...this.investigator });
    return { ...unwrap(result), replayed: result.ok && result.replayed === true };
  }
  async modelBudget() { return unwrap(await this.client.query(api.invoiceCases.modelBudget, this.investigator)); }
}
