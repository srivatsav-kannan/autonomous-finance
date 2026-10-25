import type { QueryCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import type { BankScope } from "../../../src/payments/contracts";
import type { GLCoordinates } from "../../../src/ap-system/gl-dimensions";
import { businessPolicySchema } from "../../../src/ap-system/domain-contracts";
import { settlementDimensions } from "../../../src/ap-system/settlement-dimensions";
import { assertRowScope } from "../demoAuth";
import { canonical, sha256Hex } from "../kernel";
import { deny } from "./shared";
/** Historical policy authority remains readable after retirement; it never authorizes a new action. */
export async function originalSettlementDimensions(
  ctx: QueryCtx,
  scope: BankScope,
  approval: Doc<"apApprovalProposals">,
  allocations: GLCoordinates[],
) {
  assertRowScope(approval, scope);
  if (await sha256Hex(canonical({request:approval.request,policyHash:approval.policyHash,supplierHash:approval.supplierHash,amountCents:approval.amountCents,route:approval.route})) !== approval.hash)
    deny("original_approval_hash_changed", "Retained recognition approval no longer matches its hash");
  const rows = await ctx.db
    .query("apBusinessPolicies")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const row = rows.find((p) => p.hash === approval.policyHash);
  if (!row || !row.approvedBy || !["active", "superseded"].includes(row.status))
    deny(
      "original_dimension_policy_missing",
      "Retained approved recognition policy required",
    );
  assertRowScope(row, scope);
  const policy = businessPolicySchema.parse(row.policy);
  if ((await sha256Hex(canonical(policy))) !== approval.policyHash)
    deny(
      "original_dimension_policy_changed",
      "Recognition policy hash no longer matches retained policy",
    );
  return settlementDimensions(allocations, policy);
}
