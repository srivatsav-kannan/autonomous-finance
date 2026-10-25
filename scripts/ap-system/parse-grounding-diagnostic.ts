/** Optional private-source regression. Never copies the archival source into Git. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  providerGrounding,
  groundText,
  decode,
} from "../../src/ap-system/ingestion/grounding";
import { localOcr } from "../../src/ap-system/ingestion/ocr";
import {
  saveArtifact,
  sha256,
  canonical,
} from "../../src/ap-system/ingestion/storage";
import type { SourceDocument, Processor } from "../../src/ap-system/contracts";
const sourceDir = resolve(
  process.argv[2] ??
    "/Users/junjiexiong/Desktop/calhacks/var/ap-environment/llamaparse-grounding-20261025",
);
const root = resolve(
  process.env.AP_STORAGE_ROOT ??
    "var/ap97-20261025-01a1722e-a/private-scan-diagnostic",
);
await mkdir(root, { recursive: true, mode: 0o700 });
const bytes = await readFile(join(sourceDir, "invoice-real-scan.jpg"));
const original = await saveArtifact(root, bytes, "image");
const result = JSON.parse(
  await readFile(join(sourceDir, "raw-result.private.json"), "utf8"),
);
const groundedBytes = await readFile(join(sourceDir, "raw-grounded.jsonl")),
  wordsBytes = await readFile(join(sourceDir, "raw-raw-words.jsonl"));
const grounded = groundedBytes
    .toString()
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s)),
  rawWords = wordsBytes
    .toString()
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
const configArtifact = await saveArtifact(
  root,
  await readFile(join(sourceDir, "request-config.json")),
);
const processor: Processor = {
  provider: "llamaparse",
  model: "agentic_plus",
  version: "latest",
  resolvedVersion: null,
  implementationVersion: "prior-private-diagnostic-20261025",
  jobId: result.job.id,
  configHash: configArtifact.sha256,
  configArtifact,
  rawArtifact: await saveArtifact(root, groundedBytes, "jsonl"),
  tokenArtifact: await saveArtifact(root, wordsBytes, "jsonl"),
  rasterArtifact: null,
  traineddata: null,
};
const source: SourceDocument = {
  sourceId: "private-archival-scan",
  revision: 1,
  sha256: sha256(bytes),
  deliveryId: "private-grounding-control",
  name: "invoice-real-scan.jpg",
  kind: "invoice",
  mimeType: "image/jpeg",
  originalRef: original.ref,
  byteLength: bytes.length,
  extractedText: result.text_full,
  provenance: {
    kind: "external_private",
    description:
      "Original private archival capture used by prior reviewed diagnostic; not a redistributable fixture",
    license: "Private diagnostic only; see launch provenance restrictions",
    originalFilename: "invoice-real-scan.jpg",
  },
  replaces: null,
  pageCount: 1,
  pageStatus: [{ page: 1, status: "complete", reason: null }],
  parser: processor,
};
const data = providerGrounding({
  result,
  grounded,
  rawWords,
  processor,
  reused: true,
});
const table = grounded[0].items.find(
  (i: any) => i.type === "table" && i.rows[0][0] === "DESCRIPTION",
);
const query = decode(table.rows[1][0]);
const without = await groundText(query, data);
const local = await localOcr(source, root, {
  traineddataPath:
    process.env.AP_TESSDATA_ENG ??
    "/opt/homebrew/share/tessdata/eng.traineddata",
});
const resolved = await groundText(query, data, { localOcr: async () => local });
const report = {
  sourceSha256: source.sha256,
  priorJobId: processor.jobId,
  priorParserRequestedVersion: processor.version,
  priorParserResolvedVersion: null,
  newProviderJobs: 0,
  nativeDescriptionPresent: Boolean(table.grounding.rows[1][0].bbox),
  withoutFallback: { status: without.status, reason: without.failureReason },
  withFallback: resolved,
  scope:
    "One genuine private archival scan; engine integration regression, not representative production reliability or AP candidate acceptance",
};
await writeFile(
  join(root, "report.private.json"),
  JSON.stringify(report, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    sourceSha256: source.sha256,
    newProviderJobs: 0,
    nativeDescriptionPresent: report.nativeDescriptionPresent,
    withoutFallback: report.withoutFallback,
    withFallback: {
      status: resolved.status,
      method: resolved.method,
      regionCount: resolved.regions.length,
      units: resolved.frame?.units,
      reason: resolved.failureReason,
      tokenRefs: resolved.regions.map((r) => r.tokenRefs),
    },
  }),
);
if (resolved.method !== "local_ocr_exact" || resolved.regions.length !== 2)
  process.exitCode = 1;
