import type { Doc } from "../../_generated/dataModel";
import { sourceOutcomeSchema, type SourceOutcome, type APException } from "../../../src/ap-system/contracts";
import { deny } from "./shared";

type Case = Pick<Doc<"apCaseRecords">, "sourceOutcome" | "intake">;
export function retainedSourceOutcome(row: Case): SourceOutcome | undefined {
  const value = row.sourceOutcome ?? row.intake?.sourceOutcome;
  return value === undefined ? undefined : sourceOutcomeSchema.parse(value);
}
export function assertSourcePayable(row: Case) {
  if (retainedSourceOutcome(row)) deny("historical_source_paid", "The retained source records this invoice as already paid. It is available for evidence review only; new recognition and payment are blocked.");
}
export function sourceOutcomeException(outcome: SourceOutcome): APException {
  return {exceptionId:"historical_source_paid",code:"historical_source_paid",reason:`Source record ${outcome.sourceReference} reports this invoice paid. Historical evidence does not create a payment in this run.`,ownerRole:"controller",permittedActions:["inspect_retained_source"],requiredEvidence:outcome.evidence.map(e=>`${e.sourceId}:${e.revision}:${e.sha256}`),blocking:true,status:"open",resolution:null};
}
