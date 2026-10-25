import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localOcr, renderPage, parseTsv } from "./ocr";
import { sha256 } from "./storage";
import type { SourceDocument } from "../contracts";
const bytes = Buffer.from("%PDF-test");
const source: SourceDocument = {
  sourceId: "s",
  revision: 1,
  sha256: sha256(bytes),
  deliveryId: "d",
  name: "test.pdf",
  kind: "invoice",
  mimeType: "application/pdf",
  originalRef: "private-ref-stripped",
  originalBase64: bytes.toString("base64"),
  byteLength: bytes.length,
  extractedText: "",
  provenance: {
    kind: "synthetic",
    description: "test",
    license: "test",
    originalFilename: "test.pdf",
  },
  replaces: null,
  pageCount: 1,
  pageStatus: [{ page: 1, status: "complete", reason: null }],
  parser: null,
};
async function temp(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ap-ocr-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it("rejects changed original bytes before rendering the rehydrated source", async () =>
  temp(async (root) => {
    await expect(
      renderPage({
        source: {
          ...source,
          originalBase64: Buffer.from("different").toString("base64"),
        },
        page: 1,
        storageRoot: root,
      }),
    ).rejects.toThrow("original_hash_mismatch");
  }));
it("distinguishes unavailable renderer and bounded process timeout", async () =>
  temp(async (root) => {
    await expect(
      renderPage({
        source,
        page: 1,
        storageRoot: root,
        options: { pdfinfoPath: join(root, "missing") },
      }),
    ).rejects.toThrow("render_dependency_unavailable");
    const sleeper = join(root, "sleeper");
    await writeFile(
      sleeper,
      "#!/usr/bin/env node\nsetTimeout(()=>{},5000);\n",
      { mode: 0o700 },
    );
    await expect(
      renderPage({
        source,
        page: 1,
        storageRoot: root,
        options: { pdfinfoPath: sleeper, timeoutMs: 25 },
      }),
    ).rejects.toThrow("render_process_timeout");
  }));
it("fails closed for unconfigured, unavailable or unpinned traineddata", async () =>
  temp(async (root) => {
    await expect(
      localOcr(source, root, { traineddataPath: "" }),
    ).rejects.toThrow("ocr_traineddata_not_configured");
    await expect(
      localOcr(source, root, { traineddataPath: join(root, "missing") }),
    ).rejects.toThrow("ocr_traineddata_unavailable");
    const wrong = join(root, "eng.traineddata");
    await writeFile(wrong, "not pinned data");
    await expect(
      localOcr(source, root, { traineddataPath: wrong }),
    ).rejects.toThrow("ocr_traineddata_version_mismatch");
  }));
it("maps actual TSV word tokens into the declared original page frame", () => {
  const words = parseTsv(
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t20\t40\t60\t24\t90\tKale\n",
    2,
    0.5,
    0.5,
  );
  expect(words[0]).toMatchObject({
    id: "ocr:2:0",
    page: 2,
    text: "Kale",
    box: { x: 10, y: 20, width: 30, height: 12 },
  });
});
