import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { APCaseDetail } from "../../src/ap-system/contracts";
import { caseGuidanceContext } from "../../src/ap-system/case-guidance";
import { parseGuidancePdf } from "../../src/ap-system/guidance-pdf-intake";
import { createDurableAPIntake } from "../../src/ap-system/intake-requests";

const directories: string[] = [];
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const readPdf = (name: string) => readFile(new URL(`../../fixtures/ap-system/guidance-pdfs/${name}`, import.meta.url));
const provenance = {
  kind: "synthetic" as const,
  description: "Retained synthetic original with reviewed provenance metadata",
  license: "CC0 synthetic demo",
  originalFilename: "cleaning-b.pdf",
};
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const value = await mkdtemp(path.join(os.tmpdir(), "ap-real-guidance-pdf-"));
  directories.push(value);
  return value;
}

describe("real synthetic PDF adapter through durable intake", () => {
  it.each([
    { name: "cleaning-b.pdf", category: "routine_cleaning", invoice: "CLEAN-B-20261025", amount: 8500 },
    { name: "renovation-c.pdf", category: "capital_renovation", invoice: "RENOV-C-20261026", amount: 250000 },
  ])("retains prepared metadata and exact original for $name, then replays after restart", async expected => {
    const bytes = await readPdf(expected.name), owned = await directory();
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const parser = vi.fn(parseGuidancePdf);
    const loadCase = vi.fn(async (): Promise<APCaseDetail> => { throw new Error("New upload should not load a prior case"); });
    const make = () => createDurableAPIntake({ directory: owned, loadCase, parse: parser });
    const request = {
      uploads: [{ bytes, name: expected.name, mimeType: "application/pdf", kind: "invoice" as const }],
      idempotencyKey: `real-pdf-${expected.category}`, explicitRevisionOf: null,
    };
    const first = await make()(request), source = first.documents[0]!, prepared = parser.mock.calls[0]![0].uploads[0]!;
    expect(first.extraction.status).toBe("complete");
    expect(first.candidate).toMatchObject({ invoiceNumber: expected.invoice, totalCents: expected.amount, supplierId: "hyphenate-demo-cleaning" });
    expect(caseGuidanceContext(first)).toMatchObject({ context: { category: expected.category, location: "sf-hayes-valley", amountCents: expected.amount }, reasons: [] });
    expect(source).toMatchObject({ name: prepared.name, mimeType: prepared.mimeType, kind: prepared.kind,
      deliveryId: prepared.deliveryId, provenance: prepared.provenance, sha256: sha(bytes), byteLength: bytes.length,
      pageCount: 1, parser: { provider: "Poppler pdftotext", model: null } });
    // The durable wrapper owns provenance. The PDF adapter must not replace it with its own synthetic label.
    expect(source.provenance).toEqual(prepared.provenance);
    expect(source.provenance.kind).toBe("external_private");
    expect(Buffer.from(source.originalBase64!, "base64")).toEqual(bytes);
    expect(source.extractedText).toContain("SYNTHETIC DEMONSTRATION");
    expect(first.candidate!.evidence.find(e => e.fieldPath === "category")?.normalizedValue).toBe(expected.category);
    parser.mockRejectedValue(new Error("Parser unavailable after wrapper restart"));
    expect(await make()(request)).toEqual(first);
    expect(parser).toHaveBeenCalledTimes(1);
    expect(loadCase).not.toHaveBeenCalled();
    const otherPdf = await readPdf(expected.name === "cleaning-b.pdf" ? "renovation-c.pdf" : "cleaning-b.pdf");
    await expect(make()({ ...request, uploads: [{ ...request.uploads[0]!, bytes: otherPdf }] })).rejects.toMatchObject({ code: "intake_key_conflict" });
    expect(parser).toHaveBeenCalledTimes(1);
  });

  it("preserves prepared source identity, revision, replacement and prior provenance for a real PDF revision", async () => {
    const bytes = await readPdf("cleaning-b.pdf"), owned = await directory();
    const original = await parseGuidancePdf({ uploads: [{ bytes, name: "cleaning-b.pdf", mimeType: "application/pdf", kind: "invoice",
      sourceId: "retained-cleaning-source", revision: 3, deliveryId: "earlier-delivery", provenance }],
      idempotencyKey: "earlier-request", explicitRevisionOf: null });
    const source = original.documents[0]!, sourceBinding = { sourceId: source.sourceId, revision: source.revision, sha256: source.sha256 };
    const prior = { caseId: "retained-case", revision: 3, sources: [source], currentSourceBindings: [sourceBinding] } as APCaseDetail;
    const loadCase = vi.fn(async () => prior), parser = vi.fn(parseGuidancePdf);
    const make = () => createDurableAPIntake({ directory: owned, loadCase, parse: parser });
    const request = { uploads: [{ bytes, name: "cleaning-b.pdf", mimeType: "application/pdf", kind: "invoice" as const }],
      idempotencyKey: "real-pdf-revision", explicitRevisionOf: prior.caseId };
    const revised = await make()(request), prepared = parser.mock.calls[0]![0].uploads[0]!;
    expect(revised.documents[0]).toMatchObject({ sourceId: "retained-cleaning-source", revision: 4,
      replaces: sourceBinding, deliveryId: prepared.deliveryId, provenance, sha256: sha(bytes) });
    expect(revised.candidate!.revision).toBe(4);
    expect(Buffer.from(revised.documents[0]!.originalBase64!, "base64")).toEqual(bytes);
    parser.mockRejectedValue(new Error("No reparse on replay"));
    loadCase.mockRejectedValue(new Error("No loading advanced case on replay"));
    expect(await make()(request)).toEqual(revised);
    expect(parser).toHaveBeenCalledTimes(1);
    expect(loadCase).toHaveBeenCalledTimes(1);
  });
});
