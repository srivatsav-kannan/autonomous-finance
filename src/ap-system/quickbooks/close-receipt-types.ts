import type { BankScope } from "../../integrations/contracts";
import type { CloseExportRequest } from "../close-contracts";
/** Authenticated read authority only; never sufficient for a new external posting. */
export type CloseReceiptAccess = {
  authorizedSubject: string;
  accessedAt: number;
  scope: BankScope;
  request: CloseExportRequest;
  exportId: string;
  approvalId: string;
  approvalHash: string;
  journalId: string;
  journalHash: string;
};
export type CloseReceiptAccessLoader = (
  request: CloseExportRequest,
) => Promise<CloseReceiptAccess>;
