import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decimalString, keyValues, mapContractAttorneyInvoice, moneyCents } from "./apex-invoice";
import { simplePdf } from "./apex-intake";
import { cents, parseCsv } from "./apex-sources";
import { parseBboxXhtml, readTextLayer, type TextPage } from "./text-layer";

// Fictional words laid out like the APEX contract-attorney invoices, including the description overflow.
const W: [number, number, number, number, string][] = [
  [60, 57.8, 120, 76.3, "Jane"], [124, 57.8, 180, 76.3, "Roe,"], [184, 57.8, 220, 76.3, "Esq."], [453, 58.9, 552, 81.1, "INVOICE"],
  [496, 84.3, 531, 94.4, "Invoice"], [534, 84.3, 552, 94.4, "No."], [470, 96.3, 552, 106.4, "ROE-202401-B1"],
  [312, 217, 343, 226, "Invoice"], [346, 217, 370, 226, "Date:"], [373, 217, 410, 226, "January"], [413, 217, 425, 226, "5,"], [428, 217, 450, 226, "2024"],
  [312, 230, 330, 239, "Due"], [333, 230, 357, 239, "Date:"], [360, 230, 400, 239, "February"], [403, 230, 415, 239, "4,"], [418, 230, 440, 239, "2024"],
  [312, 243, 351, 252, "Payment"], [354, 243, 385, 252, "Terms:"], [388, 243, 404, 252, "Net"], [407, 243, 418, 252, "30"],
  [312, 256, 340, 265, "Matter"], [343, 256, 392, 265, "Reference:"], [394, 256, 454, 265, "M-2024-0099"],
  [60, 327.7, 79.5, 336, "Date"], [121.2, 327.7, 170.7, 336, "Description"], [414.4, 327.7, 440.4, 336, "Hours"], [467.7, 327.7, 487.2, 336, "Rate"], [518, 327.7, 552, 336, "Amount"],
  [60, 351.7, 105, 360, "01/05/2024"], [121.2, 351.7, 160, 360, "Research"], [163, 351.7, 200, 360, "memo"], [400, 351.7, 430, 360, "drafting"],
  [422.9, 351.7, 440.4, 360, "12.5"], [440, 351.7, 470, 360, "review"], [454.7, 351.7, 487.2, 360, "$180.00"], [512, 351.7, 552, 360, "$2,250.00"], [540, 351.7, 600, 360, "matter"],
  [404.5, 385, 444, 394, "Subtotal:"], [507.5, 385, 552, 394, "$2,250.00"],
  [385.3, 406.6, 414, 417.7, "Total"], [417.3, 406.6, 444, 417.7, "Due:"], [498.6, 406.6, 552, 417.7, "$2,250.00"],
];
const page: TextPage = { page: 1, width: 612, height: 792, words: W.map(([xMin, yMin, xMax, yMax, text], i) => ({ id: `p1w${i + 1}`, page: 1, text, xMin, yMin, xMax, yMax })) };

describe("APEX contract-attorney invoice mapping", () => {
  it("maps header, totals and right-aligned service columns from native words", () => {
    const r = mapContractAttorneyInvoice(page);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const i = r.invoice;
    expect([i.supplierName, i.invoiceNumber, i.invoiceDate, i.dueDate, i.terms, i.matterReference]).toEqual(["Jane Roe, Esq.", "ROE-202401-B1", "2024-01-05", "2024-02-04", "Net 30", "M-2024-0099"]);
    expect(i.lines).toEqual([{ lineId: "L1", serviceDate: "2024-01-05", description: "Research memo drafting review matter", hours: "12.5", rateCents: 18000, amountCents: 225000 }]);
    expect([i.subtotalCents, i.totalCents]).toEqual([225000, 225000]);
    expect(new Set(i.fields.map(f => f.fieldPath)).size).toBe(i.fields.length);
    expect(i.fields.find(f => f.fieldPath === "lines.L1.sku")?.normalizedValue).toBe("M-2024-0099");
    expect(i.warnings.some(w => w.includes("overlaps"))).toBe(true);
  });
  it("fails closed instead of guessing", () => {
    expect(mapContractAttorneyInvoice({ ...page, words: [] })).toEqual({ ok: false, reason: "no_text_layer" });
    expect(mapContractAttorneyInvoice({ ...page, words: page.words.filter(w => w.text !== "$180.00") })).toEqual({ ok: false, reason: "service_row_columns_ambiguous" });
    expect(mapContractAttorneyInvoice({ ...page, words: page.words.filter(w => w.text !== "Reference:") })).toEqual({ ok: false, reason: "matter_reference_unresolved" });
  });
  it("normalizes money and decimals exactly", () => {
    expect([moneyCents("$3,000.00"), moneyCents("$200.00"), moneyCents("3000"), moneyCents("$3,00.00")]).toEqual([300000, 20000, null, null]);
    expect([decimalString("15.0"), decimalString("17.50"), decimalString("024"), decimalString("1e3")]).toEqual(["15", "17.5", "24", null]);
  });
});

describe("replay helpers", () => {
  it("parses poppler bbox XHTML and quoted CSV", () => {
    const pages = parseBboxXhtml('<page width="612.000000" height="792.000000"><word xMin="1.0" yMin="2.0" xMax="3.0" yMax="4.0">Sterling,&amp;</word></page>');
    expect(pages).toEqual([{ page: 1, width: 612, height: 792, words: [{ id: "p1w1", page: 1, text: "Sterling,&", xMin: 1, yMin: 2, xMax: 3, yMax: 4 }] }]);
    expect(parseCsv('a,b\n1,"Avila, ""Esq."""\r\n')).toEqual([{ a: "1", b: 'Avila, "Esq."' }]);
    expect([cents("3500.0"), cents("-12.5"), cents("0")]).toEqual([350000, -1250, 0]);
    expect(() => cents("1e3")).toThrow();
  });
  it("writes deterministic simulated PDFs", () => {
    const a = simplePdf(["SIMULATED", "Reference: X"]), b = simplePdf(["SIMULATED", "Reference: X"]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).subarray(0, 5).toString()).toBe("%PDF-");
    expect(() => simplePdf(["café"])).toThrow("simple_pdf_ascii_only");
  });
  const poppler = (() => { try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();
  it.skipIf(!poppler)("reads simulated document key/value pairs back through the local text layer", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "apex-replay-"));
    const file = path.join(dir, "sim.pdf");
    writeFileSync(file, simplePdf(["SIMULATED SERVICE ACCEPTANCE", "Reference: SIM-1", "Accepted hours: 15", "Accepted by: SIMULATED matter owner"]));
    const { pages } = await readTextLayer(file);
    const kv = keyValues(pages[0]!);
    expect([kv.get("Reference")?.value, kv.get("Accepted hours")?.value, kv.get("Accepted by")?.value]).toEqual(["SIM-1", "15", "SIMULATED matter owner"]);
  });
});
