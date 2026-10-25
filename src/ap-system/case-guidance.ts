import type { APIntake, SourceBinding } from "./contracts";
import type { PrecedentContext, PrecedentCoding, PrecedentCandidate, PrecedentHistoryInput } from "./precedent-contracts";
/** Deliberately bounded parser for explicit source labels. Never infer category from vendor or coding. */
export function sourceGuidanceFacts(text: string) {
  const labels = { supplierId: "Supplier ID", category: "Service category", location: "Location", effectiveOn: "Invoice date", currency: "Currency", amount: "Total cents" };
  const values: Record<string,string> = {}, reasons: string[] = [];
  for (const [field,label] of Object.entries(labels)) {
    const matches = [...text.matchAll(new RegExp(`^${label}:\\s*([^\\r\\n]+)`, "gmi"))].map(m=>m[1]!.trim());
    if(matches.length !== 1) reasons.push(`${field}: ${matches.length ? "ambiguous" : "missing"} source evidence`);
    else values[field] = matches[0]!;
  }
  return { values, reasons };
}
export function caseGuidanceContext(input: APIntake): { context: PrecedentContext | null; reasons: string[]; matches: Record<string,string> } {
  const invoices=input.documents.filter(s=>s.kind==="invoice");
  const reasons:string[]=[];
  if(invoices.length!==1) reasons.push("Exactly one current invoice source is required for coding guidance");
  const facts=sourceGuidanceFacts(invoices.map(s=>s.extractedText).join("\n")); reasons.push(...facts.reasons);
  const c=input.candidate,v=facts.values;
  if(!c || input.extraction.status!=="complete") reasons.push("Current extraction is incomplete");
  if(c && (v.supplierId!==c.supplierId || v.effectiveOn!==c.invoiceDate || v.currency!==c.currency || Number(v.amount)!==c.totalCents)) reasons.push("Candidate contradicts retained supplier/date/currency/amount evidence");
  if(v.currency!=="USD") reasons.push("Only USD guidance is supported");
  if(!["routine_cleaning","capital_renovation"].includes(v.category??"")) reasons.push("Service category is absent or unresolved; request a work description");
  if(v.category==="routine_cleaning" && invoices.some(s=>/renovat|capital|remodel/i.test(s.extractedText))) reasons.push("Service category contradicts retained original renovation/capital description");
  if(c?.evidence.some(e=>["category","location","supplierId","invoiceDate"].includes(e.fieldPath)&&e.contentStatus!=="supported")) reasons.push("Relevant field evidence is unresolved or conflicting");
  if(c && v.category==="routine_cleaning" && c.lines.some(l=>/renovat|capital|remodel/i.test(l.description))) reasons.push("Service category contradicts renovation/capital line description");
  if(invoices.some(s=>s.pageStatus.some(p=>p.status!=="complete"))) reasons.push("Current original has incomplete pages");
  const validDate=/^\d{4}-\d{2}-\d{2}$/.test(v.effectiveOn??"") && Number.isFinite(Date.parse(v.effectiveOn!)) && new Date(v.effectiveOn!).toISOString().slice(0,10)===v.effectiveOn;
  if(!validDate) reasons.push("Valid source invoice date required");
  if(!Number.isSafeInteger(Number(v.amount)) || Number(v.amount)<=0) reasons.push("Valid source total required");
  return { context: reasons.length?null:{supplierId:v.supplierId!,category:v.category!,location:v.location!,effectiveOn:v.effectiveOn!,currency:"USD",amountCents:Number(v.amount)}, reasons, matches:v };
}
export type CaseGuidance = {
  id: string; caseId: string; caseRevision: number; snapshotHash: string; sourceBindings: SourceBinding[];
  status: "recommendation" | "held"; coding: PrecedentCoding|null; reason: string; owner: string; nextAction: string;
  evaluatedAt: number; fingerprint: string; context: PrecedentContext|null; matches: Record<string,string>;
  rules: { id:string; version:string; hash:string; status:string; scope:unknown; review:PrecedentCandidate["humanReview"]; histories:(PrecedentHistoryInput & {id:string;hash:string})[] }[];
  requiresHumanReview:true; inferenceMode:"deterministic_demo";
};
