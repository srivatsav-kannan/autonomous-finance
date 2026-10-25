/** Exercises the same renderer used by the authenticated original-page route; no provider calls. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { renderPage } from "../../src/ap-system/ingestion/index";
import { sha256 } from "../../src/ap-system/ingestion/storage";
import type { APIntake } from "../../src/ap-system/contracts";
const root = resolve(
  process.env.AP_STORAGE_ROOT ?? "var/ap97-20261025-01a1722e-a",
);
const intake = JSON.parse(
  await readFile(process.argv[2] ?? join(root, "intake.private.json"), "utf8"),
) as APIntake;
const outputs = [];
await mkdir(join(root, "render-check"), { recursive: true, mode: 0o700 });
for (const s of intake.documents) {
  const source = { ...s, originalRef: "unavailable-after-backend-storage" };
  const rendered = await renderPage({ source, page: 1, storageRoot: root });
  const file = join(root, "render-check", source.sourceId + ".png");
  await writeFile(file, rendered.bytes, { mode: 0o600 });
  outputs.push({
    sourceId: source.sourceId,
    sourceSha256: source.sha256,
    rasterSha256: sha256(rendered.bytes),
    frame: rendered.frame,
    originalRehydratedFromBase64: true,
  });
}
let rotation = null;
if (process.argv[3]) {
  const bytes = await readFile(process.argv[3]);
  const source = {
    ...intake.documents[0]!,
    sha256: sha256(bytes),
    originalBase64: bytes.toString("base64"),
    byteLength: bytes.length,
  };
  try {
    await renderPage({ source, page: 1, storageRoot: root });
    throw new Error("rotation_was_not_rejected");
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "unsupported_source_rotation")
      throw e;
    rotation = "explicitly_rejected";
  }
}
const report = { providerCalls: 0, outputs, rotation };
await writeFile(
  join(root, "render-check/report.json"),
  JSON.stringify(report, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(report, null, 2));
