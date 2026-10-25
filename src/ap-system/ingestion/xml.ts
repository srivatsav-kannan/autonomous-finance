import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  APIntake,
  Candidate,
  CandidateLine,
  FieldEvidence,
  Processor,
  SourceDocument,
} from "../contracts";
import { candidateSchema } from "../contracts";
import type { TrustedContext } from "./extraction";
import { NORMALIZATION } from "./grounding";
import { saveArtifact, sha256, canonical, inside } from "./storage";

export const UBL_NAMESPACES = {
  ubl: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
} as const;
export const UBL_CUSTOMIZATION = "urn:autonomous-finance:ap:ubl-2.1:invoice:v1";
export const UBL_PROFILE =
  "urn:autonomous-finance:ap:invoice:usd-explicit-tax:v1";
export const XML_LIMIT = 1024 * 1024;
type Node = {
  name: string;
  path: string;
  text: string;
  attrs: Record<string, string>;
  children: number[];
};
export type XmlOutput = {
  nodes: Node[];
  runtime: { python: string; expat: string };
  failure: string | null;
  processor: Processor;
};
const script = fileURLToPath(
  new URL("./runtime/parse-xml.py", import.meta.url),
);
export async function parseXml(
  bytes: Uint8Array,
  storageRoot: string,
): Promise<XmlOutput> {
  const original = await saveArtifact(storageRoot, bytes, "xml");
  const config = {
    implementation: "ap-ubl-v1",
    namespaces: UBL_NAMESPACES,
    ublVersion: "2.1",
    customization: UBL_CUSTOMIZATION,
    profile: UBL_PROFILE,
    maxBytes: XML_LIMIT,
    maxElements: 4096,
    maxDepth: 32,
    maxLines: 200,
    timeoutMs: 5000,
    scriptSha256: sha256(await readFile(script)),
    sourceSha256: sha256(bytes),
  };
  const configArtifact = await saveArtifact(storageRoot, canonical(config));
  let parsed: {
    nodes: Node[];
    runtime: { python: string; expat: string };
    failure: string | null;
  };
  try {
    if (bytes.byteLength > XML_LIMIT) throw Error("xml_byte_budget_exceeded");
    const { stdout } = await promisify(execFile)(
      process.env.AP_PYTHON ?? "python3",
      [script, inside(storageRoot, original.ref)],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
    );
    parsed = JSON.parse(stdout);
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { killed?: boolean };
    parsed = {
      nodes: [],
      runtime: { python: "unavailable", expat: "unavailable" },
      failure:
        e.message === "xml_byte_budget_exceeded"
          ? e.message
          : e.code === "ENOENT"
            ? "xml_runtime_unavailable"
            : e.killed
              ? "xml_process_timeout"
              : "xml_process_failed",
    };
  }
  const rawArtifact = await saveArtifact(storageRoot, canonical(parsed));
  const version = `Python-${parsed.runtime.python}/${parsed.runtime.expat}`;
  const processor: Processor = {
    provider: "local_xml_expat",
    model: null,
    version,
    resolvedVersion: parsed.runtime.python === "unavailable" ? null : version,
    implementationVersion: "ap-ubl-v1",
    configHash: configArtifact.sha256,
    configArtifact,
    rawArtifact,
    tokenArtifact: null,
    rasterArtifact: null,
    traineddata: null,
    jobId: null,
  };
  return { ...parsed, processor };
}
const q = (prefix: keyof typeof UBL_NAMESPACES, name: string) =>
  `${UBL_NAMESPACES[prefix]}}${name}`;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const normalizeXmlText = (s: string) =>
  s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
function cents(s: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return null;
  const [a, b = ""] = s.split(".");
  const n = BigInt(a!) * 100n + BigInt(b.padEnd(2, "0"));
  return n <= MAX ? Number(n) : null;
}
function exactLine(quantity: string, price: number, amount: number) {
  const [n, f = ""] = quantity.split(".");
  const scale = 10n ** BigInt(f.length);
  return BigInt(n! + f) * BigInt(price) === BigInt(amount) * scale;
}

/** Project-owned strict UBL subset, not general UBL or Peppol validation. */
export function extractXmlCandidate(
  source: SourceDocument,
  output: XmlOutput,
  context: TrustedContext = {},
): { candidate: Candidate | null; extraction: APIntake["extraction"] } {
  const reasons: string[] = [],
    evidence: FieldEvidence[] = [];
  const nodes = output.nodes;
  const fail = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const incomplete = () => ({
    candidate: null,
    extraction: { status: "incomplete" as const, evidence, reasons },
  });
  if (output.failure)
    return {
      candidate: null,
      extraction: { status: "failed", evidence: [], reasons: [output.failure] },
    };
  const root = nodes[0];
  if (!root || root.name !== q("ubl", "Invoice")) {
    fail("xml_invoice_namespace_required");
    return incomplete();
  }
  const children = (n: Node, name: string) =>
    n.children.map((i) => nodes[i]!).filter((c) => c.name === name);
  const one = (
    n: Node | undefined,
    prefix: keyof typeof UBL_NAMESPACES,
    name: string,
    required = true,
  ) => {
    if (!n) return undefined;
    const found = children(n, q(prefix, name));
    if (found.length > 1) fail(`xml_duplicate_${name}`);
    if (required && !found.length) fail(`xml_missing_${name}`);
    return found.length === 1 ? found[0] : undefined;
  };
  const leaf = (n: Node | undefined) => {
    if (!n) return null;
    if (n.children.length) {
      fail("xml_nested_scalar_unsupported");
      return null;
    }
    const s = n.text.trim();
    if (!s || s.length > 2048) {
      fail("xml_empty_or_long_scalar");
      return null;
    }
    return s;
  };
  const path = (n: Node | undefined, ...parts: string[]) => {
    let cur = n;
    for (const part of parts) {
      const [prefix, name] = part.split(":");
      cur = one(cur, prefix as keyof typeof UBL_NAMESPACES, name!);
    }
    return cur;
  };
  const allowed = (n: Node | undefined, names: string[]) => {
    if (!n) return;
    const set = new Set(
      names.map((s) => {
        const [p, v] = s.split(":");
        return q(p as keyof typeof UBL_NAMESPACES, v!);
      }),
    );
    if (n.text.trim()) fail("xml_mixed_content_unsupported");
    let prior = -1;
    const ordered = [...set];
    for (const i of n.children) {
      const index = ordered.indexOf(nodes[i]!.name);
      if (index < 0) fail("xml_unsupported_element");
      else if (index < prior) fail("xml_element_order_unsupported");
      else prior = index;
    }
  };
  // Unknown elements/attributes must not silently alter tax, amounts or supplier identity.
  for (const n of nodes) {
    const local = n.name.split("}").at(-1)!;
    const allowedAttrs = [
      "TaxAmount",
      "LineExtensionAmount",
      "TaxExclusiveAmount",
      "TaxInclusiveAmount",
      "AllowanceTotalAmount",
      "ChargeTotalAmount",
      "PayableAmount",
      "PriceAmount",
    ].includes(local)
      ? ["currencyID"]
      : ["InvoicedQuantity", "BaseQuantity"].includes(local)
        ? ["unitCode"]
        : [];
    if (Object.keys(n.attrs).some((a) => !allowedAttrs.includes(a)))
      fail("xml_unsupported_attribute");
  }
  allowed(root, [
    "cbc:UBLVersionID",
    "cbc:CustomizationID",
    "cbc:ProfileID",
    "cbc:ID",
    "cbc:IssueDate",
    "cbc:DueDate",
    "cbc:InvoiceTypeCode",
    "cbc:DocumentCurrencyCode",
    "cac:AccountingSupplierParty",
    "cac:AccountingCustomerParty",
    "cac:PaymentTerms",
    "cac:TaxTotal",
    "cac:LegalMonetaryTotal",
    "cac:InvoiceLine",
  ]);
  const version = leaf(one(root, "cbc", "UBLVersionID")),
    customization = leaf(one(root, "cbc", "CustomizationID")),
    profile = leaf(one(root, "cbc", "ProfileID"));
  if (version !== "2.1") fail("xml_unsupported_ubl_version");
  if (customization !== UBL_CUSTOMIZATION || profile !== UBL_PROFILE)
    fail("xml_unsupported_profile");
  if (leaf(one(root, "cbc", "InvoiceTypeCode")) !== "380")
    fail("xml_unsupported_invoice_type");
  const bind = {
    sourceId: source.sourceId,
    revision: source.revision,
    sha256: source.sha256,
  };
  const add = (
    fieldPath: string,
    node: Node | undefined,
    value: string | number | null,
    attribute?: string,
  ) => {
    if (!node || value === null) return;
    const raw = attribute ? (node.attrs[attribute] ?? "") : node.text.trim();
    const id =
      "e-" +
      sha256(`${source.sha256}:${source.revision}:${fieldPath}`).slice(0, 24);
    evidence.push({
      evidenceId: id,
      source: bind,
      fieldPath,
      rawValue: raw,
      normalizedValue: value,
      contentStatus: "supported",
      quote: raw,
      grounding: {
        status: "native",
        method: "xml_path",
        page: null,
        frame: null,
        regions: [],
        contextRegions: [],
        normalization: NORMALIZATION,
        processor: output.processor,
        failureReason: null,
        elementPath: node.path + (attribute ? "/@" + attribute : ""),
      },
    });
    return id;
  };
  const read = (field: string, node: Node | undefined) => {
    const v = leaf(node);
    add(field, node, v);
    return v;
  };
  const amount = (field: string, node: Node | undefined) => {
    const s = leaf(node),
      v = s === null ? null : cents(s);
    if (node?.attrs.currencyID !== "USD") fail("xml_amount_currency_mismatch");
    if (v === null) fail("xml_invalid_exact_cents");
    add(field, node, v);
    return v;
  };
  const supplierParty = one(root, "cac", "AccountingSupplierParty");
  allowed(supplierParty, ["cac:Party"]);
  const supplier = one(supplierParty, "cac", "Party");
  allowed(supplier, ["cac:PartyLegalEntity"]);
  const legal = one(supplier, "cac", "PartyLegalEntity");
  allowed(legal, ["cbc:RegistrationName"]);
  const name = read(
    "extractedSupplierName",
    one(legal, "cbc", "RegistrationName"),
  );
  const customerParty = one(root, "cac", "AccountingCustomerParty");
  allowed(customerParty, ["cac:Party"]);
  const customer = one(customerParty, "cac", "Party");
  allowed(customer, ["cac:PartyName"]);
  const customerName = one(customer, "cac", "PartyName");
  allowed(customerName, ["cbc:Name"]);
  leaf(one(customerName, "cbc", "Name"));
  const invoiceNumber = read("invoiceNumber", one(root, "cbc", "ID")),
    invoiceDate = read("invoiceDate", one(root, "cbc", "IssueDate")),
    dueDate = read("dueDate", one(root, "cbc", "DueDate", false)),
    currency = read("currency", one(root, "cbc", "DocumentCurrencyCode"));
  if (currency !== "USD") fail("xml_unsupported_currency");
  const termsNode = one(root, "cac", "PaymentTerms", false);
  allowed(termsNode, ["cbc:Note"]);
  const terms = read(
    "terms",
    termsNode ? one(termsNode, "cbc", "Note") : undefined,
  );
  const taxTotal = one(root, "cac", "TaxTotal");
  allowed(taxTotal, ["cbc:TaxAmount"]);
  const tax = amount("taxCents", one(taxTotal, "cbc", "TaxAmount"));
  const totals = one(root, "cac", "LegalMonetaryTotal");
  allowed(totals, [
    "cbc:LineExtensionAmount",
    "cbc:TaxExclusiveAmount",
    "cbc:TaxInclusiveAmount",
    "cbc:AllowanceTotalAmount",
    "cbc:ChargeTotalAmount",
    "cbc:PayableAmount",
  ]);
  const subtotal = amount(
      "subtotalCents",
      one(totals, "cbc", "LineExtensionAmount"),
    ),
    exclusive = amount(
      "taxExclusiveCents",
      one(totals, "cbc", "TaxExclusiveAmount"),
    ),
    inclusive = amount(
      "taxInclusiveCents",
      one(totals, "cbc", "TaxInclusiveAmount"),
    ),
    discount = amount(
      "discountCents",
      one(totals, "cbc", "AllowanceTotalAmount"),
    ),
    freight = amount("freightCents", one(totals, "cbc", "ChargeTotalAmount")),
    total = amount("totalCents", one(totals, "cbc", "PayableAmount"));
  if (discount !== 0 || freight !== 0) fail("xml_allowance_charge_unsupported");
  const rows = children(root, q("cac", "InvoiceLine"));
  if (!rows.length || rows.length > 200) fail("xml_line_count_unsupported");
  const lines: CandidateLine[] = [];
  const ids = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const start = evidence.length,
      lineId = `line-${i + 1}`,
      prefix = `lines.${lineId}.`;
    allowed(row, [
      "cbc:ID",
      "cbc:InvoicedQuantity",
      "cbc:LineExtensionAmount",
      "cac:TaxTotal",
      "cac:Item",
      "cac:Price",
    ]);
    const sourceLineId = read(prefix + "sourceLineId", one(row, "cbc", "ID"));
    if (sourceLineId && ids.has(sourceLineId)) fail("xml_duplicate_line_id");
    if (sourceLineId) ids.add(sourceLineId);
    const quantityNode = one(row, "cbc", "InvoicedQuantity"),
      quantity = read(prefix + "quantity", quantityNode),
      unit = quantityNode?.attrs.unitCode ?? null;
    add(prefix + "unit", quantityNode, unit, "unitCode");
    if (
      !quantity ||
      !/^\d+(?:\.\d{1,6})?$/.test(quantity) ||
      !/[1-9]/.test(quantity)
    )
      fail("xml_invalid_quantity");
    if (!unit || !/^[A-Z0-9]{1,8}$/.test(unit)) fail("xml_unit_code_required");
    const amountCents = amount(
      prefix + "amountCents",
      one(row, "cbc", "LineExtensionAmount"),
    );
    const lineTax = one(row, "cac", "TaxTotal");
    allowed(lineTax, ["cbc:TaxAmount"]);
    const taxCents = amount(
      prefix + "taxCents",
      one(lineTax, "cbc", "TaxAmount"),
    );
    const item = one(row, "cac", "Item");
    allowed(item, ["cbc:Description", "cac:SellersItemIdentification"]);
    const description = read(
      prefix + "description",
      one(item, "cbc", "Description"),
    );
    const itemId = one(item, "cac", "SellersItemIdentification");
    allowed(itemId, ["cbc:ID"]);
    const sku = read(prefix + "sku", one(itemId, "cbc", "ID"));
    const price = one(row, "cac", "Price");
    allowed(price, ["cbc:PriceAmount", "cbc:BaseQuantity"]);
    const priceCents = amount(
      prefix + "unitPriceCents",
      one(price, "cbc", "PriceAmount"),
    );
    const base = one(price, "cbc", "BaseQuantity");
    if (leaf(base) !== "1" || base?.attrs.unitCode !== unit)
      fail("xml_unsupported_price_base");
    if (
      quantity &&
      /^\d+(?:\.\d{1,6})?$/.test(quantity) &&
      priceCents !== null &&
      amountCents !== null &&
      !exactLine(quantity, priceCents, amountCents)
    )
      fail("xml_line_amount_mismatch");
    if (
      quantity &&
      unit &&
      description &&
      sku &&
      priceCents !== null &&
      amountCents !== null &&
      taxCents !== null
    ) {
      const gross = BigInt(amountCents) + BigInt(taxCents);
      if (gross > MAX) {
        fail("xml_amount_overflow");
        continue;
      }
      lines.push({
        lineId,
        sku,
        description,
        quantity: { decimal: quantity, unit },
        unitPriceCents: priceCents,
        amountCents,
        taxCents,
        poLineId: null,
        receiptLineIds: [],
        evidenceIds: evidence.slice(start).map((e) => e.evidenceId),
        allocations:
          context.coding && invoiceDate
            ? [
                {
                  ...context.coding,
                  amountCents: Number(gross),
                  period: invoiceDate.slice(0, 7),
                },
              ]
            : [],
      });
    }
  }
  const sum = (key: "amountCents" | "taxCents") =>
    lines.reduce((n, l) => n + BigInt(l[key]), 0n);
  if (subtotal !== null && sum("amountCents") !== BigInt(subtotal))
    fail("xml_line_total_mismatch");
  if (tax !== null && sum("taxCents") !== BigInt(tax))
    fail("xml_tax_total_mismatch");
  if (
    subtotal !== null &&
    tax !== null &&
    (exclusive !== subtotal ||
      inclusive === null ||
      BigInt(inclusive) !== BigInt(subtotal) + BigInt(tax) ||
      total !== inclusive)
  )
    fail("xml_document_total_mismatch");
  if (source.pageStatus.some((p) => p.status !== "complete"))
    fail("xml_incomplete_document");
  if (reasons.length) return incomplete();
  const supplierId =
    context.supplier &&
    name &&
    [context.supplier.legalName, ...(context.supplier.aliases ?? [])].some(
      (s) => normalizeXmlText(s) === normalizeXmlText(name),
    )
      ? context.supplier.supplierId
      : null;
  const candidate = candidateSchema.safeParse({
    candidateId: "candidate-" + source.sourceId,
    revision: source.revision,
    sources: [bind],
    extractedSupplierName: name,
    supplierId,
    invoiceNumber,
    invoiceDate,
    dueDate,
    terms,
    currency,
    kind: "invoice",
    appliesToBillId: null,
    lines,
    subtotalCents: subtotal,
    taxCents: tax,
    freightCents: freight,
    discountCents: discount,
    totalCents: total,
    freightAllocations: [],
    discountAllocations: [],
    evidence,
    parseWarnings: [
      "Validated project-owned UBL subset; no XML signature authentication, general UBL or Peppol conformance asserted.",
    ],
  });
  if (!candidate.success) {
    fail("xml_candidate_schema_validation_failed");
    return incomplete();
  }
  return {
    candidate: candidate.data,
    extraction: { status: "complete", evidence: [], reasons: [] },
  };
}
