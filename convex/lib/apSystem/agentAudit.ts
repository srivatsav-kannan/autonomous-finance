import type { MutationCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import {
  agentTransitionSchema,
  type APAgentTransition,
  type APCaseDetail,
} from "../../../src/ap-system/contracts";

/** Explicit allowlist: no source text, original bytes, credentials or bank destinations. */
export function agentTransitionState(w: Doc<"apCaseWork">, d: APCaseDetail) {
  return {
    work: {
      version: w.version,
      status: w.status,
      stage: w.stage,
      role: w.role,
      owner: w.owner,
      requirements: w.requirements,
      generation: w.generation,
      attempts: w.attempts,
      transitions: w.transitions,
      leaseOwner: w.leaseOwner ?? null,
      leaseUntil: w.leaseUntil ?? null,
      nextCheckAt: w.nextCheckAt,
      waitSince: w.waitSince ?? null,
      deadlineAt: w.deadlineAt ?? null,
    },
    case: {
      revision: d.revision,
      snapshotHash: d.snapshotHash,
      policyVersion: d.policyVersion,
      sourceBindings: d.currentSourceBindings,
      states: d.states,
      amounts: d.amounts,
      billId: d.links.billId,
      paymentVersionIds: d.links.paymentVersionIds,
      commandIds: d.links.commandIds,
      providerTransferIds: d.payments.flatMap((p) =>
        p.providerTransferId ? [p.providerTransferId] : [],
      ),
      bankTransactionIds: d.links.bankTransactionIds,
      journalIds: d.journals.map((j) => j.entryId),
      decisionIds: d.decisions.map((d) => d.decisionId),
    },
  };
}

/** Called inside the same Convex mutation as the effect: either both commit or neither does. */
export async function recordAgentTransition(
  ctx: MutationCtx,
  before: Doc<"apCaseWork">,
  actor: string,
  action: APAgentTransition["action"],
  stage: string,
  reason: string,
  beforeCase: APCaseDetail,
  afterCase = beforeCase,
) {
  const after = await ctx.db.get(before._id);
  if (!after) throw Error("Agent work disappeared before audit commit");
  const transition = agentTransitionSchema.parse({
    version: "ap-agent-transition-v1",
    operationId: `ap-agent:${before.caseId}:${after.generation}:${action}`,
    action,
    outcome: action === "escalate" ? "blocked" : "applied",
    before: agentTransitionState(before, beforeCase),
    after: agentTransitionState(after, afterCase),
  });
  await ctx.db.insert("apCaseWorkEvents", {
    scope: before.scope,
    caseId: before.caseId,
    actor,
    stage,
    reason,
    revision: afterCase.revision,
    snapshotHash: afterCase.snapshotHash,
    generation: after.generation,
    at: Date.now(),
    transition,
  });
}
