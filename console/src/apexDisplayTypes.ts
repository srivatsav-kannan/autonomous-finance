/** Read models exposed by the separate APEX gateway. No parser code ships in the console. */
export type ApexCorpus = {
  totalInvoices: number; supplierCount: number; sourcePaidInvoices: number; openInvoices: number;
  entries: {
    file: string; sha256: string; invoiceNumber: string | null; totalCents: number | null;
    supplierName: string | null; classification: "open" | "historical_paid" | "unresolved";
    ledgerChecks: {check:string;passed:boolean}[];
    reconciliation: {status:"matched"|"unmatched"|"ambiguous"|"not_paid";reference:string|null;statement:string|null;checks:{check:string;passed:boolean}[]};
  }[];
};
export type ApexProcessingJob = {
  id:string;status:"running"|"complete"|"failed"|"interrupted";error:string|null;
  counts:{total:number;complete:number;failed:number};
  steps:{file:string;sha256:string;invoiceNumber:string|null;status:"queued"|"parsing"|"importing"|"complete"|"failed";caseId:string|null;disposition:"created"|"existing"|null;extractionStatus:string|null;parser:string|null;exceptions:string[];error:string|null}[];
};
