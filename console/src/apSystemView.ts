import type { APCaseDetail, CoordinateFrame, EvidenceRegion, FieldEvidence, ReviewRequest, SourceBinding, SourceDocument } from "../../src/ap-system/contracts";
export const apMoney = (value: number | null) => value === null || !Number.isFinite(value) ? "Not established" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
export const apLabel = (value: string) => value.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
const fieldNames: Record<string, string> = { extractedSupplierName: "Supplier name", totalCents: "Total amount", subtotalCents: "Subtotal", sku: "SKU" };
export function apFieldLabel(path: string): string {
  if (path.startsWith("source.")) {
    const value = path.slice(7);
    const cell = /^table-(\d+)\.row-(\d+)\.(.+)$/.exec(value);
    if (cell) return `Table ${cell[1]} / Row ${cell[2]} / ${apFieldLabel(cell[3]!)}`;
    return apFieldLabel(value);
  }
  const parts = path.split(".");
  const name = parts.pop() ?? path;
  const label = fieldNames[name] ?? apLabel(name.replace(/Cents$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase());
  const context = parts.filter(part => part !== "lines").map(part => apLabel(part.replace(/[-_]/g, " "))).join(" / ");
  return context ? `${context} / ${label}` : label;
}
export function apFieldValue(evidence: Pick<FieldEvidence, "fieldPath" | "normalizedValue">): string {
  const value = evidence.normalizedValue;
  if (value === null) return "Unresolved";
  return /Cents$/.test(evidence.fieldPath) && typeof value === "number" ? apMoney(value) : String(value);
}
export const sameSource = (a: SourceBinding, b: SourceBinding) => a.sourceId === b.sourceId && a.revision === b.revision && a.sha256 === b.sha256;
export function sourceForEvidence(detail: APCaseDetail, evidence: FieldEvidence): SourceDocument | undefined {
  if (detail.candidate && !detail.candidate.sources.some(source => sameSource(source, evidence.source))) return undefined;
  return detail.sources.find(source => sameSource(source, evidence.source));
}
export function evidenceForCase(detail: APCaseDetail): FieldEvidence[] {
  const entries = [...(detail.candidate?.evidence ?? []), ...detail.extraction.evidence];
  return [...new Map(entries.map(e => [e.evidenceId, e])).values()];
}
/** Display-only source text; conflicting occurrences cannot supply a case heading. */
export function sourceReadingValue(detail: APCaseDetail, name: string): string | undefined {
  const path = `source.${name}`;
  const values = evidenceForCase(detail).filter(field => field.fieldPath === path || field.fieldPath.startsWith(`${path}.occurrence-`));
  if (!values.length || values.some(field => field.contentStatus !== "supported" || typeof field.normalizedValue !== "string")) return undefined;
  const unique = new Set(values.map(field => String(field.normalizedValue)));
  return unique.size === 1 ? [...unique][0] : undefined;
}
const point = (frame: CoordinateFrame, x: number, y: number): [number, number] => {
  const [a,b,c,d,e,f] = frame.transform; return [a*x+c*y+e,b*x+d*y+f];
};
export function displayedFrame(frame: CoordinateFrame) {
  const corners = [point(frame,0,0),point(frame,frame.width,0),point(frame,frame.width,frame.height),point(frame,0,frame.height)];
  const x=Math.min(...corners.map(p=>p[0])), y=Math.min(...corners.map(p=>p[1]));
  return {x,y,width:Math.max(...corners.map(p=>p[0]))-x,height:Math.max(...corners.map(p=>p[1]))-y};
}
export function regionPolygon(frame: CoordinateFrame, region: EvidenceRegion): string {
  return [[region.x,region.y],[region.x+region.width,region.y],[region.x+region.width,region.y+region.height],[region.x,region.y+region.height]].map(([x,y]) => point(frame,x!,y!).join(",")).join(" ");
}
export function reviewPayload(detail: APCaseDetail, reason: string, outcome: ReviewRequest["outcome"], idempotencyKey: string): ReviewRequest {
  const sources = detail.currentSourceBindings;
  return { caseId:detail.caseId, expectedRevision:detail.revision, sourceBindings:sources.map(({sourceId,revision,sha256})=>({sourceId,revision,sha256})), snapshotHash:detail.snapshotHash, idempotencyKey, outcome, reason:reason.trim(), evidenceIds:(detail.candidate?.evidence ?? detail.extraction.evidence).map(e=>e.evidenceId) };
}
export function caseNeedsAttention(detail: APCaseDetail) {
  return detail.exceptions.some(e=>e.blocking && e.status === "open") || ["failed","review_required"].includes(detail.states.document) || detail.states.business === "held" || detail.states.accounting === "repair_required" || ["unknown","exception","rejected","returned"].includes(detail.states.execution);
}

/** A safe detail response must still belong to the selected AP obligation. */
export function paymentBelongsToCase(detail: APCaseDetail, snapshot: import("../../src/payments/contracts").PaymentSnapshot): boolean {
  const a=detail.scope,b=snapshot.scope;
  return a.organizationId===b.organizationId && a.runId===b.runId && a.provider===b.provider && a.environment===b.environment && a.accountId===b.accountId && !!detail.links.billId && snapshot.bills.some(bill=>bill.billId===detail.links.billId);
}

/** Exact dollars-to-cents input; a blank selection means the displayed approved remainder. */
export function paymentAmountInput(value:string,outstandingCents:number|null):number {
  if(!Number.isSafeInteger(outstandingCents)||outstandingCents===null||outstandingCents<=0)throw new Error("An approved outstanding balance is required.");
  if(!value.trim())return outstandingCents;
  if(!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value.trim()))throw new Error("Enter a positive USD amount with at most two decimal places.");
  const [dollars,fraction=""]=value.trim().split(".");const cents=BigInt(dollars!)*100n+BigInt(fraction.padEnd(2,"0"));
  if(cents<=0n||cents>BigInt(outstandingCents))throw new Error("Payment must be positive and no more than the approved outstanding balance.");
  return Number(cents);
}

/** General accounting proposals have no implied balance or blank default. */
export function accountingAmountInput(value:string,allowZero=false):number{
 if(!value.trim())throw new Error("Enter an explicit USD amount.");
 if(allowZero&&/^0(?:\.0{1,2})?$/.test(value.trim()))return 0;
 return paymentAmountInput(value,Number.MAX_SAFE_INTEGER);
}
