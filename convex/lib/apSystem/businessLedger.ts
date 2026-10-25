import type { QueryCtx, MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import type { BankScope } from "../../../src/integrations/contracts";
import {
  intakeSchema,
  decisionSchema,
  type APIntake,
} from "../../../src/ap-system/contracts";
import {
  domainRequestSchema,
  creditPlanSchema,
  type CreditPlan,
  type BusinessAcceptance,
} from "../../../src/ap-system/domain-contracts";
import { quantityMicros, sumCents, lineCents } from "../../../src/ap-system/accounting";
import {
  allocateCents,
  businessEvidenceProblems,
  businessSourceKey,
  proportionalCents,
  type Consumption,
} from "../../../src/ap-system/business-policy";
import { assertRowScope } from "../demoAuth";
import { deny, caseRow } from "./shared";

export async function assertConsumptions(
  ctx: QueryCtx,
  scope: BankScope,
  caseId: Id<"apCaseRecords">,
  claims: Consumption[],
) {
  const grouped = new Map<string, Consumption[]>();
  for (const c of claims) {
    const key = `${c.source.sourceId}:${c.lineId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), c]);
  }
  for (const items of grouped.values()) {
    const first = items[0]!;
    if (
      items.some(
        (c) =>
          c.source.revision !== first.source.revision ||
          c.source.sha256 !== first.source.sha256 ||
          c.capacity !== first.capacity ||
          c.sku !== first.sku ||
          c.unit !== first.unit,
      )
    )
      deny(
        "consumption_source_conflict",
        "One original line cannot have inconsistent capacity or units",
      );
    const prior = await ctx.db
      .query("apReceiptConsumptions")
      .withIndex("by_source_line", (q) =>
        q
          .eq("scope.runId", scope.runId)
          .eq("sourceId", first.source.sourceId)
          .eq("lineId", first.lineId),
      )
      .collect();
    if (
      prior.some(
        (p) =>
          p.sku !== first.sku || p.unit !== first.unit || p.kind !== first.kind,
      )
    )
      deny(
        "consumption_source_conflict",
        "An original line cannot change economic SKU/unit identity across revisions",
      );
    const used = prior
      .filter((p) => p.caseId !== caseId)
      .reduce((n, p) => n + quantityMicros(p.quantity), 0n);
    const wanted = items.reduce((n, p) => n + quantityMicros(p.quantity), 0n);
    if (used + wanted > quantityMicros(first.capacity))
      deny(
        "received_units_already_used",
        "Accepted quantities exceed remaining PO/contract/receipt/service units",
      );
  }
  // B1 reserved a whole received line. Preserve that constraint until explicit B3 recertification.
  const legacy = (
    await ctx.db
      .query("apCaseRecords")
      .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
      .collect()
  ).filter((c) => c._id !== caseId && c.billId && !c.domainApprovalId);
  for (const old of legacy) {
    const decisions = await ctx.db
      .query("apCaseDecisions")
      .withIndex("by_case", (q) =>
        q.eq("scope.runId", scope.runId).eq("caseId", old._id),
      )
      .collect();
    const approved = decisions
      .map((d) => decisionSchema.parse(d.decision))
      .find((d) => d.kind === "bill_approval" && d.outcome === "approved");
    if (!approved)
      deny(
        "legacy_allocation_missing",
        "Legacy recognized bill lacks its original approval",
      );
    const revision = await ctx.db
      .query("apCaseRevisions")
      .withIndex("by_case", (q) =>
        q
          .eq("scope.runId", scope.runId)
          .eq("caseId", old._id)
          .eq("revision", approved.candidateRevision),
      )
      .unique();
    if (!revision)
      deny(
        "legacy_allocation_missing",
        "Legacy recognized bill lacks its original source revision",
      );
    const oldInput = intakeSchema.parse(revision.intake);
    if (
      oldInput.purchasingEvidence.some((p) =>
        p.lines.some((l) => grouped.has(`${p.source.sourceId}:${l.lineId}`)),
      )
    )
      deny(
        "received_units_already_used",
        "Legacy recognition already reserves these purchasing/receiving lines",
      );
  }
}
export async function saveConsumptions(
  ctx: MutationCtx,
  scope: BankScope,
  caseId: Id<"apCaseRecords">,
  billId: Id<"demoBills">,
  approvalId: Id<"apApprovalProposals">,
  claims: Consumption[],
) {
  const existing = await ctx.db
    .query("apReceiptConsumptions")
    .withIndex("by_bill", (q) =>
      q.eq("scope.runId", scope.runId).eq("billId", billId),
    )
    .collect();
  if (existing.some((r) => r.caseId === caseId)) return;
  for (const c of claims)
    await ctx.db.insert("apReceiptConsumptions", {
      scope,
      caseId,
      billId,
      approvalId,
      sourceId: c.source.sourceId,
      sourceRevision: c.source.revision,
      sourceHash: c.source.sha256,
      lineId: c.lineId,
      quantity: c.quantity,
      capacity: c.capacity,
      invoiceLineId: c.invoiceLineId,
      sku: c.sku,
      unit: c.unit,
      kind: c.kind,
    });
}
export function economicAcceptance(a: BusinessAcceptance) {
  return {
    ...a,
    reason: "",
    resolutions: [],
    lines: a.lines.map((l) => ({
      ...l,
      agreement: l.agreement
        ? { ...l.agreement, source: { sourceId: l.agreement.source.sourceId } }
        : null,
      receipts: l.receipts.map((r) => ({
        ...r,
        source: { sourceId: r.source.sourceId },
      })),
    })),
  };
}
export type CreditAllocation = {
  account: string;
  amountCents: number;
  store: string | null;
  period: string;
  treatment: string;
  side: "credit" | "debit";
  originalLineId: string;
  allocationIndex: number;
};
export async function evaluateCredit(
  ctx: QueryCtx,
  scope: BankScope,
  input: APIntake,
  plan: CreditPlan,
  creditCaseId: Id<"apCaseRecords">,
) {
  const c = input.candidate;
  if (!c || c.kind !== "credit_note" || c.currency !== "USD")
    deny("credit_source_required", "A reviewed USD credit note is required");
  const evidence = businessEvidenceProblems(input, true);
  if (evidence.length)
    deny("credit_evidence_hold", evidence.map((e) => e.code).join(","));
  const original = await caseRow(ctx, scope, plan.originalCaseId);
  if (!original.billId)
    deny(
      "original_bill_required",
      "Credit must link to a recognized original bill",
    );
  const bill = await ctx.db.get(original.billId);
  assertRowScope(bill, scope);
  if (bill!.reservedVersionId)
    deny(
      "credit_reserved_bill",
      "Cancel unsent payment or resolve attempted bank outcome before recognizing a credit against this bill",
    );
  if (bill!.vendor !== c.supplierId)
    deny(
      "credit_supplier_mismatch",
      "Credit supplier differs from original obligation",
    );
  const approvalId = ctx.db.normalizeId(
    "apApprovalProposals",
    plan.originalApprovalId,
  );
  const approved = approvalId ? await ctx.db.get(approvalId) : null;
  if (
    !approved ||
    approved.caseId !== original._id ||
    approved.status !== "approved" ||
    !approved.entryId ||
    approved.entryId !== bill!.entryId
  )
    deny(
      "original_allocation_required",
      "Credit must identify an approved immutable original allocation",
    );
  const originalRequest = domainRequestSchema.parse(approved.request);
  const acceptance = originalRequest.acceptance;
  if (!acceptance)
    deny(
      "original_allocation_required",
      "Original allocation is not an invoice recognition",
    );
  const links = await ctx.db
    .query("apCreditLinks")
    .withIndex("by_original", (q) =>
      q.eq("scope.runId", scope.runId).eq("originalBillId", bill!._id),
    )
    .collect();
  const previous = links.map((l) => creditPlanSchema.parse(l.plan));
  const allocations: CreditAllocation[] = [];
  const returnConsumptions: Consumption[] = [];
  if (
    new Set(plan.lines.map((l) => l.creditLineId)).size !== plan.lines.length ||
    new Set(plan.lines.map((l) => l.originalLineId)).size !==
      plan.lines.length ||
    plan.lines.length !== c.lines.length
  )
    deny(
      "credit_line_mapping",
      "Every credit line must uniquely map to an original accepted line",
    );
  const originalRevision = await ctx.db
      .query("apCaseRevisions")
      .withIndex("by_case", (q) =>
        q
          .eq("scope.runId", scope.runId)
          .eq("caseId", original._id)
          .eq("revision", originalRequest.expectedRevision),
      )
      .unique();
  if (!originalRevision) deny("original_revision_missing", "Original approved source revision is unavailable");
  const originalInput = intakeSchema.parse(originalRevision.intake);
  const allocateRemaining = (id: string, originals: BusinessAcceptance["freightAllocations"], amount: number) => {
    const used = links.flatMap((l) => l.allocations as CreditAllocation[]).filter((a) => a.originalLineId === id);
    return allocateCents(amount, originals.map((a, i) => a.amountCents - sumCents(used.filter((u) => u.allocationIndex === i).map((u) => u.amountCents))));
  };
  for (const item of plan.lines) {
    const creditLine = c.lines.find((l) => l.lineId === item.creditLineId);
    const accepted = acceptance.lines.find(
      (l) => l.lineId === item.originalLineId,
    );
    const originalLine = originalInput.candidate?.lines.find(
      (l) => l.lineId === item.originalLineId,
    );
    if (
      !creditLine ||
      !accepted ||
      !originalLine ||
      creditLine.sku !== originalLine.sku ||
      creditLine.quantity.unit !== originalLine.quantity.unit ||
      creditLine.amountCents !== item.netCents ||
      creditLine.taxCents !== item.taxCents ||
      lineCents(creditLine.quantity.decimal, creditLine.unitPriceCents) !== creditLine.amountCents
    )
      deny(
        "credit_line_mismatch",
        "Credit values/SKU/unit must agree with its source and original accepted line",
      );
    const prior = previous
      .flatMap((p) => p.lines)
      .filter((l) => l.originalLineId === item.originalLineId);
    const netUsed = sumCents(prior.map((l) => l.netCents)),
      taxUsed = sumCents(prior.map((l) => l.taxCents));
    if (
      netUsed + item.netCents > accepted.netCents ||
      taxUsed + item.taxCents > accepted.taxCents
    )
      deny(
        "credit_exceeds_original",
        "Cumulative credit exceeds original accepted net or tax",
      );
    const returned = prior
      .filter((l) => l.basis === "quantity_return")
      .reduce((n, l) => n + quantityMicros(l.quantity), 0n);
    if (item.basis === "quantity_return") {
      if (
        quantityMicros(item.quantity) <= 0n ||
        quantityMicros(item.quantity) !==
          quantityMicros(creditLine.quantity.decimal) ||
        returned + quantityMicros(item.quantity) >
          quantityMicros(accepted.quantity) ||
        !item.returnEvidence.length ||
        lineCents(item.quantity, originalLine.unitPriceCents) !== item.netCents
      )
        deny(
          "return_quantity",
          "Returned quantities need retained return evidence and cannot exceed accepted units",
        );
      let supportedReturnUnits = 0n;
      if (new Set(item.returnEvidence.map(businessSourceKey)).size !== item.returnEvidence.length) deny("return_evidence", "Return originals cannot be counted twice");
      for (const b of item.returnEvidence) {
        const doc = input.documents.find(
          (d) => businessSourceKey(d) === businessSourceKey(b),
        );
        if (!doc || !["receipt", "correction"].includes(doc.kind))
          deny(
            "return_evidence",
            "Return evidence must bind an uploaded receipt/correction original",
          );
        const support = input.purchasingEvidence.filter((p) => businessSourceKey(p.source) === businessSourceKey(b) && p.supplierId === c.supplierId && p.kind === "receipt" && p.acceptedBy && p.acceptedAt && Number.isFinite(Date.parse(p.acceptedAt))).flatMap((p) => p.lines).filter((l) => l.invoiceLineId === item.creditLineId && l.sku === originalLine.sku && l.quantity.unit === originalLine.quantity.unit);
        if (support.length !== 1) deny("return_line_evidence", "Every return original must explicitly support one matching credit SKU/unit line with receiver/date attestation");
        supportedReturnUnits += quantityMicros(support[0]!.quantity.decimal);
        returnConsumptions.push({source:b,lineId:support[0]!.lineId,quantity:item.returnEvidence.length === 1 ? item.quantity : support[0]!.quantity.decimal,capacity:support[0]!.quantity.decimal,invoiceLineId:item.creditLineId,sku:support[0]!.sku,unit:support[0]!.quantity.unit,kind:"return"});
      }
      if (supportedReturnUnits < quantityMicros(item.quantity) || (item.returnEvidence.length > 1 && supportedReturnUnits !== quantityMicros(item.quantity))) deny("return_line_evidence", "Documented return lines do not support the credited return quantity");
    } else if (quantityMicros(item.quantity) !== 0n)
      deny(
        "credit_quantity",
        "Price/tax adjustments do not silently consume returned units",
      );
    if (item.basis === "tax_adjustment") {
      if (item.netCents !== 0 || !item.taxCents)
        deny(
          "tax_credit",
          "Tax adjustments must contain only remaining original tax",
        );
    } else {
      const expected = accepted.netCents
        ? Math.max(0, proportionalCents(
            accepted.taxCents,
            BigInt(netUsed + item.netCents),
            BigInt(accepted.netCents),
          ) - taxUsed)
        : 0;
      if (item.taxCents !== expected)
        deny(
          "credit_tax_treatment",
          "Credit must reverse the cumulative original nonrecoverable tax proportion exactly, or use an explicit tax-adjustment approval",
        );
    }
    const portion = allocateRemaining(item.originalLineId, accepted.allocations, item.netCents + item.taxCents);
    accepted.allocations.forEach((a, i) => {
      const amountCents = portion[i]!;
      if (amountCents < 0)
        deny(
          "credit_allocation_rounding",
          "Cumulative allocation would reverse an earlier split; use a controller correction",
        );
      if (amountCents)
        allocations.push({
          account: a.account,
          amountCents,
          store: a.store,
          period: a.period,
          treatment: a.treatment,
          side: "credit",
          originalLineId: item.originalLineId,
          allocationIndex: i,
        });
    });
  }
  for (const category of ["freight", "discount"] as const) {
    const field = category === "freight" ? "freightCents" : "discountCents";
    const amount = plan[field],
      used = sumCents(previous.map((p) => p[field]));
    if (c[field] !== amount || used + amount > acceptance[field])
      deny(
        "credit_header_amount",
        "Credit freight/discount must match its original allocated balance",
      );
    const originals =
      category === "freight"
        ? acceptance.freightAllocations
        : acceptance.discountAllocations;
    const portion = allocateRemaining(category, originals, amount);
    originals.forEach((a, i) => {
      const amountCents = portion[i]!;
      if (amountCents < 0)
        deny(
          "credit_allocation_rounding",
          "Header allocation needs an explicit controller correction",
        );
      if (amountCents)
        allocations.push({
          account: a.account,
          amountCents,
          store: a.store,
          period: a.period,
          treatment: a.treatment,
          side: category === "discount" ? "debit" : "credit",
          originalLineId: category,
          allocationIndex: i,
        });
    });
  }
  const amountCents =
    sumCents(
      plan.lines
        .flatMap((l) => [l.netCents, l.taxCents])
        .concat(plan.freightCents),
    ) - plan.discountCents;
  if (
    amountCents <= 0 ||
    amountCents !== c.totalCents ||
    sumCents(c.lines.map((l) => l.amountCents)) !== c.subtotalCents ||
    sumCents(c.lines.map((l) => l.taxCents)) !== c.taxCents
  )
    deny(
      "credit_total",
      "Credit source and original-supported allocations must reconcile exactly",
    );
  await assertConsumptions(ctx, scope, creditCaseId, returnConsumptions);
  return { original, bill: bill!, approved, allocations, amountCents, returnConsumptions };
}
