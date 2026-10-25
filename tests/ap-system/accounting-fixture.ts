import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { vi } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";
import { sha256Hex } from "../../convex/lib/kernel";
import {
  AP_CONTRACT_VERSION,
  AP_POLICY_VERSION,
  type APIntake,
  type APCaseDetail,
  type FieldEvidence,
  type SourceDocument,
  type SourceBinding,
} from "../../src/ap-system/contracts";
import { PAYMENT_EXECUTOR_VERSION } from "../../src/payments/contracts";
type CurrentCaseDetail = APCaseDetail & {
  currentSourceBindings: SourceBinding[];
};
const modules = import.meta.glob("../../convex/**/*.ts");
export const refs = {
  ingest: makeFunctionReference<"mutation">("apCases:ingest"),
  review: makeFunctionReference<"mutation">("apCases:reviewFields"),
  approve: makeFunctionReference<"mutation">("apCases:approveBill"),
  detail: makeFunctionReference<"query">("apCases:detail"),
  list: makeFunctionReference<"query">("apCases:list"),
  source: makeFunctionReference<"query">("apCases:source"),
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function packet(number = "GS-1042"): APIntake {
  const text = `Golden State Produce Co.\nInvoice ${number}\n2026-10-19\nKALE-24 Organic Kale, 24ct case 2 case 3850 7700\nTotal 7700 cents`;
  const doc = (
    id: string,
    kind: SourceDocument["kind"],
    body: string,
  ): SourceDocument => ({
    sourceId: id,
    revision: 1,
    sha256: sha(body),
    deliveryId: `delivery-${id}-${number}`,
    name: `${id}.pdf`,
    kind,
    mimeType: "application/pdf",
    originalRef: `/private/ap/${id}.pdf`,
    originalBase64: Buffer.from(body).toString("base64"),
    byteLength: Buffer.byteLength(body),
    extractedText: body,
    provenance: {
      kind: "synthetic",
      description:
        "Policy unit-test text stand-in; not a parser/PDF verification fixture",
      license: "test only",
      originalFilename: `${id}.pdf`,
    },
    replaces: null,
    pageCount: 1,
    pageStatus: [{ page: 1, status: "complete", reason: null }],
    parser: null,
  });
  const invoice = doc(`invoice-${number}`, "invoice", text),
    po = doc(
      `po-${number}`,
      "purchase_order",
      "PO Golden State KALE-24 2 case unit 3850",
    ),
    receipt = doc(
      `receipt-${number}`,
      "receipt",
      "Accepted by receiving-owner on 2026-10-19: KALE-24 2 case",
    );
  const binding = (d: SourceDocument) => ({
    sourceId: d.sourceId,
    revision: d.revision,
    sha256: d.sha256,
  });
  const field = (path: string, value: string | number): FieldEvidence => ({
    evidenceId: `field-${path}`,
    source: binding(invoice),
    fieldPath: path,
    rawValue: String(value),
    normalizedValue: value,
    contentStatus: "supported",
    quote: String(value),
    grounding: {
      status: "unresolved",
      method: "none",
      page: 1,
      frame: null,
      regions: [],
      contextRegions: [],
      normalization:
        "html_decode+nfc+whitespace+casefold;no_character_substitution",
      processor: {
        provider: "test",
        model: null,
        version: "v1",
        configHash: sha("config"),
        jobId: null,
        resolvedVersion: "v1",
        implementationVersion: "test-v1",
        configArtifact: null,
        rawArtifact: null,
        tokenArtifact: null,
        rasterArtifact: null,
        traineddata: null,
      },
      failureReason: "no coordinates in test text fixture",
      elementPath: null,
    },
  });
  const fields = [
    field("extractedSupplierName", "Golden State Produce Co."),
    field("invoiceNumber", number),
    field("invoiceDate", "2026-10-19"),
    field("totalCents", 7700),
    field("lines.line-1.sku", "KALE-24"),
    field("lines.line-1.description", "Organic Kale, 24ct case"),
    field("lines.line-1.quantity", "2"),
    field("lines.line-1.unitPriceCents", 3850),
    field("lines.line-1.amountCents", 7700),
  ];
  return {
    contractVersion: AP_CONTRACT_VERSION,
    idempotencyKey: `ingest-${number}`,
    documents: [invoice, po, receipt],
    candidate: {
      candidateId: `candidate-${number}`,
      revision: 1,
      sources: [invoice, po, receipt].map(binding),
      extractedSupplierName: "Golden State Produce Co.",
      supplierId: "golden-state-produce",
      invoiceNumber: number,
      invoiceDate: "2026-10-19",
      dueDate: "2026-11-02",
      terms: "Net 14",
      currency: "USD",
      kind: "invoice",
      appliesToBillId: null,
      lines: [
        {
          lineId: "line-1",
          sku: "KALE-24",
          description: "Organic Kale, 24ct case",
          quantity: { decimal: "2", unit: "case" },
          unitPriceCents: 3850,
          amountCents: 7700,
          taxCents: 0,
          evidenceIds: fields
            .filter((f) => f.fieldPath.startsWith("lines."))
            .map((f) => f.evidenceId),
          poLineId: "po-line-1",
          receiptLineIds: ["receipt-line-1"],
          allocations: [
            {
              account: "5000",
              amountCents: 7700,
              store: "sf-hayes-valley",
              department: null,
              project: null,
              period: "2026-10",
              treatment: "expense",
            },
          ],
        },
      ],
      freightAllocations: [],
      discountAllocations: [],
      subtotalCents: 7700,
      taxCents: 0,
      freightCents: 0,
      discountCents: 0,
      totalCents: 7700,
      evidence: fields,
      parseWarnings: [],
    },
    extraction: { status: "complete", evidence: fields, reasons: [] },
    purchasingEvidence: [
      {
        supplierId: "golden-state-produce",
        source: binding(po),
        kind: "purchase_order",
        reference: "PO-1",
        lines: [
          {
            lineId: "po-line-1",
            sku: "KALE-24",
            quantity: { decimal: "2", unit: "case" },
            unitPriceCents: 3850,
            invoiceLineId: "line-1",
          },
        ],
        acceptedBy: null,
        acceptedAt: null,
      },
      {
        supplierId: "golden-state-produce",
        source: binding(receipt),
        kind: "receipt",
        reference: "GR-1",
        lines: [
          {
            lineId: "receipt-line-1",
            sku: "KALE-24",
            quantity: { decimal: "2", unit: "case" },
            unitPriceCents: null,
            invoiceLineId: "line-1",
          },
        ],
        acceptedBy: "receiving-owner",
        acceptedAt: "2026-10-19T12:00:00Z",
      },
    ],
    explicitRevisionOf: null,
  };
}
export async function fixture() {
  vi.stubEnv("KERNEL_ADMIN_SECRET", "test-admin");
  vi.stubEnv("AP_DISPATCH_SECRET", "test-dispatch");
  vi.stubEnv("AP_EVIDENCE_SECRET", "test-evidence");
  const t = convexTest(schema, modules);
  const scope = {
    organizationId: "ap-org",
    runId: "ap97-b-unit",
    provider: "fake" as const,
    environment: "local" as const,
    accountId: "account-b",
  };
  vi.stubEnv("AP_BANK_SCOPE", JSON.stringify(scope));
  const identity = {
    issuer: "https://ap-demo.invalid",
    subject: "reviewer",
    tokenIdentifier: "https://ap-demo.invalid|reviewer",
  };
  const human = t.withIdentity(identity);
  await t.mutation(api.admin.createRun, {
    secret: "test-admin",
    runId: scope.runId,
    label: "AP B acceptance",
    company: "Synthetic",
    simDate: "2026-10-19",
    periods: ["2026-10"],
    seats: await Promise.all(
      ["ap_clerk", "controller", "payments", "human_cfo"].map(async (role) => ({
        seatId: role,
        role,
        name: role,
        kind: role === "human_cfo" ? ("human" as const) : ("agent" as const),
        tokenHash: await sha256Hex(`token-${role}`),
      })),
    ),
  });
  await t.mutation(api.demoPayments.configure, {
    scope,
    secret: "test-admin",
    paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
    beneficiary: {
      vendor: "golden-state-produce",
      externalAccountId: "synthetic-beneficiary",
      version: "v1",
    },
    policyVersion: AP_POLICY_VERSION,
    controllerLimitCents: 1_000_000,
    humanSubjects: [{ subject: identity.tokenIdentifier, seatId: "human_cfo" }],
  });
  const ap = { scope, seatId: "ap_clerk", token: "token-ap_clerk" };
  const get = (caseId: string) =>
    t.query(refs.detail, { ...ap, caseId }) as Promise<CurrentCaseDetail>;
  const request = (d: CurrentCaseDetail, key = "review") => ({
    caseId: d.caseId,
    expectedRevision: d.revision,
    sourceBindings: d.currentSourceBindings,
    snapshotHash: d.snapshotHash,
    idempotencyKey: key,
    outcome: "approved" as const,
    reason:
      "Compared every field to the immutable original and reviewed coding",
    evidenceIds: d.candidate?.evidence.map((e) => e.evidenceId) ?? [],
  });
  async function reviewed(input = packet()) {
    const r = await t.mutation(refs.ingest, { ...ap, input });
    const d = await get(r.caseId);
    await human.mutation(refs.review, { scope, input: request(d) });
    return get(r.caseId);
  }
  return { t, human, scope, ap, get, request, reviewed, identity };
}
