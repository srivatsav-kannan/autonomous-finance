/** Evaluation-only format harness. Expected profiles never enter runtime parser inputs. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseUpload, renderPage } from "../../src/ap-system/ingestion";
import { sha256 } from "../../src/ap-system/ingestion/storage";
import type { APIntake, CoordinateFrame } from "../../src/ap-system/contracts";
const fixture = resolve("fixtures/ap-system/formats-v1");
const storageRoot = resolve(
  process.env.AP_STORAGE_ROOT ?? "var/ap97-20261025-01a1722e-a3",
);
const live = process.argv.includes("--live");
const manifest = JSON.parse(
  await readFile(join(fixture, "manifest.json"), "utf8"),
);
const expected = JSON.parse(
  await readFile(join(fixture, manifest.expectedResultsFile), "utf8"),
).profiles;
await mkdir(join(storageRoot, "intakes"), { recursive: true, mode: 0o700 });
let providerUploads = 0,
  providerReads = 0;
const fetcher: typeof fetch = async (url, init) => {
  if (!live) throw Error("offline_network_forbidden");
  if (init?.method === "POST") providerUploads++;
  else providerReads++;
  return fetch(url, init);
};
const results: any[] = [];
for (const s of manifest.sources) {
  console.log(JSON.stringify({ source: s.id, status: "starting", live }));
  const profile = expected[s.id];
  let intake: APIntake | undefined;
  try {
    const bytes = await readFile(resolve(fixture, s.path));
    if (sha256(bytes) !== s.sha256) throw Error("fixture_hash_changed");
    const isXml = s.mimeType.includes("xml");
    intake = await parseUpload({
      bytes,
      name: s.path.split("/").at(-1),
      mimeType: s.mimeType,
      sourceId: "formats-" + s.id,
      storageRoot,
      idempotencyKey: "formats-v1-" + s.id,
      provenance: {
        kind: "synthetic",
        description: s.description,
        license: manifest.license,
        originalFilename: s.path.split("/").at(-1),
      },
      context: {
        supplier: isXml
          ? {
              supplierId: "format-test-supplies",
              legalName: "Format Test Supplies LLC",
            }
          : {
              supplierId: "golden-state-produce",
              legalName: "Golden State Produce Co.",
            },
        coding: {
          account: "5000",
          store: "synthetic-format-store",
          department: null,
          project: null,
          treatment: "expense",
        },
      },
      options: {
        fetcher,
        ocr: {
          traineddataPath:
            process.env.AP_TESSDATA_ENG ??
            "/opt/homebrew/share/tessdata/eng.traineddata",
        },
      },
    });
    const previous = await readFile(
      join(storageRoot, "intakes", s.id + ".private.json"),
    ).catch(() => null);
    const intakeBytes = JSON.stringify(intake, null, 2) + "\n";
    const replayByteMatch =
      !live && previous !== null
        ? sha256(previous) === sha256(intakeBytes)
        : null;
    await writeFile(
      join(storageRoot, "intakes", s.id + ".private.json"),
      JSON.stringify(intake, null, 2) + "\n",
      { mode: 0o600 },
    );
    const source = intake.documents[0]!,
      candidate = intake.candidate,
      fields: Record<string, boolean> = {
        candidatePresence: Boolean(candidate) === profile.candidate,
        pageCount: source.pageCount === profile.pages,
      };
    if (profile.candidate) {
      fields.completePages = source.pageStatus.every(
        (p) => p.status === "complete",
      );
      for (const k of [
        "invoiceNumber",
        "totalCents",
        "subtotalCents",
        "taxCents",
      ] as const)
        if (profile[k] !== undefined) fields[k] = candidate?.[k] === profile[k];
      fields.lineCount = candidate?.lines.length === profile.lineCount;
      fields.quantities =
        JSON.stringify(candidate?.lines.map((l) => l.quantity.decimal)) ===
        JSON.stringify(profile.quantities);
      if (profile.lineTaxes)
        fields.lineTaxes =
          JSON.stringify(candidate?.lines.map((l) => l.taxCents)) ===
          JSON.stringify(profile.lineTaxes);
      if (profile.allocations)
        fields.allocations =
          JSON.stringify(
            candidate?.lines.map((l) => l.allocations[0]?.amountCents),
          ) === JSON.stringify(profile.allocations);
    }
    if (profile.orderedPageMarkers) {
      let prior = -1;
      fields.orderedPageMarkers = profile.orderedPageMarkers.every(
        (marker: string) => {
          const index = source.extractedText.indexOf(marker);
          const valid = index > prior;
          prior = index;
          return valid;
        },
      );
    }
    const evidence = candidate?.evidence ?? intake.extraction.evidence,
      methods: Record<string, number> = {},
      statuses: Record<string, number> = {},
      failures: Record<string, number> = {};
    for (const e of evidence) {
      methods[e.grounding.method] = (methods[e.grounding.method] ?? 0) + 1;
      statuses[e.grounding.status] = (statuses[e.grounding.status] ?? 0) + 1;
      if (e.grounding.failureReason)
        failures[e.grounding.failureReason] =
          (failures[e.grounding.failureReason] ?? 0) + 1;
    }
    const frames: Array<{
      page: number;
      frame: CoordinateFrame;
      rasterSha256: string;
    }> = [];
    if (!isXml)
      for (let page = 1; page <= source.pageCount; page++) {
        const r = await renderPage({
          source: { ...source, originalRef: "not-available" },
          page,
          storageRoot,
        });
        frames.push({ page, frame: r.frame, rasterSha256: sha256(r.bytes) });
      }
    fields.frameBinding = evidence.every((e) =>
      e.grounding.method === "xml_path"
        ? e.grounding.frame === null &&
          e.grounding.page === null &&
          !e.grounding.regions.length
        : !e.grounding.frame ||
          frames.some(
            (f) =>
              f.page === e.grounding.page &&
              JSON.stringify(f.frame) === JSON.stringify(e.grounding.frame),
          ),
    );
    if (profile.geometry === "xml_path")
      fields.xmlPaths =
        evidence.length > 0 &&
        evidence.every(
          (e) => e.grounding.method === "xml_path" && e.grounding.elementPath,
        );
    const result = {
      id: s.id,
      replayByteMatch,
      sourceSha256: s.sha256,
      mimeType: s.mimeType,
      providerJobId: source.parser?.jobId ?? null,
      requestedVersion: source.parser?.version ?? null,
      resolvedVersion: source.parser?.resolvedVersion ?? null,
      extraction: intake.extraction.status,
      reasons: intake.extraction.reasons,
      fieldChecks: fields,
      passed: Object.values(fields).every(Boolean),
      candidateTotalCents: candidate?.totalCents ?? null,
      lineCount: candidate?.lines.length ?? 0,
      pageCount: source.pageCount,
      pageStatus: source.pageStatus,
      frames,
      geometry: { fieldCount: evidence.length, statuses, methods, failures },
      scope: s.description,
    };
    results.push(result);
    console.log(
      JSON.stringify({
        id: s.id,
        passed: result.passed,
        extraction: result.extraction,
        fields,
        geometry: result.geometry,
      }),
    );
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
        ? error.message
        : "format_check_failed";
    results.push({
      id: s.id,
      replayByteMatch: null,
      sourceSha256: s.sha256,
      mimeType: s.mimeType,
      passed: false,
      error: reason,
      extraction: intake?.extraction.status ?? "failed",
    });
    console.log(JSON.stringify({ id: s.id, passed: false, error: reason }));
  }
  await writeFile(
    join(storageRoot, "progress.json"),
    JSON.stringify({ providerUploads, providerReads, results }, null, 2) + "\n",
    { mode: 0o600 },
  );
}
const positives = results.filter((r) => expected[r.id].candidate),
  negatives = results.filter((r) => !expected[r.id].candidate);
const report = {
  task: "A3",
  specSha256:
    "b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565",
  sourceBaseline: "3b6baad02b012b1d850e3581b2d0092282367cee",
  contractVersion: "ap-evidence-v1",
  live,
  providerUploads,
  providerReads,
  expectedProfileSha256: sha256(
    await readFile(join(fixture, manifest.expectedResultsFile)),
  ),
  denominators: {
    allControls: results.length,
    positiveControls: positives.length,
    positivePassed: positives.filter((r) => r.passed).length,
    negativeControls: negatives.length,
    negativePassed: negatives.filter((r) => r.passed).length,
  },
  results,
  limits: [
    "Synthetic controlled formats, not a representative real-world accuracy benchmark",
    "Local component evidence; no UI/business/bank acceptance",
    "Docker image build remains NOT_RUN",
  ],
};
await writeFile(
  join(storageRoot, live ? "report.json" : "report-offline.json"),
  JSON.stringify(report, null, 2) + "\n",
  { mode: 0o600 },
);
if (live)
  await writeFile(
    "docs/ap-orchestration/evidence/A3-formats.json",
    JSON.stringify(report, null, 2) + "\n",
  );
else
  await writeFile(
    "docs/ap-orchestration/evidence/A3-replay.json",
    JSON.stringify(
      {
        liveReportSha256: sha256(
          await readFile("docs/ap-orchestration/evidence/A3-formats.json"),
        ),
        providerUploads,
        providerReads,
        denominators: report.denominators,
        byteIdenticalIntakes: results.map((r) => ({
          id: r.id,
          match: r.replayByteMatch,
        })),
        allPassed: results.every((r) => r.passed && r.replayByteMatch),
      },
      null,
      2,
    ) + "\n",
  );
console.log(
  JSON.stringify({
    providerUploads,
    providerReads,
    denominators: report.denominators,
  }),
);
if (results.some((r) => !r.passed)) process.exitCode = 1;
