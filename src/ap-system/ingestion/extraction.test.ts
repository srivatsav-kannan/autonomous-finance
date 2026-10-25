import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { extractCandidate, supportingEvidence, money } from "./extraction";
import { parseDocument, combineUploads } from "./index";
import { providerGrounding, groundText } from "./grounding";
import type { SourceDocument } from "../contracts";
import type { ProviderOutput } from "./provider";
const load = async (name = "invoice") =>
  JSON.parse(
    await readFile(
      `fixtures/ap-system/parser-contract-v1/${name}.json`,
      "utf8",
    ),
  ) as ProviderOutput & { sourceSha256: string };
const source = (
  sha256: string,
  kind: SourceDocument["kind"] = "invoice",
): SourceDocument => ({
  sourceId: "source-1",
  revision: 1,
  sha256,
  deliveryId: "d",
  name: "invoice.pdf",
  kind,
  mimeType: "application/pdf",
  originalRef: "test-only",
  byteLength: 1,
  extractedText: "",
  provenance: {
    kind: "synthetic",
    description: "test",
    license: "synthetic",
    originalFilename: "invoice.pdf",
  },
  replaces: null,
  pageCount: 1,
  pageStatus: [{ page: 1, status: "complete", reason: null }],
  parser: null,
});
const context = {
  supplier: {
    supplierId: "golden-state-produce",
    legalName: "Golden State Produce Co.",
  },
  coding: {
    account: "5000",
    store: "sf-hayes-valley",
    department: null,
    project: null,
    treatment: "expense" as const,
  },
};
it("extracts the actual saved provider result, not the evaluator answer file", async () => {
  const output = await load();
  const r = await extractCandidate(
    source(output.sourceSha256),
    output,
    "/tmp",
    context,
    false,
  );
  expect(r.candidate?.totalCents).toBe(67860);
  expect(r.candidate?.lines.map((l) => l.quantity.decimal)).toEqual([
    "5",
    "4",
    "3",
    "2",
  ]);
  expect(r.candidate?.lines.every((l) => l.evidenceIds.length === 6)).toBe(
    true,
  );
  expect(
    r.candidate?.evidence.find(
      (e) => e.fieldPath === "lines.line-1.description",
    )?.grounding.method,
  ).toBe("native");
  expect(r.candidate?.supplierId).toBe("golden-state-produce");
});
it("does not confer supplier identity from context when printed supplier differs", async () => {
  const output = await load();
  const r = await extractCandidate(
    source(output.sourceSha256),
    output,
    "/tmp",
    { supplier: { supplierId: "unrelated", legalName: "Different Supplier" } },
    false,
  );
  expect(r.candidate?.supplierId).toBe(null);
  expect(r.candidate?.lines[0]?.allocations).toEqual([]);
});
it("preserves fields but cannot create a candidate when required content or pages are missing", async () => {
  const output = await load();
  output.result.markdown_full = output.result.markdown_full.replace(
    /\*\*Invoice Date:\*\*[^\n]+/,
    "",
  );
  const s = source(output.sourceSha256);
  s.pageStatus[0]!.status = "failed";
  const r = await extractCandidate(s, output, "/tmp", context, false);
  expect(r.candidate).toBe(null);
  expect(r.extraction.evidence.length).toBeGreaterThan(0);
  expect(r.extraction.reasons).toContain("missing_invoiceDate");
  expect(r.extraction.reasons).toContain("incomplete_pages");
});
it("maps actual PO and receipt tables to invoice line identities", async () => {
  const inv = await load();
  const r = await extractCandidate(
    source(inv.sourceSha256),
    inv,
    "/tmp",
    context,
    false,
  );
  const po = await load("purchase-order"),
    receipt = await load("receipt");
  expect(
    supportingEvidence(
      source(po.sourceSha256, "purchase_order"),
      po,
      r.candidate!,
      context,
    )?.lines.map((l) => l.lineId),
  ).toEqual(["po-line-1", "po-line-2", "po-line-3", "po-line-4"]);
  expect(
    supportingEvidence(
      source(receipt.sourceSha256, "receipt"),
      receipt,
      r.candidate!,
      context,
    )?.acceptedBy,
  ).toBe("Fixture Receiving Operator (simulated)");
});
it("keeps overflow and missing money out of normalized amounts", () => {
  expect(money("9007199254740993.00")).toBe(null);
  expect(money("USD 0.00")).toBe(0);
  expect(money("USD 12.345")).toBe(null);
  expect(money("unreadable")).toBe(null);
});
it("rejects packet bounds before writing or calling providers", async () => {
  await expect(
    combineUploads({
      uploads: [
        {
          bytes: new Uint8Array(8 * 1024 * 1024 + 1),
          name: "x",
          mimeType: "application/pdf",
        },
      ],
      storageRoot: "/tmp",
      idempotencyKey: "x",
    }),
  ).rejects.toThrow("upload_packet_size_limit");
});
it("rejects a mismatched original page frame instead of highlighting a wrong field", async () => {
  const output = await load();
  output.result.__apOriginalFrames = [
    { page: 1, width: 792, height: 612, rotation: 0 },
  ];
  const g = await groundText("INV-1001", providerGrounding(output));
  expect(g.status).toBe("unresolved");
  expect(g.failureReason).toBe("unsupported_source_transform");
});

it("does not silently drop an unreadable line while publishing a complete candidate", async () => {
  const output = await load();
  const table = output.result.items.pages[0].items.find(
    (i: any) => i.type === "table" && i.rows[0].includes("SKU"),
  );
  table.rows[1][2] = "unreadable";
  const r = await extractCandidate(
    source(output.sourceSha256),
    output,
    "/tmp",
    context,
    false,
  );
  expect(r.candidate).toBe(null);
  expect(
    r.extraction.reasons.some((r) => r.startsWith("unparsed_line_row")),
  ).toBe(true);
});
it("returns explicit unresolved geometry when the provider has no usable page frame", async () => {
  const output = await load();
  output.result.items.pages[0].page_width = null;
  const g = await groundText("INV-1001", providerGrounding(output));
  expect(g.status).toBe("unresolved");
  expect(g.frame).toBe(null);
  expect(g.regions).toEqual([]);
});

it("does not substitute remaining balance or total due for the original document total", async () => {
  const output = await load();
  output.result.markdown_full = output.result.markdown_full.replace(
    "<b>Total</b>",
    "<b>Total Due</b>",
  );
  const r = await extractCandidate(
    source(output.sourceSha256),
    output,
    "/tmp",
    context,
    false,
  );
  expect(r.candidate).toBe(null);
  expect(r.extraction.reasons).toContain("missing_or_ambiguous_totalCents");
});
