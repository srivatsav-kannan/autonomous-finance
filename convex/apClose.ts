import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import { sourceDocumentSchema } from "../src/ap-system/contracts";
import {
  periodSchema,
  statementSchema,
  statementReviewSchema,
  closeProposalSchema,
  closeVoteSchema,
  closeActionSchema,
  type CloseAction,
} from "../src/ap-system/close-contracts";
import type { ApprovalStep } from "../src/ap-system/domain-contracts";
import type { BankScope } from "../src/integrations/contracts";
import { canonical, sha256Hex } from "./lib/kernel";
import {
  requirePaymentHuman,
  requirePaymentSeat,
  assertRowScope,
  accountingSeat,
  auditDemo,
} from "./lib/demoAuth";
import { appendDemoEntry } from "./lib/demoPost";
import { deny, replay, receipt } from "./lib/apSystem/shared";
import {
  requireBusinessPolicy,
  requireGroup,
  resolveVotePrincipal,
  assertApprovalVotes,
  assertIndependentVotes,
  type BusinessVote,
} from "./lib/apSystem/businessAuthority";
import {
  closeEvidence,
  retainCloseEvidence,
} from "./lib/apSystem/closeEvidence";
import {
  readPeriodView,
  periodFacts,
  compareStatement,
} from "./lib/apSystem/periodView";
import {
  validateAccrual,
  accrualReversalPlan,
  postAccrualReversal,
} from "./lib/apSystem/accruals";
import { CHART } from "../src/core/accounts";
const agent = { scope: scopeValidator, seatId: v.string(), token: v.string() };
async function evaluateAction(
  ctx: QueryCtx,
  scope: BankScope,
  action: CloseAction,
) {
  const policy = await requireBusinessPolicy(ctx, scope);
  let amountCents = 0,
    context: unknown = {};
  if (action.kind === "accrual") {
    const result = await validateAccrual(ctx, scope, action.accrual);
    amountCents = result.amountCents;
    context = {
      supplierHash: result.supplierHash,
      sourceSemanticHash: result.sourceSemanticHash,
    };
  }
  if (action.kind === "reverse_accrual") {
    await closeEvidence(ctx, scope, action.evidence);
    const plan = await accrualReversalPlan(
      ctx,
      scope,
      action.accrualId,
      action.quantity,
    );
    if (action.date < plan.row.date)
      deny("accrual_reversal_date", "Reversal cannot precede original accrual");
    amountCents = plan.amountCents;
    context = { accrualId: plan.row._id, reversed: plan.row.reversedCents };
  }
  if (action.kind === "adjustment") {
    await closeEvidence(ctx, scope, action.evidence);
    const id = ctx.db.normalizeId("journalEntries", action.originalEntryId);
    const original = id ? await ctx.db.get(id) : null;
    if (
      !original ||
      original.runId !== scope.runId ||
      original.status !== "posted" ||
      action.date < original.date ||
      action.fromAccount === action.toAccount ||
      !original.lines.some(
        (l) => l.account === action.fromAccount && l.debit > 0,
      )
    )
      deny(
        "adjustment_original",
        "Reclassification needs an original live cost debit and a later/open accounting date",
      );
    for (const code of [action.fromAccount, action.toAccount]) {
      const chart = CHART.find((c) => c.code === code);
      if (
        !chart ||
        chart.cash ||
        !["asset", "expense"].includes(chart.type) ||
        !policy.value.accounts.some((a) => a.account === code)
      )
        deny(
          "adjustment_account",
          "Controlled reclassification cannot change cash/AP/accrued liabilities or unknown cost accounts",
        );
    }
    if (action.store !== null && !policy.value.stores.includes(action.store))
      deny("adjustment_store", "Store is outside coding policy");
    if (["ap_accrual", "ap_accrual_reversal"].includes(original.source.kind))
      deny(
        "adjustment_accrual_hold",
        "Accrual cost classification must be resolved through its exact approved reversal and a corrected accrual; a separate reclassification would break invoice reversal allocations",
      );
    const originalBill = (
      await ctx.db
        .query("demoBills")
        .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
        .collect()
    ).find((b) => b.entryId === original._id);
    const credits = originalBill
      ? await ctx.db
          .query("apCreditLinks")
          .withIndex("by_original", (q) =>
            q
              .eq("scope.runId", scope.runId)
              .eq("originalBillId", originalBill._id),
          )
          .collect()
      : [];
    const creditedCost = credits
      .flatMap(
        (c) =>
          c.allocations as {
            account: string;
            store: string | null;
            amountCents: number;
            side: "debit" | "credit";
          }[],
      )
      .filter(
        (a) => a.account === action.fromAccount && a.store === action.store,
      )
      .reduce(
        (n, a) => n + (a.side === "credit" ? a.amountCents : -a.amountCents),
        0,
      );
    const available = original.lines
      .filter(
        (l) =>
          l.account === action.fromAccount &&
          (l.dims?.store ?? null) === action.store,
      )
      .reduce((n, l) => n + l.debit - l.credit, 0);
    const prior = (
      await ctx.db
        .query("apCloseActions")
        .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
        .collect()
    )
      .filter(
        (r) =>
          r.status === "approved" &&
          r.kind === "adjustment" &&
          r.payload.originalEntryId === original._id &&
          r.payload.fromAccount === action.fromAccount &&
          r.payload.store === action.store,
      )
      .reduce((n, r) => n + r.amountCents, 0);
    if (prior + creditedCost + action.amountCents > available)
      deny(
        "adjustment_exceeds_original",
        "Cumulative reclassification exceeds original supported allocation",
      );
    amountCents = action.amountCents;
    context = { hash: original.hash, prior, creditedCost };
  }
  if (action.kind === "disposition") {
    await closeEvidence(ctx, scope, action.evidence);
    const facts = await periodFacts(ctx, scope, action.period);
    if (
      action.snapshotHash !== facts.factsHash ||
      !facts.blockers.some(
        (b) =>
          b.reference === action.reference &&
          [
            "source_disposition_required",
            "disputed_portion",
            "received_not_invoiced",
          ].includes(b.code),
      )
    )
      deny(
        "disposition_binding",
        "Only an exact current source/disputed/received-unit blocker may receive a supported disposition",
      );
    context = { snapshot: facts.factsHash };
  }
  if (action.kind === "close") {
    const view = await readPeriodView(ctx, scope, action.period);
    if (
      view.status !== "open" ||
      !view.ready ||
      view.snapshotHash !== action.snapshotHash
    )
      deny(
        "close_not_ready",
        `Close snapshot changed or has blockers: ${view.blockers.map((b) => b.code).join(",")}`,
      );
    const proof = await closeEvidence(ctx, scope, action.opening.evidence);
    if (proof.some((p) => !["other", "correction"].includes(p.kind)))
      deny(
        "opening_balance_evidence",
        "Opening cash/AP/accrual review needs retained bank/opening-ledger evidence, separate from invoices",
      );
    const sorted = (a: typeof view.opening.cashBalances) =>
      a.slice().sort((x, y) => x.account.localeCompare(y.account));
    if (
      action.opening.apCents !== view.opening.apCents ||
      action.opening.accruedCents !== view.opening.accruedCents ||
      canonical(sorted(action.opening.cashBalances)) !==
        canonical(sorted(view.opening.cashBalances))
    )
      deny(
        "opening_balance_mismatch",
        "Opening review must reconcile all configured cash accounts, AP and accrued liabilities including prior periods; zero is not assumed",
      );
    context = { snapshot: view.snapshotHash };
  }
  if (action.kind === "reopen") {
    await closeEvidence(ctx, scope, action.evidence);
    const periods = await ctx.db
      .query("periods")
      .withIndex("by_run_period", (q) => q.eq("runId", scope.runId))
      .collect();
    const period = periods.find((p) => p.period === action.period);
    const id = ctx.db.normalizeId("apCloseActions", action.closeActionId);
    const close = id ? await ctx.db.get(id) : null;
    if (
      !period ||
      period.status !== "closed" ||
      !close ||
      close.scope.runId !== scope.runId ||
      close.kind !== "close" ||
      close.status !== "approved" ||
      close.payload.period !== action.period ||
      period.closeSnapshotHash !== close.payload.snapshotHash
    )
      deny(
        "reopen_binding",
        "Reopen must reference the exact latest approved close",
      );
    if (periods.some((p) => p.period > action.period && p.status === "closed"))
      deny(
        "later_period_closed",
        "Reopen later closed periods first so carried opening balances cannot silently change",
      );
    context = { closeActionId: close._id, snapshot: period.closeSnapshotHash };
  }
  return {
    policy,
    amountCents,
    contextHash: await sha256Hex(canonical(context)),
  };
}
export const retainEvidence = mutation({
  args: { ...agent, source: v.any() },
  handler: async (ctx, args) => {
    await requirePaymentSeat(ctx, args, ["controller", "ap_clerk"]);
    const source = sourceDocumentSchema.parse(args.source);
    await retainCloseEvidence(ctx, args.scope, source);
    return {
      sourceId: source.sourceId,
      revision: source.revision,
      sha256: source.sha256,
    };
  },
});
export const proposeStatement = mutation({
  args: { ...agent, idempotencyKey: v.string(), statement: v.any() },
  handler: async (ctx, args) => {
    const { seat } = await requirePaymentSeat(ctx, args, ["controller"]);
    await requireBusinessPolicy(ctx, args.scope);
    const statement = statementSchema.parse(args.statement);
    const op = await replay(
      ctx,
      args.scope,
      `statement:${args.idempotencyKey}`,
      { statement, actor: seat.seatId },
    );
    if (op.prior) return op.prior.result;
    const [source] = await closeEvidence(ctx, args.scope, [statement.source]);
    if (!source || !["other", "correction"].includes(source.kind))
      deny(
        "statement_original",
        "Supplier statement requires its own retained original",
      );
    const existing = await ctx.db
      .query("apSupplierStatements")
      .withIndex("by_period", (q) =>
        q.eq("scope.runId", args.scope.runId).eq("period", statement.period),
      )
      .collect();
    for (const row of existing.filter(
      (r) => r.supplierId === statement.supplierId && r.status !== "superseded",
    ))
      await ctx.db.patch(row._id, { status: "superseded" });
    const hash = await sha256Hex(canonical(statement));
    const statementId = await ctx.db.insert("apSupplierStatements", {
      scope: args.scope,
      supplierId: statement.supplierId,
      period: statement.period,
      payload: statement,
      hash,
      status: "proposed",
      proposedBy: seat.seatId,
      createdAt: Date.now(),
    });
    const result = { statementId, statementHash: hash };
    await receipt(
      ctx,
      args.scope,
      `statement:${args.idempotencyKey}`,
      op.payloadHash,
      result,
    );
    return result;
  },
});
export const reviewStatement = mutation({
  args: { scope: scopeValidator, input: v.any() },
  handler: async (ctx, args) => {
    const { seat, subject } = await requirePaymentHuman(ctx, args.scope);
    const policy = await requireBusinessPolicy(ctx, args.scope);
    requireGroup(policy.value, policy.value.varianceApprovalGroup, subject);
    const request = statementReviewSchema.parse(args.input);
    const op = await replay(
      ctx,
      args.scope,
      `statement-review:${request.idempotencyKey}`,
      { request, subject },
    );
    if (op.prior) return op.prior.result;
    const id = ctx.db.normalizeId("apSupplierStatements", request.statementId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row) deny("statement_missing", "Statement not found");
    assertRowScope(row, args.scope);
    if (
      row.hash !== request.statementHash ||
      row.status === "superseded" ||
      row.proposedBy === seat.seatId
    )
      deny(
        "statement_review_binding",
        "Independent review must bind the current statement hash",
      );
    const facts = await periodFacts(ctx, args.scope, row.period);
    if (facts.factsHash !== request.snapshotHash)
      deny(
        "stale_statement_review",
        "Reconciliation changed after statement review",
      );
    const differences = compareStatement(
      statementSchema.parse(row.payload),
      facts,
    );
    if (
      differences.some(
        (d) =>
          d.discrepancyId === "arithmetic" ||
          d.discrepancyId.startsWith("duplicate:") ||
          d.discrepancyId.startsWith("date:"),
      )
    )
      deny(
        "statement_structure",
        "Fix malformed arithmetic, dates or duplicate economic lines in a new statement proposal",
      );
    if (
      new Set(request.resolutions.map((r) => r.discrepancyId)).size !==
        request.resolutions.length ||
      request.resolutions.length !== differences.length ||
      differences.some(
        (d) =>
          !request.resolutions.some((r) => r.discrepancyId === d.discrepancyId),
      )
    )
      deny(
        "statement_difference_review",
        "Every exact statement discrepancy requires a supported explicit human resolution",
      );
    for (const resolution of request.resolutions)
      await closeEvidence(ctx, args.scope, resolution.evidence);
    await ctx.db.patch(row._id, {
      status: "reviewed",
      review: request,
      reviewedBy: subject,
      reviewedSeatId: seat.seatId,
      reviewPolicyHash: policy.hash,
      reviewedAt: Date.now(),
      reviewSnapshotHash: facts.factsHash,
    });
    const result = { statementId: row._id, status: "reviewed" };
    await receipt(
      ctx,
      args.scope,
      `statement-review:${request.idempotencyKey}`,
      op.payloadHash,
      result,
    );
    await auditDemo(ctx, args.scope, subject, "supplier_statement_reviewed", {
      statementId: row._id,
      snapshotHash: facts.factsHash,
      resolutions: request.resolutions,
    });
    return result;
  },
});
export const propose = mutation({
  args: { ...agent, input: v.any() },
  handler: async (ctx, args) => {
    const { seat } = await requirePaymentSeat(ctx, args, ["controller"]);
    const request = closeProposalSchema.parse(args.input);
    const op = await replay(
      ctx,
      args.scope,
      `close-propose:${request.idempotencyKey}`,
      { request, actor: seat.seatId },
    );
    if (op.prior) return op.prior.result;
    const result = await evaluateAction(ctx, args.scope, request.action);
    const governance = ["close", "reopen"].includes(request.action.kind);
    const route: ApprovalStep[] = governance
      ? [
          {
            groupId: result.policy.value.supplierApprovalGroup,
            quorum: 1,
            escalateAfterMs: 86400000,
            escalationGroupId: null,
          },
        ]
      : request.action.kind === "disposition"
        ? [
            {
              groupId: result.policy.value.varianceApprovalGroup,
              quorum: 1,
              escalateAfterMs: 86400000,
              escalationGroupId: null,
            },
          ]
        : structuredClone(
            result.policy.value.bands.find(
              (b) => b.upToCents >= result.amountCents,
            )!.steps,
          );
    if (
      ["adjustment", "reverse_accrual"].includes(request.action.kind) &&
      !route.some(
        (s) => s.groupId === result.policy.value.varianceApprovalGroup,
      )
    )
      route.push({
        groupId: result.policy.value.varianceApprovalGroup,
        quorum: 1,
        escalateAfterMs: 86400000,
        escalationGroupId: null,
      });
    const hash = await sha256Hex(
      canonical({
        action: request.action,
        policyHash: result.policy.hash,
        contextHash: result.contextHash,
        amountCents: result.amountCents,
        route,
      }),
    );
    const actionId = await ctx.db.insert("apCloseActions", {
      scope: args.scope,
      kind: request.action.kind,
      payload: request.action,
      hash,
      policyHash: result.policy.hash,
      contextHash: result.contextHash,
      amountCents: result.amountCents,
      route,
      stage: 0,
      stageStartedAt: Date.now(),
      votes: [],
      status: "proposed",
      proposedBy: seat.seatId,
      createdAt: Date.now(),
    });
    const response = {
      actionId,
      actionHash: hash,
      route,
      amountCents: result.amountCents,
    };
    await receipt(
      ctx,
      args.scope,
      `close-propose:${request.idempotencyKey}`,
      op.payloadHash,
      response,
    );
    return response;
  },
});
export const vote = mutation({
  args: { scope: scopeValidator, input: v.any() },
  handler: async (ctx, args) => {
    const { seat, subject } = await requirePaymentHuman(ctx, args.scope);
    const request = closeVoteSchema.parse(args.input);
    const op = await replay(
      ctx,
      args.scope,
      `close-vote:${request.idempotencyKey}`,
      { request, subject },
    );
    if (op.prior) return op.prior.result;
    const id = ctx.db.normalizeId("apCloseActions", request.actionId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row) deny("close_action_missing", "Close action not found");
    assertRowScope(row, args.scope);
    if (
      row.hash !== request.actionHash ||
      row.status !== "proposed" ||
      row.proposedBy === seat.seatId
    )
      deny(
        "close_action_binding",
        "Exact proposed action and independent human approval required",
      );
    const action = closeActionSchema.parse(row.payload),
      evaluation = await evaluateAction(ctx, args.scope, action);
    if (
      evaluation.policy.hash !== row.policyHash ||
      evaluation.contextHash !== row.contextHash ||
      evaluation.amountCents !== row.amountCents
    )
      deny(
        "stale_close_action",
        "Policy, original accounting or period evidence changed after proposal",
      );
    const principal = await resolveVotePrincipal(
      ctx,
      args.scope,
      evaluation.policy.value,
      row,
      subject,
      request.delegationId,
    );
    if (principal.principalSeatId === row.proposedBy)
      deny(
        "self_approval",
        "Proposer cannot authorize through delegated principal",
      );
    const votes = row.votes as BusinessVote[];
    if (
      votes.some(
        (v) =>
          v.subject === subject ||
          v.principal === principal.principal ||
          v.subject === principal.principal ||
          v.principal === subject,
      )
    )
      deny(
        "approval_segregation",
        "One human/principal cannot fill multiple close approval positions",
      );
    if (request.outcome === "rejected") {
      await ctx.db.patch(row._id, {
        status: "rejected",
        completedAt: Date.now(),
        approvedBy: subject,
      });
      const result = { actionId: row._id, status: "rejected" };
      await receipt(
        ctx,
        args.scope,
        `close-vote:${request.idempotencyKey}`,
        op.payloadHash,
        result,
      );
      return result;
    }
    const nextVotes = [
      ...votes,
      {
        subject,
        ...principal,
        stage: row.stage,
        stageStartedAt: row.stageStartedAt,
        at: Date.now(),
        delegationId: request.delegationId ?? null,
      },
    ];
    await assertIndependentVotes(ctx, args.scope, nextVotes);
    const route = row.route as ApprovalStep[],
      completed =
        nextVotes.filter((v) => v.stage === row.stage).length >=
        route[row.stage]!.quorum,
      stage = completed ? row.stage + 1 : row.stage;
    if (stage < route.length) {
      await ctx.db.patch(row._id, {
        votes: nextVotes,
        stage,
        stageStartedAt: completed ? Date.now() : row.stageStartedAt,
      });
      const result = { actionId: row._id, status: "proposed", stage };
      await receipt(
        ctx,
        args.scope,
        `close-vote:${request.idempotencyKey}`,
        op.payloadHash,
        result,
      );
      return result;
    }
    await assertApprovalVotes(ctx, args.scope, evaluation.policy.value, {
      ...row,
      votes: nextVotes,
    });
    let entryId: Id<"journalEntries"> | undefined;
    let result: Record<string, unknown> = {
      actionId: row._id,
      status: "approved",
    };
    if (action.kind === "accrual") {
      const a = action.accrual;
      const posted = await appendDemoEntry(ctx, {
        runId: args.scope.runId,
        seat: accountingSeat(args.scope.runId),
        date: a.date,
        memo: `Received not invoiced: ${a.description}`,
        source: { kind: "ap_accrual", ref: row._id },
        lines: [
          ...a.allocations
            .filter((a) => a.amountCents > 0)
            .map((x) => ({
              account: x.account,
              debit: x.amountCents,
              credit: 0,
              dims: {
                vendor: a.supplierId,
                ...(x.store ? { store: x.store } : {}),
              },
            })),
          {
            account: "2010",
            debit: 0,
            credit: row.amountCents,
            dims: { vendor: a.supplierId },
          },
        ],
        idempotencyKey: `ap:accrual:${row._id}`,
        decisionPath: row._id,
      });
      if (!posted.ok) deny(posted.code, posted.error);
      entryId = posted.entryId;
      const accrualId = await ctx.db.insert("apAccruals", {
        scope: args.scope,
        actionId: row._id,
        payload: a,
        supplierId: a.supplierId,
        sourceId: a.source.sourceId,
        sourceLineId: a.lineId,
        sourceSemanticHash: (await validateAccrual(ctx, args.scope, a))
          .sourceSemanticHash,
        quantity: a.quantity,
        amountCents: row.amountCents,
        reversedQuantity: "0",
        reversedCents: 0,
        entryId,
        date: a.date,
        ...(a.expectedInvoiceCaseId
          ? {
              expectedInvoiceCaseId: ctx.db.normalizeId(
                "apCaseRecords",
                a.expectedInvoiceCaseId,
              )!,
            }
          : {}),
        createdAt: Date.now(),
      });
      result = { ...result, accrualId, entryId };
    }
    if (action.kind === "reverse_accrual") {
      const plan = await accrualReversalPlan(
        ctx,
        args.scope,
        action.accrualId,
        action.quantity,
      );
      entryId = await postAccrualReversal(
        ctx,
        args.scope,
        plan,
        action.date,
        `ap:accrual-reversal:${row._id}`,
        { actionId: row._id },
      );
      result = { ...result, entryId };
    }
    if (action.kind === "adjustment") {
      const original = await ctx.db.get(
        ctx.db.normalizeId("journalEntries", action.originalEntryId)!,
      );
      const originalLine = original!.lines.find(
        (l) =>
          l.account === action.fromAccount &&
          (l.dims?.store ?? null) === action.store,
      )!;
      const dims = {
        ...(originalLine.dims?.vendor
          ? { vendor: originalLine.dims.vendor }
          : {}),
        ...(action.store ? { store: action.store } : {}),
      };
      const posted = await appendDemoEntry(ctx, {
        runId: args.scope.runId,
        seat: accountingSeat(args.scope.runId),
        date: action.date,
        memo: `Controlled reclassification: ${action.reason}`,
        source: { kind: "ap_cost_adjustment", ref: action.originalEntryId },
        lines: [
          {
            account: action.toAccount,
            debit: action.amountCents,
            credit: 0,
            dims,
          },
          {
            account: action.fromAccount,
            debit: 0,
            credit: action.amountCents,
            dims,
          },
        ],
        idempotencyKey: `ap:adjustment:${row._id}`,
        decisionPath: row._id,
      });
      if (!posted.ok) deny(posted.code, posted.error);
      entryId = posted.entryId;
      result = { ...result, entryId };
    }
    if (action.kind === "close" || action.kind === "reopen") {
      const period = await ctx.db
        .query("periods")
        .withIndex("by_run_period", (q) =>
          q.eq("runId", args.scope.runId).eq("period", action.period),
        )
        .unique();
      if (action.kind === "close") {
        result = {
          ...result,
          closeSnapshot: await readPeriodView(ctx, args.scope, action.period),
        };
        const head = await ctx.db
          .query("ledgerHeads")
          .withIndex("by_run", (q) => q.eq("runId", args.scope.runId))
          .unique();
        await ctx.db.patch(period!._id, {
          status: "closed",
          closedBy: [row.proposedBy, ...nextVotes.map((v) => v.subject)],
          closedAt: Date.now(),
          closeSnapshotHash: action.snapshotHash,
          ledgerHead: head?.hash,
        });
      } else
        await ctx.db.patch(period!._id, {
          status: "open",
          closedBy: [],
          closedAt: undefined,
          closeSnapshotHash: undefined,
        });
      result = {
        ...result,
        period: action.period,
        periodStatus: action.kind === "close" ? "closed" : "open",
      };
    }
    await ctx.db.patch(row._id, {
      status: "approved",
      votes: nextVotes,
      stage,
      completedAt: Date.now(),
      approvedBy: subject,
      ...(entryId ? { entryId } : {}),
      result,
    });
    await auditDemo(ctx, args.scope, subject, `ap_close_${action.kind}`, {
      actionId: row._id,
      reason: request.reason,
      result,
    });
    await receipt(
      ctx,
      args.scope,
      `close-vote:${request.idempotencyKey}`,
      op.payloadHash,
      result,
    );
    return result;
  },
});
export const view = query({
  args: { scope: scopeValidator, period: v.string() },
  handler: async (ctx, args) => {
    await requirePaymentHuman(ctx, args.scope);
    const period = periodSchema.parse(args.period);
    return {
      ...(await readPeriodView(ctx, args.scope, period)),
      actions: await ctx.db
        .query("apCloseActions")
        .withIndex("by_run", (q) => q.eq("scope.runId", args.scope.runId))
        .collect(),
      retainedSources: (
        await ctx.db
          .query("apCaseSources")
          .withIndex("by_source", (q) => q.eq("scope.runId", args.scope.runId))
          .collect()
      ).map((s) => ({
        sourceId: s.sourceId,
        revision: s.revision,
        sha256: s.sha256,
        name: s.document.name,
        kind: s.document.kind,
        pageStatus: s.document.pageStatus,
      })),
      statementRecords: await ctx.db
        .query("apSupplierStatements")
        .withIndex("by_period", (q) =>
          q.eq("scope.runId", args.scope.runId).eq("period", period),
        )
        .collect(),
    };
  },
});
