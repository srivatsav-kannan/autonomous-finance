import { acceptedHeaderTax, taxHeaderProblems } from "./tax-header";
import { taxClaimProblems } from "./tax-policy";
import { acceptanceAllocations, settlementDimensions, payableDimensions, type SettlementDimensions } from "./settlement-dimensions";
import { dimensionPolicyProblem, journalDimensions } from "./gl-dimensions";
import type {
  APException,
  APIntake,
  Candidate,
  SourceBinding,
} from "./contracts";
import type {
  AcceptedLine,
  BusinessAcceptance,
  BusinessPolicy,
  SupplierProposal,
} from "./domain-contracts";
import { lineCents, quantityMicros, sumCents } from "./accounting";
import { CHART } from "../core/accounts";

export const businessSourceKey = (s: SourceBinding) =>
  `${s.sourceId}:${s.revision}:${s.sha256}`;
export const quantityString = (micros: bigint) =>
  `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0")}`.replace(
    /\.?0+$/,
    "",
  ) || "0";
export function proportionalCents(
  amount: number,
  numerator: bigint,
  denominator: bigint,
): number {
  if (denominator <= 0n || numerator < 0n || numerator > denominator)
    throw Error("Invalid exact proportion");
  const result = (BigInt(amount) * numerator + denominator / 2n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error("Unsafe proportional cents");
  return Number(result);
}
/** Largest remainders with stable source order; sum is exact, no independent per-line rounding drift. */
export function allocateCents(amount: number, weights: number[]): number[] {
  const total = sumCents(weights);
  if (amount < 0 || amount > total || !Number.isSafeInteger(amount))
    throw Error("Allocation exceeds original amount");
  if (!total) return weights.map(() => 0);
  const parts = weights.map((w, index) => ({
    index,
    cents: (BigInt(amount) * BigInt(w)) / BigInt(total),
    remainder: (BigInt(amount) * BigInt(w)) % BigInt(total),
  }));
  let left = BigInt(amount) - parts.reduce((n, p) => n + p.cents, 0n);
  for (const p of [...parts].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  )) {
    if (!left) break;
    p.cents++;
    left--;
  }
  return parts.map((p) => Number(p.cents));
}
export type Consumption = {
  identity?: import("./physical-line-contracts").PhysicalAllocation;
  source: SourceBinding;
  lineId: string;
  quantity: string;
  capacity: string;
  invoiceLineId: string;
  sku: string;
  unit: string;
  kind: string;
};
export type BusinessEvaluation = {
  exceptions: APException[];
  amountCents: number;
  consumptions: Consumption[];
  varianceRequired: boolean;
  taxApprovalGroups: string[];
};
const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export function businessException(
  code: string,
  reason: string,
  ownerRole: APException["ownerRole"],
  reference = "",
): APException {
  return {
    exceptionId: `${code}:${reference}`,
    code,
    reason,
    ownerRole,
    permittedActions: [
      "submit_supported_revision",
      "propose_authorized_acceptance",
    ],
    requiredEvidence: [reference || code],
    blocking: true,
    status: "open",
    resolution: null,
  };
}
export function businessEvidenceProblems(
  input: APIntake,
  reviewed: boolean,
): APException[] {
  const out: APException[] = [];
  const c = input.candidate;
  const hold = (code: string, reason: string, reference = "") =>
    out.push(businessException(code, reason, "ap_clerk", reference));
  if (!c || input.extraction.status !== "complete") {
    hold(
      "incomplete_extraction",
      "A complete supported candidate is required.",
    );
    return out;
  }
  if (new Set(input.documents.map((d) => d.sourceId)).size !== input.documents.length)
    hold("duplicate_current_source", "Only one current revision of each original source can support a packet.");
  const primary = input.documents.filter(
    (d) => d.kind === "invoice" || d.kind === "credit_note",
  );
  if (primary.length !== 1) {
    hold("primary_source", "Exactly one primary original is required.");
    return out;
  }
  const fields: [string, string | number][] = [
    ["extractedSupplierName", c.extractedSupplierName],
    ["invoiceNumber", c.invoiceNumber],
    ["invoiceDate", c.invoiceDate],
    ["totalCents", c.totalCents],
  ];
  for (const l of c.lines) {
    fields.push(
      [`lines.${l.lineId}.sku`, l.sku ?? ""],
      [`lines.${l.lineId}.description`, l.description],
      [`lines.${l.lineId}.quantity`, l.quantity.decimal],
      [`lines.${l.lineId}.unitPriceCents`, l.unitPriceCents],
      [`lines.${l.lineId}.amountCents`, l.amountCents],
    );
    if (l.taxCents) fields.push([`lines.${l.lineId}.taxCents`, l.taxCents]);
  }
  for (const [key, value] of fields) {
    const found = c.evidence.filter((e) => e.fieldPath === key);
    if (
      found.length !== 1 ||
      found[0]!.contentStatus !== "supported" ||
      String(found[0]!.normalizedValue) !== String(value) ||
      !found[0]!.quote.trim() ||
      businessSourceKey(found[0]!.source) !== businessSourceKey(primary[0]!)
    )
      hold(
        "unsupported_field",
        `Current primary original must uniquely support ${key}.`,
        key,
      );
  }
  for (const e of c.evidence) {
    if (e.contentStatus !== "supported")
      hold(
        "content_conflict",
        "Unresolved extracted content cannot be approved.",
        e.evidenceId,
      );
    if (!reviewed && e.grounding.status === "unresolved")
      hold(
        "geometry_review_required",
        "Explicitly review supported text against the current original.",
        e.evidenceId,
      );
    if (
      e.grounding.status === "derived" &&
      (!e.grounding.processor.rawArtifact ||
        !e.grounding.processor.tokenArtifact ||
        !e.grounding.processor.configArtifact ||
        (e.grounding.method === "local_ocr_exact" &&
          (!e.grounding.processor.rasterArtifact ||
            !e.grounding.processor.traineddata)))
    )
      hold(
        "grounding_provenance_missing",
        "Derived geometry must retain hashed processing evidence.",
        e.evidenceId,
      );
  }
  if (
    input.documents.some((d) =>
      d.pageStatus.some((p) => p.status !== "complete"),
    )
  )
    hold("incomplete_pages", "Every source page must be accounted for.");
  return out;
}
function invoiceArithmetic(c: Candidate): boolean {
  try {
    return (
      c.lines.every(
        (l) =>
          quantityMicros(l.quantity.decimal) > 0n &&
          lineCents(l.quantity.decimal, l.unitPriceCents) === l.amountCents,
      ) &&
      sumCents(c.lines.map((l) => l.amountCents)) === c.subtotalCents &&
      sumCents(c.lines.map((l) => l.taxCents)) === c.taxCents &&
      sumCents([c.subtotalCents, c.taxCents, c.freightCents]) -
        c.discountCents ===
        c.totalCents &&
      c.totalCents > 0
    );
  } catch {
    return false;
  }
}
export function evaluateBusinessAcceptance(
  input: APIntake,
  acceptance: BusinessAcceptance,
  policy: BusinessPolicy,
  supplier: SupplierProposal,
  reviewed: boolean,
  accountingDate?: string,
): BusinessEvaluation {
  const exceptions = businessEvidenceProblems(input, reviewed),
    consumptions: Consumption[] = [];
  const taxApprovalGroups: string[] = [];
  let varianceRequired = false,
    amountCents = 0;
  const hold = (
    code: string,
    reason: string,
    owner: APException["ownerRole"] = "controller",
    ref = "",
  ) => exceptions.push(businessException(code, reason, owner, ref));
  const c = input.candidate;
  if (!c) return { exceptions, consumptions, varianceRequired, amountCents, taxApprovalGroups };
  if (c.kind !== "invoice")
    hold(
      "credit_route_required",
      "Credit notes require a linked original-allocation approval.",
    );
  if (c.currency !== "USD" || supplier.currency !== "USD")
    hold(
      "unsupported_currency",
      "Only USD books/payments are enabled; retain original currency for an owned FX workflow.",
    );
  if (
    c.supplierId !== supplier.supplierId ||
    ![supplier.legalName, ...supplier.aliases].some(
      (n) => normalized(n) === normalized(c.extractedSupplierName),
    )
  )
    hold(
      "unverified_supplier",
      "The extracted supplier does not match this approved supplier master.",
      "vendor_verification_owner",
    );
  if (!invoiceArithmetic(c))
    hold(
      "invoice_arithmetic",
      "Original invoice arithmetic must be exact before accepting a portion.",
    );
  if (
    new Set(c.lines.map((l) => l.lineId)).size !== c.lines.length ||
    new Set(acceptance.lines.map((l) => l.lineId)).size !==
      acceptance.lines.length ||
    acceptance.lines.length !== c.lines.length ||
    acceptance.lines.some((l) => !c.lines.some((x) => x.lineId === l.lineId))
  )
    hold(
      "acceptance_coverage",
      "Explicitly account for every invoice line once, including a zero accepted portion.",
    );
  for (const problem of taxHeaderProblems(input, acceptance, policy)) hold(problem, "Taxable header attribution needs explicit supported original and accepted line shares.");
  const docs = new Map(input.documents.map((d) => [businessSourceKey(d), d]));
  const checkAllocation = (a: AcceptedLine["allocations"][number]) => {
    const configured = policy.accounts.find(
      (x) => x.account === a.account && x.treatment === a.treatment,
    );
    const chart = CHART.find((x) => x.code === a.account);
    if (
      !configured ||
      !chart ||
      chart.cash ||
      a.account === "2000" ||
      (a.treatment === "expense" && chart.type !== "expense") ||
      (["inventory", "fixed_asset", "prepayment", "tax"].includes(a.treatment) &&
        chart.type !== "asset")
    )
      hold(
        "unsupported_account",
        "Coding must be an approved non-cash expense/asset account with the declared treatment.",
        "controller",
        a.account,
      );
    const dimensionProblem = dimensionPolicyProblem(a, policy);
    if (dimensionProblem)
      hold(dimensionProblem, "Department/project cost allocations require an explicit current policy and approved dimension IDs.");
    if (a.store !== null && !policy.stores.includes(a.store))
      hold(
        "unknown_store",
        "Store is not in the approved coding policy.",
        "controller",
        a.store,
      );
    if (a.period !== (accountingDate ?? c.invoiceDate).slice(0, 7))
      hold(
        "unsupported_period",
        "Recognition allocations must use the explicitly approved accounting period.",
      );
  };
  const findPurchasing = (
    source: SourceBinding,
    lineId: string,
    kind: string,
    invoiceLineId: string,
  ) => {
    const p = input.purchasingEvidence.filter(
      (p) =>
        businessSourceKey(p.source) === businessSourceKey(source) &&
        p.kind === kind &&
        p.supplierId === c.supplierId,
    );
    const document = docs.get(businessSourceKey(source));
    const expectedKind = kind === "service_acceptance" ? "receipt" : kind;
    const lines = p.flatMap((p) =>
      p.lines
        .filter((l) => l.lineId === lineId && l.invoiceLineId === invoiceLineId)
        .map((l) => ({ p, l })),
    );
    return document?.kind === expectedKind && lines.length === 1
      ? lines[0]
      : undefined;
  };
  for (const line of acceptance.lines) {
    const original = c.lines.find((l) => l.lineId === line.lineId);
    if (!original) continue;
    const accepted = quantityMicros(line.quantity),
      invoiced = quantityMicros(original.quantity.decimal);
    let headerTax: ReturnType<typeof acceptedHeaderTax> = null;
    try { headerTax = acceptedHeaderTax(line, original); } catch { hold("tax_header_base", "Header-adjusted taxable base must remain within its original capacity."); }
    if (
      invoiced <= 0n || accepted > invoiced ||
      lineCents(line.quantity, original.unitPriceCents) !== line.netCents ||
      line.taxCents !== (headerTax?.taxCents ?? proportionalCents(original.taxCents, accepted, invoiced))
    )
      hold(
        "unsupported_partial_amount",
        "Accepted cents/tax must match the explicitly accepted quantity at original unit price; no unexplained short-pay.",
        "controller",
        line.lineId,
      );
    if (
      sumCents(line.allocations.map((a) => a.amountCents)) !==
      sumCents([line.netCents, line.taxCents])
    )
      hold(
        "allocation_sum",
        "Accepted line allocations must equal its exact net plus tax.",
        "controller",
        line.lineId,
      );
    line.allocations.forEach(checkAllocation);
    const tax = policy.taxCodes.find((t) => t.code === line.taxCode);
    if (tax?.mode === "recoverable" && tax.recovery && line.tax) {
      const source = c.evidence.find(e => e.fieldPath === `lines.${line.lineId}.taxCents` && e.contentStatus === "supported")?.source;
      if (!source) hold("tax_invoice_evidence", "Recoverable tax requires the original line tax evidence.", "controller", line.lineId);
      else for (const problem of taxClaimProblems(line.tax, tax.recovery, input.documents, { ...original, source, ...(headerTax ? { taxableBaseCents: headerTax.originalBase } : {}) }, line.taxCents))
        hold(problem, "Recoverable tax needs exact original facts and explicit current policy evidence.", "controller", line.lineId);
      if (line.tax.taxPointDate > (accountingDate ?? c.invoiceDate))
        hold("tax_point_date", "Tax point cannot be after the approved recognition date.", "controller", line.lineId);
      const recovered = sumCents(line.allocations.filter(a => a.treatment === "tax").map(a => a.amountCents));
      if (recovered !== line.tax.recoverableCents || line.allocations.some(a => a.treatment === "tax" && a.account !== tax.recovery!.receivableAccount))
        hold("tax_allocation", "Tax allocations must use the configured receivable and exact approved recoverable cents.", "controller", line.lineId);
      if (!taxApprovalGroups.includes(tax.recovery.approvalGroupId)) taxApprovalGroups.push(tax.recovery.approvalGroupId);
    } else if (!tax || tax.mode === "recoverable" || (tax.mode === "none" && line.taxCents !== 0) || line.tax || line.allocations.some(a => a.treatment === "tax")) {
      hold("unsupported_tax", "Recoverable tax requires an explicit configured policy, source claim and independent tax approval; other tax stays in declared cost.", "controller", line.lineId);
    }
    if (!accepted) {
      if (line.netCents || line.taxCents || line.receipts.length)
        hold(
          "zero_acceptance",
          "A disputed zero portion must not consume amounts or receipt units.",
        );
      continue;
    }
    const sku = supplier.catalog.find((s) => s.sku === original.sku);
    if (!sku || sku.unit !== original.quantity.unit)
      hold(
        "unknown_sku_or_unit",
        "Supplier catalog must explicitly authorize the invoice SKU and unit.",
        "purchasing_owner",
        line.lineId,
      );
    const resolve = (expectedPrice: number) => {
      const difference =
        BigInt(Math.abs(original.unitPriceCents - expectedPrice)) * 10_000n;
      const within =
        difference <=
        BigInt(expectedPrice) * BigInt(policy.maxPriceVarianceBps);
      if (!within) {
        const resolution = acceptance.resolutions.find(
          (r) =>
            r.lineId === line.lineId &&
            r.code === "price_variance" &&
            r.evidence.every((b) => docs.has(businessSourceKey(b))),
        );
        if (!resolution)
          hold(
            "price_variance",
            "Price variance needs retained written support and the configured variance approval group.",
            "purchasing_owner",
            line.lineId,
          );
        else varianceRequired = true;
      }
    };
    if (sku) resolve(sku.unitPriceCents);
    const agreement = line.agreement
      ? findPurchasing(
          line.agreement.source,
          line.agreement.lineId,
          line.procurement === "po" ? "purchase_order" : "contract",
          line.lineId,
        )
      : undefined;
    if (!agreement)
      hold(
        line.procurement === "po" ? "missing_po" : "missing_contract",
        "Each accepted line needs one source-bound PO or contract line.",
        "purchasing_owner",
        line.lineId,
      );
    else {
      const a = agreement.l;
      if (
        a.sku !== original.sku ||
        a.quantity.unit !== original.quantity.unit ||
        quantityMicros(a.quantity.decimal) < accepted ||
        a.unitPriceCents === null
      )
        hold(
          "agreement_mismatch",
          "Agreement SKU/unit/quantity/price does not support accepted units.",
          "purchasing_owner",
          line.lineId,
        );
      else resolve(a.unitPriceCents);
      consumptions.push({
        source: agreement.p.source,
        lineId: a.lineId,
        quantity: line.quantity,
        capacity: a.quantity.decimal,
        invoiceLineId: line.lineId,
        sku: a.sku,
        unit: a.quantity.unit,
        kind: agreement.p.kind,
        ...(line.agreement?.identity ? {identity:line.agreement.identity}:{}),
      });
    }
    let received = 0n;
    const seen = new Set<string>();
    for (const claim of line.receipts) {
      const key = `${businessSourceKey(claim.source)}:${claim.lineId}`;
      if (seen.has(key))
        hold(
          "duplicate_receipt_claim",
          "A receipt claim cannot be counted twice.",
          "receiving_owner",
          line.lineId,
        );
      seen.add(key);
      const r = findPurchasing(
        claim.source,
        claim.lineId,
        line.procurement === "po" ? "receipt" : "service_acceptance",
        line.lineId,
      );
      const count = quantityMicros(claim.quantity);
      if (
        !r ||
        !r.p.acceptedBy?.trim() ||
        !r.p.acceptedAt ||
        !Number.isFinite(Date.parse(r.p.acceptedAt)) ||
        r.l.sku !== original.sku ||
        r.l.quantity.unit !== original.quantity.unit ||
        count <= 0n ||
        count > quantityMicros(r.l.quantity.decimal)
      )
        hold(
          "receipt_mismatch",
          "Accepted receipt/service evidence must cover the exact SKU, units and claimed quantity.",
          "receiving_owner",
          line.lineId,
        );
      else {
        received += count;
        consumptions.push({
          source: r.p.source,
          lineId: r.l.lineId,
          quantity: claim.quantity,
          capacity: r.l.quantity.decimal,
          invoiceLineId: line.lineId,
          sku: r.l.sku,
          unit: r.l.quantity.unit,
          kind: r.p.kind,
          ...(claim.identity ? {identity:claim.identity}:{}),
        });
      }
    }
    if (received !== accepted)
      hold(
        "missing_receipt",
        "Receipt/service allocations must equal the accepted quantity exactly.",
        "receiving_owner",
        line.lineId,
      );
  }
  if (
    acceptance.freightCents > c.freightCents ||
    acceptance.discountCents > c.discountCents ||
    sumCents(acceptance.freightAllocations.map((a) => a.amountCents)) !==
      acceptance.freightCents ||
    sumCents(acceptance.discountAllocations.map((a) => a.amountCents)) !==
      acceptance.discountCents
  )
    hold(
      "header_allocation",
      "Freight/discount acceptance must be explicit, allocated and within original amounts.",
    );
  if ([...acceptance.freightAllocations, ...acceptance.discountAllocations].some(a => a.treatment === "tax"))
    hold("tax_header_basis", "Header tax recovery requires explicit supported line distribution.");
  [...acceptance.freightAllocations, ...acceptance.discountAllocations].forEach(
    checkAllocation,
  );
  try {
    amountCents =
      sumCents(
        acceptance.lines
          .flatMap((l) => [l.netCents, l.taxCents])
          .concat(acceptance.freightCents),
      ) - acceptance.discountCents;
    if (
      !Number.isSafeInteger(amountCents) ||
      amountCents <= 0 ||
      amountCents > c.totalCents
    )
      hold(
        "accepted_amount",
        "Accepted total must be positive and cannot exceed original invoice.",
      );
  } catch {
    hold("unsafe_arithmetic", "Accepted amounts overflow exact integer cents.");
  }
  try { settlementDimensions(acceptanceAllocations(acceptance), policy); }
  catch { hold("settlement_department_mixed_or_unknown", "Explicit settlement policy requires one approved department across all allocations."); }
  return { exceptions, amountCents, consumptions, varianceRequired, taxApprovalGroups };
}
export function acceptanceJournal(
  acceptance: BusinessAcceptance,
  supplierId: string,
  reverse = false,
  settlement?: SettlementDimensions,
) {
  const lines = [
    ...acceptance.lines.flatMap((l) => l.allocations),
    ...acceptance.freightAllocations,
  ]
    .filter((a) => a.amountCents)
    .map((a) => ({
      account: a.account,
      debit: reverse ? 0 : a.amountCents,
      credit: reverse ? a.amountCents : 0,
      dims: journalDimensions(a, supplierId),
      memo: `${a.treatment}; ${a.period}`,
    }));
  lines.push(
    ...acceptance.discountAllocations
      .filter((a) => a.amountCents)
      .map((a) => ({
        account: a.account,
        debit: reverse ? a.amountCents : 0,
        credit: reverse ? 0 : a.amountCents,
        dims: journalDimensions(a, supplierId),
        memo: `discount; ${a.period}`,
      })),
  );
  const amount =
    sumCents(
      acceptance.lines
        .flatMap((l) => [l.netCents, l.taxCents])
        .concat(acceptance.freightCents),
    ) - acceptance.discountCents;
  lines.push({
    account: "2000",
    debit: reverse ? amount : 0,
    credit: reverse ? 0 : amount,
    dims: payableDimensions(supplierId, settlement),
    memo: "Accounts payable",
  });
  return lines;
}
