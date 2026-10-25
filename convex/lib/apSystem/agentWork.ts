import type { MutationCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import { AP_AGENT_VERSION } from "../../../src/ap-system/agent-policy";
/** Enrollment is atomic with intake; it grants no review or bank authority. */
export async function ensureAPCaseWork(
  ctx: MutationCtx,
  row: Doc<"apCaseRecords">,
) {
  const prior = await ctx.db
    .query("apCaseWork")
    .withIndex("by_case", (q) =>
      q.eq("scope.runId", row.scope.runId).eq("caseId", row._id),
    )
    .unique();
  if (prior) {
    // A revision arriving before/during a wait is observed from current records on the next claim.
    if (!["paused", "escalated"].includes(prior.status))
      await ctx.db.patch(prior._id, { nextCheckAt: Date.now() });
    return prior._id;
  }
  return ctx.db.insert("apCaseWork", {
    scope: row.scope,
    caseId: row._id,
    version: AP_AGENT_VERSION,
    status: "queued",
    role: "ap_clerk",
    stage: "check_case",
    owner: "ap_clerk",
    reason: "New source case awaits agent policy check.",
    requirements: [],
    nextCheckAt: Date.now(),
    generation: 0,
    attempts: 0,
    transitions: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}
