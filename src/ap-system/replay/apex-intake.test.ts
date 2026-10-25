import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { accountingProblems } from "../accounting";
import { apexTextLayerIntake, resolveTrustedSupplier, simplePdf, type TrustedSupplier } from "./apex-intake";
import { APEX_SOURCE, cents, loadApexWorld } from "./apex-sources";
import { popplerVersion } from "./text-layer";

const suppliers: TrustedSupplier[] = [
  { supplierId: "jane", legalName: "Jane Roe, Esq." },
  { supplierId: "westfield", legalName: "Westfield Legal Services LLC" },
];

describe("APEX supplier catalog binding", () => {
  it("selects the unique normalized full legal name from a catalog", () => {
    expect(resolveTrustedSupplier("  WESTFIELD Legal Services, LLC ", suppliers)).toEqual({ supplier: suppliers[1], warning: null });
    expect(resolveTrustedSupplier("Jane Roe Esq", suppliers)).toEqual({ supplier: suppliers[0], warning: null });
  });
  it("leaves unknown, abbreviated and missing names unbound", () => {
    for (const name of ["Unknown Supplier", "Westfield Legal Services", "", "Jäne Roe, Esq."]) {
      expect(resolveTrustedSupplier(name, suppliers)).toMatchObject({ supplier: null, warning: expect.stringContaining("no exact normalized match") });
    }
    expect(resolveTrustedSupplier("Jane Roe, Esq.", [])).toMatchObject({ supplier: null });
    expect(resolveTrustedSupplier("Jane Roe, Esq.", [{ supplierId: "", legalName: "Jane Roe, Esq." }])).toMatchObject({ supplier: null });
  });
  it("does not guess when multiple supplier records normalize to the same name", () => {
    const ambiguous = [...suppliers, { supplierId: "other-jane", legalName: "JANE ROE ESQ" }];
    expect(resolveTrustedSupplier("Jane Roe, Esq.", ambiguous)).toMatchObject({ supplier: null, warning: expect.stringContaining("multiple supplier catalog entries") });
  });
});

const pdftotextPath = process.env.AP_PDFTOTEXT ?? "pdftotext";
const pdfinfoPath = process.env.AP_PDFINFO ?? "pdfinfo";
const havePoppler = (() => {
  try {
    execFileSync(pdftotextPath, ["-v"], { stdio: "ignore" });
    execFileSync(pdfinfoPath, ["-v"], { stdio: "ignore" });
    return true;
  } catch { return false; }
})();

describe.skipIf(!havePoppler)("APEX native PDF intake", () => {
  it("retains an actual unsupported original and reports extraction failure instead of creating a sample candidate", async () => {
    const storageRoot = await mkdtemp(path.join(tmpdir(), "apex-unsupported-"));
    try {
      const bytes = simplePdf(["A real uploaded PDF", "This is not the supported invoice layout."]);
      const intake = await apexTextLayerIntake({
        uploads: [{ bytes, name: "uploaded.pdf", mimeType: "application/pdf" }],
        storageRoot, idempotencyKey: "unsupported-pdf", suppliers,
        coding: { account: "6000", treatment: "expense" },
        options: { pdftotextPath, popplerVersion: await popplerVersion(pdftotextPath), ocr: { pdfinfoPath } },
      });
      expect(intake.candidate).toBeNull();
      expect(intake.extraction).toMatchObject({ status: "failed", reasons: ["invoice_number_label_missing"] });
      expect(intake.documents[0]!.originalBase64).toBe(Buffer.from(bytes).toString("base64"));
      expect(intake.documents[0]!.extractedText).toContain("A real uploaded PDF");
      expect(intake.documents[0]!.parser!.provider).toBe("local-poppler-pdftotext");
    } finally { await rm(storageRoot, { recursive: true, force: true }); }
  });

  it("does not claim native parsing or OCR succeeded for an image-only PDF", async () => {
    const storageRoot = await mkdtemp(path.join(tmpdir(), "apex-scan-"));
    try {
      const bytes = await readFile("fixtures/ap-system/formats-v1/input/invoice-scanned.pdf");
      const intake = await apexTextLayerIntake({
        uploads: [{ bytes, name: "scanned.pdf", mimeType: "application/pdf" }],
        storageRoot, idempotencyKey: "scan-pdf", suppliers,
        coding: { account: "6000", treatment: "expense" },
        options: { pdftotextPath, popplerVersion: await popplerVersion(pdftotextPath), ocr: { pdfinfoPath } },
      });
      expect(intake.candidate).toBeNull();
      expect(intake.extraction.status).toBe("failed");
      expect(intake.documents[0]!.pageStatus).toContainEqual({ page: 1, status: "failed", reason: "no_native_text_layer" });
      expect(intake.documents[0]!.originalBase64).toBe(bytes.toString("base64"));
    } finally { await rm(storageRoot, { recursive: true, force: true }); }
  });

  it("retains all pages of an unsupported multipage invoice without pretending to parse only the first page", async () => {
    const storageRoot = await mkdtemp(path.join(tmpdir(), "apex-multipage-"));
    try {
      const bytes = await readFile("fixtures/ap-system/formats-v1/input/multipage-layout.pdf");
      const intake = await apexTextLayerIntake({
        uploads: [{ bytes, name: "multipage.pdf", mimeType: "application/pdf" }],
        storageRoot, idempotencyKey: "multipage-pdf", suppliers,
        coding: { account: "6000", treatment: "expense" },
        options: { pdftotextPath, popplerVersion: await popplerVersion(pdftotextPath), ocr: { pdfinfoPath } },
      });
      expect(intake.candidate).toBeNull();
      expect(intake.extraction).toMatchObject({ status: "failed", reasons: ["unsupported_page_count"] });
      expect(intake.documents[0]!.pageCount).toBeGreaterThan(1);
      expect(intake.documents[0]!.originalBase64).toBe(bytes.toString("base64"));
    } finally { await rm(storageRoot, { recursive: true, force: true }); }
  });
});

// Optional local integration: the licensed source dataset is deliberately not
// checked into this repository. APEX_WORLD_ROOT enables the complete 21-PDF run.
describe.skipIf(!havePoppler || !process.env.APEX_WORLD_ROOT)("APEX complete local invoice corpus", () => {
  it("reads all 21 originals, binds all three suppliers, retains citations and exposes all 15 printed arithmetic discrepancies", async () => {
    const world = await loadApexWorld(process.env.APEX_WORLD_ROOT!);
    const catalog = world.vendors.map(v => ({
      supplierId: `apex-${v["Vendor ID"]!.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
      legalName: v["Vendor Name"]!,
    }));
    const storageRoot = await mkdtemp(path.join(tmpdir(), "apex-corpus-"));
    const options = { pdftotextPath, popplerVersion: await popplerVersion(pdftotextPath), ocr: { pdfinfoPath } };
    const supplierIds = new Set<string>();
    let arithmeticDiscrepancies = 0;
    let unresolvedPrintedDescriptions = 0;
    try {
      expect(world.invoiceFiles).toHaveLength(21);
      for (const file of world.invoiceFiles) {
        const bytes = await readFile(world.invoicePath(file));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const provenance = { kind: "external_licensed" as const, description: APEX_SOURCE.label, license: APEX_SOURCE.license, originalFilename: file };
        const intake = await apexTextLayerIntake({
          uploads: [{ bytes, name: file, mimeType: "application/pdf", provenance }],
          storageRoot, idempotencyKey: `corpus-${sha256}`, suppliers: catalog,
          coding: { account: "6000", treatment: "expense" }, options,
        });
        expect(intake.extraction.status, file).toBe("complete");
        const candidate = intake.candidate!;
        expect(candidate, file).not.toBeNull();
        const ledger = world.apLedger.filter(row => row.docnumber === candidate.invoiceNumber);
        expect(ledger, file).toHaveLength(1);
        const row = ledger[0]!;
        expect(candidate.extractedSupplierName, file).toBe(row.vendor_name);
        expect(candidate.supplierId, file).toBe(`apex-${row.vendorref_value!.toLowerCase().replace(/[^a-z0-9]/g, "")}`);
        supplierIds.add(candidate.supplierId!);
        expect([candidate.invoiceDate, candidate.dueDate, candidate.terms, candidate.totalCents], file).toEqual([row.txndate, row.due_date, row.payment_terms, cents(row.bill_amount)]);
        expect(candidate.lines.every(line => line.sku === row.matter_number), file).toBe(true);
        const source = intake.documents[0]!;
        expect(source.sha256, file).toBe(sha256);
        expect(source.originalBase64, file).toBe(bytes.toString("base64"));
        expect(source.provenance, file).toEqual(provenance);
        expect(source.parser!.provider, file).toBe("local-poppler-pdftotext");
        for (const field of candidate.evidence) {
          expect(field.source.sha256, file).toBe(sha256);
          if (field.grounding.status === "unresolved") {
            expect(["Kao_KAO-202403-003.pdf", "Kao_KAO-202409-009.pdf"]).toContain(file);
            expect(field.fieldPath).toBe("lines.L1.description");
            expect(field.grounding.failureReason).toBe("native_text_outside_source_frame");
            expect(field.grounding.regions).toEqual([]);
            expect(candidate.parseWarnings.some(w => w.includes("extends outside the PDF page"))).toBe(true);
            unresolvedPrintedDescriptions++;
          } else {
            expect(field.grounding.status, file).toBe("native");
            expect(field.grounding.regions.length, file).toBeGreaterThan(0);
          }
        }
        const problems = accountingProblems(candidate);
        if (file.startsWith("Avila_")) expect(problems, file).toEqual([]);
        else {
          expect(problems, file).toEqual(["line_math:L1"]);
          arithmeticDiscrepancies++;
          // Preserve the printed quantity, price and amount. Never reverse-
          // engineer hours from the ledger total to make the invoice pass.
          expect(candidate.lines[0], file).toMatchObject(file.startsWith("Kao_")
            ? { quantity: { decimal: "24.2" }, unitPriceCents: 16500, amountCents: 400000 }
            : { quantity: { decimal: "27.6" }, unitPriceCents: 14500, amountCents: 400000 });
        }
      }
      expect([...supplierIds].sort()).toEqual(["apex-v040", "apex-v041", "apex-v042"]);
      expect(arithmeticDiscrepancies).toBe(15);
      expect(unresolvedPrintedDescriptions).toBe(2);
    } finally { await rm(storageRoot, { recursive: true, force: true }); }
  }, 30_000);
});
