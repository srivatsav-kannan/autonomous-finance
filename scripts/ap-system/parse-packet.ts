import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  combineUploads,
  renderPage,
  type Upload,
} from "../../src/ap-system/ingestion/index";
import { VENDORS } from "../../company/sweetgreen/profile";
const root = resolve(
  process.argv[2] ?? "fixtures/ap-system/golden-state-v1/input",
);
const storageRoot = resolve(
  process.env.AP_STORAGE_ROOT ?? "var/ap97-20261025-01a1722e-a",
);
await mkdir(storageRoot, { recursive: true, mode: 0o700 });
const names = [
  ["invoice", "invoice"],
  ["purchase-order", "purchase_order"],
  ["receipt", "receipt"],
  ["contract", "contract"],
] as const;
const uploads: Upload[] = await Promise.all(
  names.map(async ([name, kind]) => ({
    bytes: await readFile(join(root, name + ".pdf")),
    name: name + ".pdf",
    mimeType: "application/pdf",
    kind,
    sourceId: "gs-" + name,
    provenance: {
      kind: "synthetic" as const,
      description: "Generated engineering fixture from frozen simulator facts",
      license: "Synthetic project fixture; no external supplier data",
      originalFilename: name + ".pdf",
    },
  })),
);
const supplier = VENDORS.find((v) => v.id === "golden-state-produce")!;
const intake = await combineUploads({
  uploads,
  storageRoot,
  idempotencyKey: "golden-state-packet-v1",
  context: {
    supplier: { supplierId: supplier.id, legalName: supplier.legalName },
    coding: {
      account: supplier.expenseAccount,
      store: "sf-hayes-valley",
      department: null,
      project: null,
      treatment: "expense",
    },
  },
  options: {
    ...(process.env.AP_OFFLINE === "1"
      ? {
          fetcher: async () => {
            throw new Error("offline_network_forbidden");
          },
        }
      : {}),
    ocr: {
      traineddataPath:
        process.env.AP_TESSDATA_ENG ??
        "/opt/homebrew/share/tessdata/eng.traineddata",
    },
  },
});
await writeFile(
  join(storageRoot, "intake.private.json"),
  JSON.stringify(intake, null, 2) + "\n",
  { mode: 0o600 },
);
const counts: Record<string, number> = {};
for (const e of intake.candidate?.evidence ?? intake.extraction.evidence)
  counts[e.grounding.method] = (counts[e.grounding.method] ?? 0) + 1;
const report = {
  extraction: intake.extraction.status,
  reasons: intake.extraction.reasons,
  totalCents: intake.candidate?.totalCents ?? null,
  lineCount: intake.candidate?.lines.length ?? 0,
  grounding: counts,
  sources: intake.documents.map((s) => ({
    sourceId: s.sourceId,
    sha256: s.sha256,
    pageStatus: s.pageStatus,
    jobId: s.parser?.jobId,
    requestedVersion: s.parser?.version,
    resolvedVersion: s.parser?.resolvedVersion,
  })),
  purchasingEvidence: intake.purchasingEvidence.map((p) => ({
    kind: p.kind,
    reference: p.reference,
    lineCount: p.lines.length,
  })),
  evidence: intake.candidate?.evidence.map((e) => ({
    fieldPath: e.fieldPath,
    rawValue: e.rawValue,
    status: e.grounding.status,
    method: e.grounding.method,
    reason: e.grounding.failureReason,
  })),
};
await writeFile(
  join(storageRoot, "parse-report.json"),
  JSON.stringify(report, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(report, null, 2));
if (!intake.candidate) process.exitCode = 1;
