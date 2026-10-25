import { it, expect } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseUpload } from "./index";
import { UBL_PROFILE } from "./xml";
const context = {
  supplier: {
    supplierId: "format-test-supplies",
    legalName: "Format Test Supplies LLC",
  },
  coding: {
    account: "5000",
    store: "synthetic-store",
    department: null,
    project: null,
    treatment: "expense" as const,
  },
};
const input = () =>
  readFile("fixtures/ap-system/formats-v1/input/invoice-ubl.xml", "utf8");
async function parse(text: string, ctx = context) {
  const root = await mkdtemp(join(tmpdir(), "ap-xml-"));
  try {
    return await parseUpload({
      bytes: Buffer.from(text),
      name: "invoice.xml",
      mimeType: "application/xml",
      storageRoot: root,
      context: ctx,
      options: {
        fetcher: async () => {
          throw Error("XML must never call hosted parsing");
        },
      },
      sourceId: "xml-source",
      revision: 3,
      provenance: {
        kind: "synthetic",
        description: "test",
        license: "project authored",
        originalFilename: "invoice.xml",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it("maps explicit positive line/header taxes, fractional quantity and source paths with no geometry invention", async () => {
  const r = await parse(await input());
  expect(r.candidate).toMatchObject({
    revision: 3,
    supplierId: "format-test-supplies",
    totalCents: 1890,
    subtotalCents: 1750,
    taxCents: 140,
  });
  expect(r.candidate!.lines.map((l) => l.taxCents)).toEqual([80, 60]);
  expect(r.candidate!.lines.map((l) => l.allocations[0]!.amountCents)).toEqual([
    1080, 810,
  ]);
  expect(r.candidate!.lines[0]!.quantity).toEqual({
    decimal: "2.5",
    unit: "C62",
  });
  expect(
    r.candidate!.evidence.every(
      (e) =>
        e.source.revision === 3 &&
        e.grounding.method === "xml_path" &&
        e.grounding.status === "native" &&
        e.grounding.frame === null &&
        e.grounding.page === null &&
        !e.grounding.regions.length &&
        e.grounding.elementPath?.startsWith("/Q{urn:oasis:"),
    ),
  ).toBe(true);
  expect(r.documents[0]!.originalBase64).toBe(
    Buffer.from(await input()).toString("base64"),
  );
});
it("matches namespace URIs rather than relying on producer-chosen prefixes", async () => {
  const text = (await input())
    .replaceAll("xmlns:cbc=", "xmlns:basic=")
    .replaceAll("cbc:", "basic:");
  expect((await parse(text)).candidate?.totalCents).toBe(1890);
});
it("does not assign trusted supplier ID to an unmatched extracted legal name", async () => {
  const r = await parse(
    (await input()).replace(
      "Format Test Supplies LLC",
      "Different Supplier LLC",
    ),
  );
  expect(r.candidate?.supplierId).toBe(null);
  expect(r.candidate?.extractedSupplierName).toBe("Different Supplier LLC");
});
it.each([
  [
    "unknown profile",
    (s: string) => s.replace(UBL_PROFILE, "urn:unknown"),
    "xml_unsupported_profile",
  ],
  [
    "wrong version",
    (s: string) => s.replace(">2.1<", ">2.0<"),
    "xml_unsupported_ubl_version",
  ],
  [
    "namespace spoof",
    (s: string) =>
      s.replace(
        'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
        'xmlns="urn:fake"',
      ),
    "xml_invoice_namespace_required",
  ],
  [
    "duplicate invoice ID",
    (s: string) =>
      s.replace(
        "<cbc:ID>FMT-XML-01</cbc:ID>",
        "<cbc:ID>FMT-XML-01</cbc:ID><cbc:ID>OTHER</cbc:ID>",
      ),
    "xml_duplicate_ID",
  ],
  [
    "duplicate line ID",
    (s: string) => s.replace("<cbc:ID>2</cbc:ID>", "<cbc:ID>1</cbc:ID>"),
    "xml_duplicate_line_id",
  ],
  [
    "tax mismatch",
    (s: string) => s.replace(">1.40<", ">1.41<"),
    "xml_tax_total_mismatch",
  ],
  [
    "line amount mismatch",
    (s: string) =>
      s.replace(">2.5</cbc:InvoicedQuantity>", ">2.6</cbc:InvoicedQuantity>"),
    "xml_line_amount_mismatch",
  ],
  [
    "currency mismatch",
    (s: string) => s.replace('currencyID="USD"', 'currencyID="EUR"'),
    "xml_amount_currency_mismatch",
  ],
  [
    "nonunit price base",
    (s: string) => s.replace(">1</cbc:BaseQuantity>", ">2</cbc:BaseQuantity>"),
    "xml_unsupported_price_base",
  ],
  [
    "unsupported tax subtotal",
    (s: string) =>
      s.replace("</cac:TaxTotal>", "<cac:TaxSubtotal/></cac:TaxTotal>"),
    "xml_unsupported_element",
  ],
  [
    "missing content",
    (s: string) =>
      s.replace("<cbc:Description>Paper towels</cbc:Description>", ""),
    "xml_missing_Description",
  ],
  [
    "overflow",
    (s: string) =>
      s.replace(
        ">18.90</cbc:PayableAmount>",
        ">9007199254740993.00</cbc:PayableAmount>",
      ),
    "xml_invalid_exact_cents",
  ],
] as const)("retains source and holds %s", async (_, mutate, reason) => {
  const r = await parse(mutate(await input()));
  expect(r.candidate).toBe(null);
  expect(r.extraction.reasons).toContain(reason);
  expect(r.documents).toHaveLength(1);
  expect(r.documents[0]!.originalBase64).toBeTruthy();
});
it.each([
  [
    "DTD",
    (s: string) =>
      s.replace(
        "<Invoice",
        '<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///etc/passwd">]><Invoice',
      ),
    "xml_dtd_forbidden",
  ],
  [
    "external stylesheet",
    (s: string) =>
      s.replace(
        "<Invoice",
        '<?xml-stylesheet href="https://invalid.test/style"?><Invoice',
      ),
    "xml_processing_instruction_unsupported",
  ],
  ["malformed", (s: string) => s.slice(0, -20), "xml_malformed"],
  [
    "oversized",
    () => "<x>" + "x".repeat(1024 * 1024) + "</x>",
    "xml_byte_budget_exceeded",
  ],
] as const)(
  "fails closed for %s without provider access",
  async (_, mutate, reason) => {
    const r = await parse(mutate(await input()));
    expect(r.candidate).toBe(null);
    expect(r.extraction.status).toBe("failed");
    expect(r.extraction.reasons).toContain(reason);
    expect(r.documents[0]!.pageStatus[0]!.status).toBe("failed");
  },
);

it("does not double-decode or strip markup from an XML supplier value", async () => {
  const r = await parse(
    (await input()).replace(
      "Format Test Supplies LLC",
      "&lt;b&gt;Format Test Supplies LLC&lt;/b&gt;",
    ),
  );
  expect(r.candidate?.supplierId).toBe(null);
  expect(r.candidate?.extractedSupplierName).toBe(
    "<b>Format Test Supplies LLC</b>",
  );
});
