import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type {
  BankScope,
  PaymentSnapshot,
} from "../../../src/payments/contracts";
import { decisionSchema } from "../../../src/ap-system/contracts";
import { assertRowScope, getPaymentConfig } from "../demoAuth";
import { canonical, sha256Hex } from "../kernel";
import {
  activeBusinessPolicy,
  assertHumanSubject,
  currentFieldReviewer,
  currentSupplier,
  type BusinessVote,
} from "./businessAuthority";
import { deny } from "./shared";

async function releaseContext(
  ctx: QueryCtx,
  scope: BankScope,
  billIds: string[],
) {
  const linked = await Promise.all(
    billIds.map(async (billId) => {
      const id = ctx.db.normalizeId("demoBills", billId);
      if (!id) deny("bill_not_found", "Payment bill identity is invalid");
      const row = await ctx.db
        .query("apCaseRecords")
        .withIndex("by_bill", (q) =>
          q.eq("scope.runId", scope.runId).eq("billId", id),
        )
        .unique();
      if (row) assertRowScope(row, scope);
      return row;
    }),
  );
  if (!linked.some(Boolean)) return null; // Standalone bank-engine demonstrations retain their own scope.
  if (linked.some((r) => !r))
    deny(
      "mixed_case_authority",
      "AP case payments cannot mix unlinked obligations",
    );
  const cases = linked.filter((r) => r !== null);
  if (cases.some((r) => r.historicalPayment))
    deny(
      "historical_source_paid",
      "Imported source-paid invoices cannot authorize another payment",
    );
  const config = await getPaymentConfig(ctx, scope),
    policy = await activeBusinessPolicy(ctx, scope);
  if (policy) {
    if (
      !policy.value.paymentBands?.length ||
      cases.some((r) => !r.domainApprovalId)
    )
      deny(
        "payment_policy_required",
        "Activate explicit payment groups and amount bands for governed AP cases",
      );
  } else if (!config.paymentAuthorizers?.length) {
    deny(
      "payment_policy_required",
      "Configure independent payment authorizers with explicit amount limits",
    );
  }
  const hash = await sha256Hex(
    canonical({
      version: "ap-payment-release-v1",
      policy: policy
        ? { hash: policy.hash }
        : {
            version: config.policyVersion,
            authorizers: config.paymentAuthorizers,
          },
      identities: config.humanSubjects,
    }),
  );
  return { cases, config, policy, hash };
}

function eligibleSubjects(
  context: NonNullable<Awaited<ReturnType<typeof releaseContext>>>,
  amountCents: number,
) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
    deny("invalid_payment_amount", "Positive exact USD cents required");
  if (context.policy) {
    const band = context.policy.value.paymentBands!.find(
      (b) => amountCents <= b.upToCents,
    );
    if (!band)
      deny("payment_limit", "Payment exceeds the configured release ceiling");
    return context.policy.value.groups.find((g) => g.groupId === band.groupId)!
      .members;
  }
  const subjects = context.config
    .paymentAuthorizers!.filter((a) => amountCents <= a.maxCents)
    .map((a) => a.subject);
  if (!subjects.length)
    deny("payment_limit", "Payment exceeds configured human release authority");
  return subjects;
}

/** The full release policy is part of the exact proposal the human reviews. */
export async function paymentReleaseHash(
  ctx: QueryCtx,
  scope: BankScope,
  billIds: string[],
  amountCents: number,
) {
  const context = await releaseContext(ctx, scope, billIds);
  if (!context) return undefined;
  eligibleSubjects(context, amountCents);
  return context.hash;
}

/** Shared by individual release, batch release and the first bank dispatch. */
export async function assertPaymentRelease(
  ctx: QueryCtx,
  scope: BankScope,
  snapshot: Pick<
    PaymentSnapshot,
    "bills" | "amountCents" | "releasePolicyHash"
  >,
  subject: string,
  options: { aggregateAmountCents?: number; checkSnapshot?: boolean } = {},
) {
  const context = await releaseContext(
    ctx,
    scope,
    snapshot.bills.map((b) => b.billId),
  );
  if (!context) return;
  if (
    options.checkSnapshot !== false &&
    snapshot.releasePolicyHash !== context.hash
  )
    deny(
      "stale_payment_policy",
      "Payment release policy or identity bindings changed; cancel and prepare a new proposal before submission",
    );
  if (
    !eligibleSubjects(
      context,
      options.aggregateAmountCents ?? snapshot.amountCents,
    ).includes(subject)
  )
    deny(
      "payment_group_required",
      "This human lacks the configured payment group or amount authority",
    );
  const actor = await assertHumanSubject(ctx, scope, subject);
  const blocked = new Set<string>();
  for (const row of context.cases) {
    blocked.add(await currentFieldReviewer(ctx, scope, row));
    const decisions = await ctx.db
      .query("apCaseDecisions")
      .withIndex("by_case", (q) =>
        q.eq("scope.runId", scope.runId).eq("caseId", row._id),
      )
      .collect();
    for (const record of decisions) {
      const d = decisionSchema.parse(record.decision);
      if (d.kind !== "bill_approval" || d.outcome !== "approved") continue;
      if (!d.actorSeatId)
        deny(
          "approval_identity_missing",
          "Retained recognition decision lacks a bound human seat; recertification required",
        );
      blocked.add(d.actorSeatId);
    }
    if (row.domainApprovalId) {
      const approvals = await ctx.db
        .query("apApprovalProposals")
        .withIndex("by_case", (q) =>
          q.eq("scope.runId", scope.runId).eq("caseId", row._id),
        )
        .collect();
      for (const approval of approvals.filter((a) => a.status === "approved"))
        for (const vote of approval.votes as BusinessVote[]) {
          blocked.add(vote.subjectSeatId);
          blocked.add(vote.principalSeatId);
        }
      const bill = await ctx.db.get(row.billId as Id<"demoBills">);
      if (!bill) deny("bill_not_found", "Recognized bill is missing");
      const supplier = await currentSupplier(ctx, scope, bill.vendor);
      blocked.add(supplier.verifiedSeatId!);
      blocked.add(supplier.approvedSeatId!);
    }
  }
  if (blocked.has(actor.seatId))
    deny(
      "payment_segregation",
      "Field reviewers, bill approvers, supplier destination approvers and callback verifiers cannot release this payment",
    );
}
