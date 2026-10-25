import type { APCaseDetail, CoordinateFrame, EvidenceRegion, FieldEvidence, ReviewRequest, SourceBinding, SourceDocument } from "../../src/ap-system/contracts";
export const apMoney = (value: number | null) => value === null ? "Not established" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
export const apLabel = (value: string) => value.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
export const sameSource = (a: SourceBinding, b: SourceBinding) => a.sourceId === b.sourceId && a.revision === b.revision && a.sha256 === b.sha256;
export function sourceForEvidence(detail: APCaseDetail, evidence: FieldEvidence): SourceDocument | undefined {
  if (detail.candidate && !detail.candidate.sources.some(source => sameSource(source, evidence.source))) return undefined;
  return detail.sources.find(source => sameSource(source, evidence.source));
}
export function evidenceForCase(detail: APCaseDetail): FieldEvidence[] {
  const entries = [...(detail.candidate?.evidence ?? []), ...detail.extraction.evidence];
  return [...new Map(entries.map(e => [e.evidenceId, e])).values()];
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
  const sources = detail.candidate?.sources ?? detail.sources;
  return { caseId:detail.caseId, expectedRevision:detail.revision, sourceBindings:sources.map(({sourceId,revision,sha256})=>({sourceId,revision,sha256})), snapshotHash:detail.snapshotHash, idempotencyKey, outcome, reason:reason.trim(), evidenceIds:evidenceForCase(detail).map(e=>e.evidenceId) };
}
export function caseNeedsAttention(detail: APCaseDetail) {
  return detail.exceptions.some(e=>e.blocking && e.status === "open") || ["failed","review_required"].includes(detail.states.document) || detail.states.business === "held" || detail.states.accounting === "repair_required" || ["unknown","exception","rejected","returned"].includes(detail.states.execution);
}

/** A safe detail response must still belong to the selected AP obligation. */
export function paymentBelongsToCase(detail: APCaseDetail, snapshot: import("../../src/payments/contracts").PaymentSnapshot): boolean {
  const a=detail.scope,b=snapshot.scope;
  return a.organizationId===b.organizationId && a.runId===b.runId && a.provider===b.provider && a.environment===b.environment && a.accountId===b.accountId && !!detail.links.billId && snapshot.bills.some(bill=>bill.billId===detail.links.billId);
}
