import { derivePaymentAccountingBinding } from "./lib/apSystem/paymentAccountingBinding";
import { assertGovernedCredits } from "./lib/apSystem/governedCredits";
import { acceptanceAllocations, settlementDimensions, payableDimensions } from "../src/ap-system/settlement-dimensions";
import { originalSettlementDimensions } from "./lib/apSystem/settlementDimensions";
import { journalDimensions } from "../src/ap-system/gl-dimensions";
import {
  validateInvoiceAccruals,
  postAccrualReversal,
} from "./lib/apSystem/accruals";
import { invalidateBusinessPayments } from "./lib/apSystem/businessInvalidation";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import {
  requirePaymentHuman,
  requirePaymentSeat,
  assertRowScope,
  accountingSeat,
  auditDemo,
} from "./lib/demoAuth";
import { appendDemoEntry } from "./lib/demoPost";
import { canonical, sha256Hex } from "./lib/kernel";
import { normalizeInvoiceNumber } from "./lib/invoiceIdentity";
import {
  intakeSchema,
  decisionSchema,
  type APDecision,
} from "../src/ap-system/contracts";
import {
  domainRequestSchema,
  domainVoteSchema,
  type DomainRequest,
  type ApprovalStep,
} from "../src/ap-system/domain-contracts";
import {
  evaluateBusinessAcceptance,
  acceptanceJournal,
} from "../src/ap-system/business-policy";
import { sumCents } from "../src/ap-system/accounting";
import {
  bindings,
  caseRow,
  deny,
  replay,
  receipt,
  readAuth,
} from "./lib/apSystem/shared";
import {
  requireBusinessPolicy,
  currentSupplier,
  resolveVotePrincipal,
  currentFieldReviewer,
  assertApprovalCurrent,
  assertApprovalVotes,
  assertIndependentVotes,
  type BusinessVote,
} from "./lib/apSystem/businessAuthority";
import {
  assertConsumptions,
  saveConsumptions,
  economicAcceptance,
  evaluateCredit,
} from "./lib/apSystem/businessLedger";
const agent = { scope: scopeValidator, seatId: v.string(), token: v.string() };
type Ctx = Parameters<typeof requireBusinessPolicy>[0];
type Scope = Parameters<typeof requireBusinessPolicy>[1];
async function evaluate(ctx: Ctx, scope: Scope, request: DomainRequest) {
  const row = await caseRow(ctx, scope, request.caseId);
  if(row.historicalPayment)deny("historical_source_paid","Imported source-paid invoices cannot be recognized or paid again");
  if (
    row.currentRevision !== request.expectedRevision ||
    row.snapshotHash !== request.snapshotHash ||
    row.documentStatus !== "reviewed" ||
    !row.fieldReviewId
  )
    deny(
      "stale_business_review",
      "Current field review and exact case snapshot are required",
    );
  const decision = (
    await ctx.db
      .query("apCaseDecisions")
      .withIndex("by_case", (q) =>
        q.eq("scope.runId", scope.runId).eq("caseId", row._id),
      )
      .collect()
  )
    .map((d) => decisionSchema.parse(d.decision))
    .find((d) => d.decisionId === row.fieldReviewId);
  if (
    !decision ||
    decision.kind !== "field_review" ||
    decision.outcome !== "approved" ||
    decision.snapshotHash !== row.snapshotHash ||
    decision.candidateRevision !== row.currentRevision
  )
    deny(
      "stale_field_review",
      "Field review does not bind this source revision",
    );
  const input = intakeSchema.parse(row.intake);
  if (!input.candidate?.supplierId)
    deny("unverified_supplier", "Candidate has no verified supplier identity");
  const policy = await requireBusinessPolicy(ctx, scope);
  if (
    request.accountingDate &&
    (!row.intake.candidate ||
      request.accountingDate < row.intake.candidate.invoiceDate)
  )
    deny(
      "accounting_date",
      "Explicit accounting date cannot precede the original invoice date",
    );
  const supplier = await currentSupplier(
    ctx,
    scope,
    input.candidate.supplierId,
  );
  if (
    policy.version !== request.policyVersion ||
    supplier.revision !== request.supplierRevision
  )
    deny(
      "stale_business_context",
      "Policy/supplier revision changed before this proposal",
    );
  if (request.acceptance) {
    const result = evaluateBusinessAcceptance(
      input,
      request.acceptance,
      policy.value,
      supplier.value,
      true,
      request.accountingDate,
    );
    if (result.exceptions.length)
      deny(
        "business_policy_hold",
        result.exceptions.map((e) => `${e.code}: ${e.reason}`).join("; "),
      );
    await assertConsumptions(ctx, scope, row._id, result.consumptions, input);
    if (row.billId) {
      const bill = await ctx.db.get(row.billId);
      assertRowScope(bill, scope);
      const recognition = bill!.entryId
        ? await ctx.db.get(bill!.entryId)
        : null;
      if (
        recognition &&
        recognition.date !==
          (request.accountingDate ?? input.candidate!.invoiceDate)
      )
        deny(
          "recognized_date_immutable",
          "Recertification cannot change the original accounting date; use an approved correction",
        );
      if (bill!.reservedVersionId)
        deny(
          "bill_reserved",
          "Resolve the existing payment before changing its business authority",
        );
      if (bill!.approvedCents !== result.amountCents)
        deny(
          "posted_correction_required",
          "A changed recognized amount requires a linked credit or separately supported correction",
        );
      const existing = (
        await ctx.db
          .query("apApprovalProposals")
          .withIndex("by_case", (q) =>
            q.eq("scope.runId", scope.runId).eq("caseId", row._id),
          )
          .collect()
      ).find((p) => p.status === "approved" && p.entryId === bill!.entryId);
      if (existing) {
        const old = domainRequestSchema.parse(existing.request).acceptance;
        const originalDimension = old ? await originalSettlementDimensions(ctx, scope, existing, acceptanceAllocations(old)) : undefined;
        if (canonical(originalDimension ?? null) !== canonical(settlementDimensions(acceptanceAllocations(request.acceptance), policy.value) ?? null))
          deny("posted_settlement_scope_change", "Recertification cannot change original settlement scope or department");
        if (
          !old ||
          canonical(economicAcceptance(old)) !==
            canonical(economicAcceptance(request.acceptance))
        )
          deny(
            "posted_allocation_change",
            "Recertification cannot rewrite recognized allocations or consumed quantities",
          );
      } else {
        const journal = await ctx.db.get(bill!.entryId!);
        const actual = journal!.lines.map((l) => ({
          account: l.account,
          debit: l.debit,
          credit: l.credit,
          dims: l.dims,
        }));
        const proposed = acceptanceJournal(
          request.acceptance,
          supplier.supplierId,
          false, settlementDimensions(acceptanceAllocations(request.acceptance), policy.value),
        ).map((l) => ({
          account: l.account,
          debit: l.debit,
          credit: l.credit,
          dims: l.dims,
        }));
        if (canonical(actual) !== canonical(proposed))
          deny(
            "posted_allocation_change",
            "Legacy recertification must preserve exact original journal allocations",
          );
      }
    }
    return {
      row,
      input,
      policy,
      supplier,
      amountCents: result.amountCents,
      taxApprovalGroups: result.taxApprovalGroups,
      varianceRequired:
        result.varianceRequired ||
        !!request.accrualApplications?.some((a) => a.correction) ||
        !!(
          request.accountingDate &&
          request.accountingDate !== input.candidate!.invoiceDate
        ),
      consumptions: result.consumptions,
      accrualPlans: row.billId
        ? []
        : await validateInvoiceAccruals(
            ctx,
            scope,
            row,
            request.acceptance,
            request.accrualApplications ?? [],
            request.accountingDate ?? input.candidate!.invoiceDate,
          ),
      credit: null,
    };
  }
  if (row.creditId)
    deny(
      "credit_already_recognized",
      "Existing credit recognition is immutable; replay its original approval",
    );
  const supplierNames = [
    supplier.value.legalName,
    ...supplier.value.aliases,
  ].map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ""));
  if (
    !supplierNames.includes(
      input.candidate.extractedSupplierName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ""),
    )
  )
    deny(
      "credit_supplier_mismatch",
      "Credit source name differs from verified supplier aliases",
    );
  const credit = await evaluateCredit(
    ctx,
    scope,
    input,
    request.credit!,
    row._id,
    request.accountingDate ?? input.candidate.invoiceDate,
  );
  return {
    row,
    input,
    policy,
    supplier,
    amountCents: credit.amountCents,
    taxApprovalGroups: credit.taxApprovalGroups,
    varianceRequired:
      !!request.credit!.correction ||
      request.credit!.lines.some((l) => l.basis !== "quantity_return") ||
      !!(
        request.accountingDate &&
        request.accountingDate !== input.candidate!.invoiceDate
      ),
    consumptions: [],
    accrualPlans: [],
    credit,
  };
}
export const propose = mutation({
  args: { ...agent, input: v.any() },
  handler: async (ctx, args) => {
    const { seat } = await requirePaymentSeat(ctx, args, [
      "ap_clerk",
      "controller",
    ]);
    const request = domainRequestSchema.parse(args.input);
    const op = await replay(
      ctx,
      args.scope,
      `business-propose:${request.idempotencyKey}`,
      { request, actor: seat.seatId },
    );
    if (op.prior) return op.prior.result;
    const result = await evaluate(ctx, args.scope, request);
    const route: ApprovalStep[] = structuredClone(
      result.policy.value.bands.find((b) => b.upToCents >= result.amountCents)!
        .steps,
    );
    if (
      result.varianceRequired &&
      !route.some(
        (s) => s.groupId === result.policy.value.varianceApprovalGroup,
      )
    )
      route.push({
        groupId: result.policy.value.varianceApprovalGroup,
        quorum: 1,
        escalateAfterMs: 24 * 60 * 60_000,
        escalationGroupId: null,
      });
    for (const groupId of result.taxApprovalGroups)
      route.push({ groupId, quorum: 1, escalateAfterMs: 24 * 60 * 60_000, escalationGroupId: null });
    const hash = await sha256Hex(
      canonical({
        request,
        policyHash: result.policy.hash,
        supplierHash: result.supplier.hash,
        amountCents: result.amountCents,
        route,
      }),
    );
    if (result.row.domainApprovalId) {
      const prior = await ctx.db.get(result.row.domainApprovalId);
      if (prior?.status === "pending")
        await ctx.db.patch(prior._id, { status: "superseded" });
    }
    const proposalId = await ctx.db.insert("apApprovalProposals", {
      scope: args.scope,
      caseId: result.row._id,
      request,
      hash,
      policyHash: result.policy.hash,
      supplierHash: result.supplier.hash,
      amountCents: result.amountCents,
      route,
      stage: 0,
      stageStartedAt: Date.now(),
      votes: [],
      status: "pending",
      proposedBy: seat.seatId,
      createdAt: Date.now(),
    });
    await ctx.db.patch(result.row._id, {
      domainApprovalId: proposalId,
      businessStatus: "held",
      updatedAt: Date.now(),
    });
    await invalidateBusinessPayments(
      ctx,
      args.scope,
      result.supplier.supplierId,
    );
    const response = {
      proposalId,
      proposalHash: hash,
      amountCents: result.amountCents,
      route,
    };
    await receipt(
      ctx,
      args.scope,
      `business-propose:${request.idempotencyKey}`,
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
    const request = domainVoteSchema.parse(args.input);
    const op = await replay(
      ctx,
      args.scope,
      `business-vote:${request.idempotencyKey}`,
      { request, subject },
    );
    if (op.prior) return op.prior.result;
    const id = ctx.db.normalizeId("apApprovalProposals", request.proposalId);
    const proposal = id ? await ctx.db.get(id) : null;
    if (!proposal)
      deny("proposal_not_found", "Business approval proposal not found");
    assertRowScope(proposal, args.scope);
    if (proposal.hash !== request.proposalHash || proposal.status !== "pending")
      deny(
        "stale_business_proposal",
        "Exact pending business proposal required",
      );
    const domain = domainRequestSchema.parse(proposal.request);
    const result = await evaluate(ctx, args.scope, domain);
    if (
      result.row.domainApprovalId !== proposal._id ||
      proposal.policyHash !== result.policy.hash ||
      proposal.supplierHash !== result.supplier.hash
    )
      deny("stale_business_proposal", "Case policy/supplier/proposal changed");
    if (
      proposal.proposedBy === seat.seatId ||
      result.row.createdBy === seat.seatId
    )
      deny(
        "self_approval",
        "Request/case creator cannot approve their own business proposal",
      );
    const { principal, groupId, subjectSeatId, principalSeatId } =
      await resolveVotePrincipal(
        ctx,
        args.scope,
        result.policy.value,
        proposal,
        subject,
        request.delegationId,
      );
    if (
      principalSeatId === proposal.proposedBy ||
      principalSeatId === result.row.createdBy
    )
      deny(
        "self_approval",
        "The request/case creator cannot approve through a delegated principal",
      );
    const fieldReviewer = await currentFieldReviewer(ctx, args.scope, result.row);
    if (fieldReviewer === subjectSeatId || fieldReviewer === principalSeatId)
      deny("approval_segregation", "The field reviewer cannot approve business recognition, including through delegation");
    const votes = proposal.votes as BusinessVote[];
    if (
      votes.some(
        (v) =>
          v.subject === subject ||
          v.principal === principal ||
          v.subject === principal ||
          v.principal === subject,
      )
    )
      deny(
        "approval_segregation",
        "One human or delegated principal cannot fill multiple approval positions",
      );
    if (request.outcome === "rejected") {
      await ctx.db.patch(proposal._id, {
        status: "rejected",
        completedAt: Date.now(),
      });
      await ctx.db.patch(result.row._id, {
        businessStatus: "rejected",
        updatedAt: Date.now(),
      });
      await auditDemo(ctx, args.scope, subject, "business_proposal_rejected", {
        proposalId: proposal._id,
        reason: request.reason,
      });
      const response = { status: "rejected", proposalId: proposal._id };
      await receipt(
        ctx,
        args.scope,
        `business-vote:${request.idempotencyKey}`,
        op.payloadHash,
        response,
      );
      return response;
    }
    const nextVotes = [
      ...votes,
      {
        subject,
        principal,
        subjectSeatId,
        principalSeatId,
        groupId,
        stage: proposal.stage,
        stageStartedAt: proposal.stageStartedAt,
        at: Date.now(),
        delegationId: request.delegationId ?? null,
      },
    ];
    await assertIndependentVotes(ctx, args.scope, nextVotes);
    const route = proposal.route as ApprovalStep[];
    const completeStage =
      nextVotes.filter((v) => v.stage === proposal.stage).length >=
      route[proposal.stage]!.quorum;
    const stage = completeStage ? proposal.stage + 1 : proposal.stage;
    if (stage < route.length) {
      await ctx.db.patch(proposal._id, {
        votes: nextVotes,
        stage,
        stageStartedAt: completeStage ? Date.now() : proposal.stageStartedAt,
      });
      await auditDemo(ctx, args.scope, subject, "business_approval_recorded", {
        proposalId: proposal._id,
        stage: proposal.stage,
        reason: request.reason,
      });
      const response = { status: "pending", proposalId: proposal._id, stage };
      await receipt(
        ctx,
        args.scope,
        `business-vote:${request.idempotencyKey}`,
        op.payloadHash,
        response,
      );
      return response;
    }
    await assertApprovalVotes(ctx, args.scope, result.policy.value, {
      ...proposal,
      votes: nextVotes,
    });
    const c = result.input.candidate!;
    let entryId: Id<"journalEntries">;
    let billId = result.row.billId;
    let creditId: Id<"demoCredits"> | undefined;
    if (domain.acceptance) {
      if (!billId) {
        const invoiceNumber = normalizeInvoiceNumber(c.invoiceNumber);
        if (!invoiceNumber)
          deny(
            "invoice_identity_required",
            "Invoice number is empty after normalization",
          );
        const collision = await ctx.db
          .query("demoBills")
          .withIndex("by_invoice", (q) =>
            q
              .eq("scope.runId", args.scope.runId)
              .eq("vendor", result.supplier.supplierId)
              .eq("invoiceNumber", invoiceNumber),
          )
          .unique();
        if (collision)
          deny(
            "existing_obligation",
            "This supplier invoice already has a recognized obligation",
          );
        billId = await ctx.db.insert("demoBills", {
          scope: args.scope,
          vendor: result.supplier.supplierId,
          invoiceNumber,
          invoiceDate: c.invoiceDate,
          recordHash: proposal.hash,
          originalCents: c.totalCents,
          paidCents: 0,
          version: 1,
          evidence: bindings(result.input).map(
            (b) => `${b.sourceId}:${b.revision}:${b.sha256}`,
          ),
          flags: [],
          expenseAccount: domain.acceptance.lines
            .flatMap((l) => l.allocations)
            .find((a) => a.amountCents > 0)!.account,
          createdBy: result.row.createdBy,
          status: "recorded",
          createdAt: Date.now(),
        });
        for (const plan of result.accrualPlans)
          await postAccrualReversal(
            ctx,
            args.scope,
            plan,
            domain.accountingDate ?? c.invoiceDate,
            `ap:invoice-accrual:${result.row._id}:${plan.row._id}`,
            { caseId: result.row._id, billId },
          );
        const posted = await appendDemoEntry(ctx, {
          runId: args.scope.runId,
          seat: accountingSeat(args.scope.runId),
          date: domain.accountingDate ?? c.invoiceDate,
          memo: `Approved allocated invoice ${c.supplierId}/${c.invoiceNumber}`,
          source: { kind: "bill", ref: billId },
          lines: acceptanceJournal(
            domain.acceptance,
            result.supplier.supplierId,
            false, settlementDimensions(acceptanceAllocations(domain.acceptance), result.policy.value),
          ),
          idempotencyKey: `ap:recognition:${result.row._id}`,
          decisionPath: proposal._id,
        });
        if (!posted.ok) deny(posted.code, posted.error);
        entryId = posted.entryId;
        await ctx.db.patch(billId, {
          approvedCents: result.amountCents,
          status: "approved",
          version: 2,
          entryId,
        });
      } else {
        const bill = await ctx.db.get(billId);
        entryId = bill!.entryId!;
        await ctx.db.patch(billId, {
          flags: bill!.flags.filter(
            (f) => f !== "ap_case_revision_requires_review",
          ),
          version: bill!.version + 1,
        });
      }
      await saveConsumptions(
        ctx,
        args.scope,
        result.row._id,
        billId,
        proposal._id,
        result.consumptions,
        result.input,
      );
      await ctx.db.patch(result.row._id, {
        billId,
        acceptedCents: result.amountCents,
        businessStatus: "approved",
        updatedAt: Date.now(),
      });
    } else {
      const credit = result.credit!;
      const reference = normalizeInvoiceNumber(c.invoiceNumber);
      const existing = await ctx.db
        .query("demoCredits")
        .withIndex("by_reference", (q) =>
          q
            .eq("scope.runId", args.scope.runId)
            .eq("vendor", c.supplierId!)
            .eq("reference", reference),
        )
        .unique();
      if (existing)
        deny(
          "credit_reference_duplicate",
          "This supplier credit reference already has a monetary recognition",
        );
      const lines = credit.allocations.map((a) => ({
        account: a.account,
        debit: a.side === "debit" ? a.amountCents : 0,
        credit: a.side === "credit" ? a.amountCents : 0,
        dims: journalDimensions(a, c.supplierId),
        memo: `Original ${domain.credit!.originalCaseId}/${a.originalLineId}; ${a.treatment}`,
      }));
      lines.push({
        account: "2000",
        debit: credit.amountCents,
        credit: 0,
        dims: payableDimensions(c.supplierId!, credit.settlementDimensions),
        memo: "Linked supplier credit",
      });
      const posted = await appendDemoEntry(ctx, {
        runId: args.scope.runId,
        seat: accountingSeat(args.scope.runId),
        date: domain.accountingDate ?? c.invoiceDate,
        memo: `Linked approved credit ${c.invoiceNumber}`,
        source: { kind: "vendor_credit", ref: result.row._id },
        lines,
        idempotencyKey: `ap:credit:${result.row._id}`,
        decisionPath: proposal._id,
      });
      if (!posted.ok) deny(posted.code, posted.error);
      entryId = posted.entryId;
      creditId = await ctx.db.insert("demoCredits", {
        scope: args.scope,
        vendor: c.supplierId!,
        reference,
        amountCents: credit.amountCents,
        reservedCents: 0,
        consumedCents: 0,
        evidence: proposal._id,
        date: domain.accountingDate ?? c.invoiceDate,
        expenseAccount: credit.allocations[0]!.account,
        entryId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("apCreditLinks", {
        scope: args.scope,
        caseId: result.row._id,
        originalCaseId: credit.original._id,
        originalBillId: credit.bill._id,
        originalApprovalId: credit.approved._id,
        creditId,
        approvalId: proposal._id,
        plan: domain.credit,
        allocations: credit.allocations,
        amountCents: credit.amountCents,
        entryId,
        createdAt: Date.now(),
      });
      await saveConsumptions(
        ctx,
        args.scope,
        result.row._id,
        credit.bill._id,
        proposal._id,
        credit.returnConsumptions,
        result.input,
      );
      await ctx.db.patch(result.row._id, {
        creditId,
        acceptedCents: credit.amountCents,
        businessStatus: "approved",
        updatedAt: Date.now(),
      });
    }
    const decision: APDecision = {
      decisionId: `${proposal._id}:approved`,
      kind: "bill_approval",
      actor: subject,
      actorSeatId: seat.seatId,
      actorKind: "human",
      authority: "configured_sequential_business_groups",
      at: Date.now(),
      candidateRevision: result.row.currentRevision,
      sourceBindings: bindings(result.input),
      snapshotHash: result.row.snapshotHash,
      policyVersion: result.policy.version,
      outcome: "approved",
      reason: request.reason,
      evidenceIds: c.evidence.map((e) => e.evidenceId),
    };
    await ctx.db.insert("apCaseDecisions", {
      scope: args.scope,
      caseId: result.row._id,
      decision,
    });
    await ctx.db.patch(proposal._id, {
      votes: nextVotes,
      stage,
      status: "approved",
      completedAt: Date.now(),
      entryId,
    });
    await auditDemo(ctx, args.scope, subject, "business_recognition_approved", {
      proposalId: proposal._id,
      billId,
      creditId,
      entryId,
      amountCents: result.amountCents,
    });
    const response = {
      status: "approved",
      proposalId: proposal._id,
      billId: billId ?? null,
      creditId: creditId ?? null,
      entryId,
    };
    await receipt(
      ctx,
      args.scope,
      `business-vote:${request.idempotencyKey}`,
      op.payloadHash,
      response,
    );
    return response;
  },
});
export const applyCredits = mutation({
  args: {
    scope: scopeValidator,
    caseId: v.id("apCaseRecords"),
    expectedRevision: v.number(),
    snapshotHash: v.string(),
    billVersion: v.number(),
    idempotencyKey: v.string(),
    reason: v.string(),
    credits: v.array(
      v.object({ creditId: v.id("demoCredits"), amountCents: v.number() }),
    ),
  },
  handler: async (ctx, args) => {
    const { subject } = await requirePaymentHuman(ctx, args.scope);
    const op = await replay(
      ctx,
      args.scope,
      `credit-application:${args.idempotencyKey}`,
      { args, subject },
    );
    if (op.prior) return op.prior.result;
    const row = await caseRow(ctx, args.scope, args.caseId);
    if (
      row.currentRevision !== args.expectedRevision ||
      row.snapshotHash !== args.snapshotHash ||
      !row.billId ||
      !row.domainApprovalId
    )
      deny(
        "credit_application_binding",
        "Credit application requires an exact approved business bill",
      );
    const approval = await ctx.db.get(row.domainApprovalId);
    if (!approval) deny("approval_missing", "Bill approval is unavailable");
    await assertApprovalCurrent(ctx, args.scope, row, approval);
    const bill = await ctx.db.get(row.billId);
    if (
      !bill ||
      bill.version !== args.billVersion ||
      bill.reservedVersionId ||
      bill.flags.length ||
      !args.reason.trim()
    )
      deny("credit_application_stale", "Bill is reserved, changed or held");
    if (
      !args.credits.length ||
      new Set(args.credits.map((c) => c.creditId)).size !==
        args.credits.length ||
      args.credits.some(
        (c) => !Number.isSafeInteger(c.amountCents) || c.amountCents <= 0,
      )
    )
      deny(
        "invalid_credit_allocation",
        "Distinct positive exact credit allocations are required",
      );
    const amount = sumCents(args.credits.map((c) => c.amountCents));
    if (amount > bill.approvedCents! - bill.paidCents)
      deny(
        "credit_application_excess",
        "Credit application exceeds remaining approved bill",
      );
    // Preserve the existing capacity error before inspecting the new optional accounting binding.
    for (const item of args.credits) {
      const credit = await ctx.db.get(item.creditId); assertRowScope(credit, args.scope);
      if (credit!.vendor !== bill.vendor || credit!.amountCents - credit!.reservedCents - credit!.consumedCents < item.amountCents)
        deny("credit_unavailable", "Supplier credit is reserved, consumed or belongs to another supplier");
    }
    await assertGovernedCredits(ctx, args.scope, args.credits, bill.vendor);
    const accountingBinding = await derivePaymentAccountingBinding(ctx, args.scope, [{billId:bill._id,amountCents:amount}], args.credits);
    for (const item of args.credits) {
      const credit = await ctx.db.get(item.creditId);
      assertRowScope(credit, args.scope);
      if (
        credit!.vendor !== bill.vendor ||
        credit!.amountCents - credit!.reservedCents - credit!.consumedCents <
          item.amountCents
      )
        deny(
          "credit_unavailable",
          "Supplier credit is reserved, consumed or belongs to another supplier",
        );
      const link = await ctx.db
        .query("apCreditLinks")
        .withIndex("by_credit", (q) =>
          q.eq("scope.runId", args.scope.runId).eq("creditId", item.creditId),
        )
        .unique();
      if (!link)
        deny(
          "unlinked_credit",
          "B3 direct application requires a recognized linked credit note",
        );
      await ctx.db.patch(item.creditId, {
        consumedCents: credit!.consumedCents + item.amountCents,
      });
      await ctx.db.insert("apCreditApplications", {
        ...(accountingBinding ? {accountingBinding} : {}),
        scope: args.scope,
        caseId: row._id,
        billId: bill._id,
        creditId: item.creditId,
        amountCents: item.amountCents,
        requestKey: args.idempotencyKey,
        actor: subject,
        at: Date.now(),
      });
    }
    const paidCents = bill.paidCents + amount;
    await ctx.db.patch(bill._id, {
      paidCents,
      status: paidCents === bill.approvedCents ? "paid" : "approved",
      version: bill.version + 1,
    });
    await auditDemo(ctx, args.scope, subject, "credit_only_applied", {
      caseId: row._id,
      billId: bill._id,
      credits: args.credits,
      reason: args.reason,
      noBankCommand: true,
      noNewRecognition: true,
    });
    const response = { billId: bill._id, appliedCents: amount, cashCents: 0 };
    await receipt(
      ctx,
      args.scope,
      `credit-application:${args.idempotencyKey}`,
      op.payloadHash,
      response,
    );
    return response;
  },
});
export const proposals = query({
  args: {
    scope: scopeValidator,
    seatId: v.optional(v.string()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await readAuth(ctx, args);
    return ctx.db
      .query("apApprovalProposals")
      .withIndex("by_run", (q) => q.eq("scope.runId", args.scope.runId))
      .collect();
  },
});
