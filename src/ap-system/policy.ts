import { VENDORS, STORES } from "../../company/sweetgreen/profile";
import {
  AP_POLICY_VERSION,
  type APIntake,
  type APException,
  type Candidate,
  type SourceBinding,
} from "./contracts";
import { accountingProblems, quantityMicros } from "./accounting";

export { AP_POLICY_VERSION };
export const sourceKey = (s: SourceBinding) =>
  `${s.sourceId}:${s.revision}:${s.sha256}`;
const supplier = VENDORS.find((v) => v.id === "golden-state-produce")!;
const normalizedName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function exception(
  code: string,
  reason: string,
  owner: APException["ownerRole"],
  requiredEvidence: string[],
  suffix = "",
  blocking = true,
): APException {
  return {
    exceptionId: `${code}${suffix ? `:${suffix}` : ""}`,
    code,
    reason,
    ownerRole: owner,
    permittedActions: [
      "submit_supporting_evidence_revision",
      "request_authorized_correction",
    ],
    requiredEvidence,
    blocking,
    status: "open",
    resolution: null,
  };
}
/** Explicit synthetic company policy, not a model decision or practitioner sign-off. */
export function evaluatePolicy(
  input: APIntake,
  trustedSupplierId: string,
  fieldsReviewed = false,
): APException[] {
  const result: APException[] = [];
  const c = input.candidate;
  if (!c || input.extraction.status !== "complete")
    return [
      exception(
        "incomplete_extraction",
        "Required invoice facts are unresolved; inspect the original and submit a supported revision.",
        "ap_clerk",
        ["complete_invoice_fields"],
      ),
    ];
  if (c.kind !== "invoice")
    result.push(
      exception(
        "credit_workflow_required",
        "Credit notes require the separately linked credit workflow.",
        "controller",
        ["original_bill", "authorized_credit_application"],
      ),
    );
  if (
    c.supplierId !== trustedSupplierId ||
    c.supplierId !== supplier.id ||
    normalizedName(c.extractedSupplierName) !==
      normalizedName(supplier.legalName)
  )
    result.push(
      exception(
        "unverified_supplier",
        "Extracted supplier does not match the configured trusted supplier master.",
        "vendor_verification_owner",
        ["independent_supplier_verification"],
      ),
    );
  for (const problem of accountingProblems(c))
    result.push(
      exception(
        "arithmetic_or_coding",
        problem,
        "controller",
        ["corrected_invoice_or_allocations"],
        problem,
      ),
    );
  const sourceMap = new Map(input.documents.map((d) => [sourceKey(d), d]));
  if (
    input.documents.some((d) =>
      d.pageStatus.some((p) => p.status !== "complete"),
    )
  )
    result.push(
      exception(
        "incomplete_pages",
        "Failed/missing pages remain in the case and block progression.",
        "ap_clerk",
        ["complete_original_pages"],
      ),
    );
  const byField = new Map(c.evidence.map((e) => [e.fieldPath, e]));
  const required: [string, string | number][] = [
    ["extractedSupplierName", c.extractedSupplierName],
    ["invoiceNumber", c.invoiceNumber],
    ["invoiceDate", c.invoiceDate],
    ["totalCents", c.totalCents],
  ];
  for (const l of c.lines)
    required.push(
      [`lines.${l.lineId}.sku`, l.sku ?? ""],
      [`lines.${l.lineId}.description`, l.description],
      [`lines.${l.lineId}.quantity`, l.quantity.decimal],
      [`lines.${l.lineId}.unitPriceCents`, l.unitPriceCents],
      [`lines.${l.lineId}.amountCents`, l.amountCents],
    );
  for (const [path, value] of required) {
    const e = byField.get(path);
    if (
      !e ||
      e.contentStatus !== "supported" ||
      String(e.normalizedValue) !== String(value) ||
      !e.quote.trim()
    )
      result.push(
        exception(
          "unsupported_field",
          `Missing/conflicting source support for ${path}.`,
          "ap_clerk",
          [path],
          path,
        ),
      );
  }
  for (const e of c.evidence) {
    if (e.contentStatus !== "supported")
      result.push(
        exception(
          "content_conflict",
          `Unresolved content: ${e.fieldPath}`,
          "ap_clerk",
          [e.evidenceId],
          e.evidenceId,
        ),
      );
    if (e.grounding.status === "unresolved" && !fieldsReviewed)
      result.push(
        exception(
          "geometry_review_required",
          `Precise location unavailable for ${e.fieldPath}; explicitly review the correct original/text.`,
          "ap_clerk",
          [e.evidenceId],
          e.evidenceId,
        ),
      );
    if (
      e.grounding.status === "derived" &&
      (!e.grounding.processor.tokenArtifact ||
        !e.grounding.processor.configArtifact ||
        !e.grounding.processor.rawArtifact ||
        (e.grounding.method === "local_ocr_exact" &&
          (!e.grounding.processor.rasterArtifact ||
            !e.grounding.processor.traineddata)))
    )
      result.push(
        exception(
          "grounding_provenance_missing",
          `Derived region lacks immutable artifact provenance: ${e.fieldPath}`,
          "ap_clerk",
          [e.evidenceId],
          e.evidenceId,
        ),
      );
  }
  const validPurchasing = input.purchasingEvidence.filter((p) => {
    const document = sourceMap.get(sourceKey(p.source));
    const kind = p.kind === "service_acceptance" ? "receipt" : p.kind;
    const valid =
      !!document && document.kind === kind && p.supplierId === c.supplierId;
    if (!valid)
      result.push(
        exception(
          "purchasing_source_mismatch",
          `Purchasing evidence ${p.reference} is not bound to the original source/supplier.`,
          "purchasing_owner",
          [p.reference],
          p.reference,
        ),
      );
    return valid;
  });
  for (const line of c.lines) {
    const catalog = supplier.catalog.find((p) => p.sku === line.sku);
    if (!catalog)
      result.push(
        exception(
          "unknown_sku",
          `Unknown SKU ${line.sku ?? "(missing)"}.`,
          "purchasing_owner",
          ["approved_catalog_mapping"],
          line.lineId,
        ),
      );
    if (!catalog || line.quantity.unit !== catalog.uom)
      result.push(
        exception(
          "unknown_unit",
          `Unit ${line.quantity.unit} is not the approved SKU unit.`,
          "purchasing_owner",
          ["approved_unit_mapping"],
          line.lineId,
        ),
      );
    if (catalog && line.unitPriceCents !== catalog.unitCents)
      result.push(
        exception(
          "price_variance",
          `Invoice unit price ${line.unitPriceCents} differs from approved ${catalog.unitCents}.`,
          "purchasing_owner",
          ["corrected_invoice_or_authorized_variance"],
          line.lineId,
        ),
      );
    const po = validPurchasing
      .filter((p) => p.kind === "purchase_order")
      .flatMap((p) => p.lines)
      .filter(
        (p) => p.lineId === line.poLineId && p.invoiceLineId === line.lineId,
      );
    if (!line.poLineId || po.length !== 1)
      result.push(
        exception(
          "missing_po",
          `No unique PO line for ${line.lineId}.`,
          "purchasing_owner",
          ["purchase_order"],
          line.lineId,
        ),
      );
    else if (
      po[0]!.sku !== line.sku ||
      po[0]!.quantity.unit !== line.quantity.unit ||
      po[0]!.unitPriceCents !== line.unitPriceCents ||
      quantityMicros(po[0]!.quantity.decimal) <
        quantityMicros(line.quantity.decimal)
    )
      result.push(
        exception(
          "po_mismatch",
          `PO SKU, unit, price or quantity does not cover ${line.lineId}.`,
          "purchasing_owner",
          ["corrected_po_or_invoice"],
          line.lineId,
        ),
      );
    const receipts = validPurchasing
      .filter((p) => p.kind === "receipt" && p.acceptedBy && p.acceptedAt)
      .flatMap((p) => p.lines)
      .filter(
        (r) =>
          line.receiptLineIds.includes(r.lineId) &&
          r.invoiceLineId === line.lineId,
      );
    if (
      !line.receiptLineIds.length ||
      receipts.length !== new Set(line.receiptLineIds).size ||
      new Set(receipts.map((r) => r.lineId)).size !== receipts.length
    )
      result.push(
        exception(
          "missing_receipt",
          `Accepted receipt lines are missing or ambiguous for ${line.lineId}.`,
          "receiving_owner",
          ["accepted_receiving_evidence"],
          line.lineId,
        ),
      );
    else if (
      receipts.some(
        (r) => r.sku !== line.sku || r.quantity.unit !== line.quantity.unit,
      ) ||
      receipts.reduce(
        (sum, r) => sum + quantityMicros(r.quantity.decimal),
        0n,
      ) < quantityMicros(line.quantity.decimal)
    )
      result.push(
        exception(
          "receipt_mismatch",
          `Received SKU/unit/quantity does not cover ${line.lineId}.`,
          "receiving_owner",
          ["corrected_receipt_or_authorized_adjustment"],
          line.lineId,
        ),
      );
    const duplicateReceipt = validPurchasing
      .filter((p) => p.kind === "receipt")
      .flatMap((p) => p.lines)
      .some(
        (r) =>
          line.receiptLineIds.includes(r.lineId) &&
          r.invoiceLineId !== line.lineId,
      );
    if (duplicateReceipt)
      result.push(
        exception(
          "ambiguous_receipt",
          `Receipt line reused across invoice lines.`,
          "receiving_owner",
          ["unique_receiving_allocation"],
          line.lineId,
        ),
      );
  }
  for (const a of [
    ...c.lines.flatMap((l) => l.allocations),
    ...c.freightAllocations,
    ...c.discountAllocations,
  ]) {
    if (
      a.account !== "5000" ||
      a.treatment !== "expense" ||
      a.department !== null ||
      a.project !== null ||
      a.period !== c.invoiceDate.slice(0, 7) ||
      (a.store !== null && !STORES.some((s) => s.id === a.store))
    )
      result.push(
        exception(
          "unsupported_allocation",
          "First-wave Golden State policy requires reviewed food-cost expense allocations, known stores and invoice period; other treatments need the expanded policy.",
          "controller",
          ["supported_account_allocation"],
          `${a.account}:${a.store ?? "company"}`,
        ),
      );
  }
  return result;
}
export function obligationKey(c: Candidate): string {
  return `${c.supplierId ?? "unverified"}:${c.currency}:${c.kind}:${c.invoiceNumber
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^(INVOICE|INV|NO)/, "")
    .replace(/^0+/, "")}`;
}
