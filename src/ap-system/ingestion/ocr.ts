import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { SourceDocument, CoordinateFrame, Processor } from "../contracts";
import {
  readArtifact,
  saveArtifact,
  canonical,
  sha256,
  inside,
} from "./storage";
import type { GroundingData, Word } from "./grounding";
const exec = promisify(execFile);
async function run(
  binary: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
  kind: "render" | "ocr" = "render",
) {
  try {
    return await exec(binary, args, options);
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { killed?: boolean };
    throw new Error(
      e.code === "ENOENT"
        ? `${kind}_dependency_unavailable`
        : e.killed
          ? `${kind}_process_timeout`
          : `${kind}_process_failed`,
    );
  }
}
function pdfBoxIdentity(
  text: string,
  page: number,
  width: number,
  height: number,
) {
  const box = (kind: string) =>
    new RegExp(
      `Page\\s+${page}\\s+${kind}:\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)`,
      "i",
    )
      .exec(text)
      ?.slice(1)
      .map(Number);
  const media = box("MediaBox"),
    crop = box("CropBox");
  return Boolean(
    media &&
    crop &&
    [media, crop].every((b) =>
      b.every((n, i) => Math.abs(n - [0, 0, width, height][i]!) < 0.1),
    ),
  );
}
function boundedRaster(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width * 2 > 10000 ||
    height * 2 > 10000 ||
    width * height * 4 > 40_000_000
  )
    throw new Error("render_pixel_budget_exceeded");
}

const imageHelper = fileURLToPath(
  new URL("./runtime/image-pages.py", import.meta.url),
);
export async function inspectImage(
  bytes: Uint8Array,
  storageRoot: string,
  options: OcrOptions = {},
) {
  const artifact = await saveArtifact(storageRoot, bytes, "image");
  const { stdout } = await run(
    process.env.AP_PYTHON ?? "python3",
    [imageHelper, "inspect", inside(storageRoot, artifact.ref)],
    { timeout: options.timeoutMs ?? 15000, maxBuffer: 1024 * 1024 },
  );
  return { ...JSON.parse(stdout), artifact } as {
    artifact: { ref: string; sha256: string };
    count: number;
    frames: {
      page: number;
      width: number;
      height: number;
      rotation: number;
      units: "pixel";
    }[];
  };
}
export const OCR_VERSION = "5.5.2";
export const TRAINEDDATA_SHA256 =
  "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2";
export type OcrOptions = {
  tesseractPath?: string;
  traineddataPath?: string;
  pdftoppmPath?: string;
  pdfinfoPath?: string;
  timeoutMs?: number;
  maxPages?: number;
};
export async function inspectPdf(
  bytes: Uint8Array,
  storageRoot: string,
  options: OcrOptions = {},
) {
  const artifact = await saveArtifact(storageRoot, bytes, "pdf");
  const file = inside(storageRoot, artifact.ref);
  const { stdout } = await run(
    options.pdfinfoPath ?? process.env.AP_PDFINFO ?? "pdfinfo",
    [file],
    { timeout: options.timeoutMs ?? 15000, maxBuffer: 1024 * 1024 },
  );
  const count = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]);
  if (!Number.isInteger(count) || count < 1 || count > (options.maxPages ?? 20))
    throw new Error("unsupported_pdf_page_count");
  const detail = await run(
    options.pdfinfoPath ?? process.env.AP_PDFINFO ?? "pdfinfo",
    ["-box", "-f", "1", "-l", String(count), file],
    { timeout: options.timeoutMs ?? 15000, maxBuffer: 1024 * 1024 },
  );
  const frames = Array.from({ length: count }, (_, i) => {
    const page = i + 1;
    const match = new RegExp(
      `Page\\s+${page}\\s+size:\\s+([\\d.]+) x ([\\d.]+)`,
      "i",
    ).exec(detail.stdout);
    const rot = new RegExp(`Page\\s+${page}\\s+rot:\\s+(-?\\d+)`, "i").exec(
      detail.stdout,
    );
    if (!match) throw new Error("pdf_frame_unavailable");
    return {
      page,
      width: Number(match[1]),
      height: Number(match[2]),
      rotation: pdfBoxIdentity(
        detail.stdout,
        page,
        Number(match[1]),
        Number(match[2]),
      )
        ? Number(rot?.[1] ?? 0)
        : -1,
    };
  });
  return { artifact, count, frames };
}
export async function renderPage({
  source,
  page,
  storageRoot,
  options = {},
}: {
  source: SourceDocument;
  page: number;
  storageRoot: string;
  options?: OcrOptions;
}): Promise<{
  bytes: Uint8Array;
  mimeType: "image/png";
  frame: CoordinateFrame;
  artifact: { ref: string; sha256: string };
}> {
  if (!Number.isInteger(page) || page < 1 || page > source.pageCount)
    throw new Error("invalid_page");
  const original = source.originalBase64
    ? Buffer.from(source.originalBase64, "base64")
    : await readArtifact(storageRoot, {
        ref: source.originalRef,
        sha256: source.sha256,
      });
  if (sha256(original) !== source.sha256)
    throw new Error("original_hash_mismatch");
  if (source.mimeType !== "application/pdf") {
    if (!["image/png", "image/jpeg", "image/tiff"].includes(source.mimeType))
      throw new Error("renderer_unsupported_mime");
    const info = await inspectImage(original, storageRoot, options);
    const image = info.frames[page - 1];
    if (!image || image.rotation !== 0)
      throw new Error("unsupported_source_rotation");
    const folder = join(storageRoot, "renders", source.sha256);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const output = join(folder, `page-${page}-${randomUUID()}.png`);
    await run(
      process.env.AP_PYTHON ?? "python3",
      [
        imageHelper,
        "render",
        inside(storageRoot, info.artifact.ref),
        String(page),
        output,
      ],
      { timeout: options.timeoutMs ?? 20000, maxBuffer: 1024 * 1024 },
    );
    const bytes = await readFile(output);
    return {
      bytes,
      mimeType: "image/png",
      frame: {
        width: image.width,
        height: image.height,
        units: "pixel",
        origin: "top_left",
        rotation: 0,
        transform: [1, 0, 0, 1, 0, 0],
      },
      artifact: await saveArtifact(storageRoot, bytes, "png"),
    };
  }
  const pdf = await saveArtifact(storageRoot, original, "pdf"),
    file = inside(storageRoot, pdf.ref);
  const { stdout } = await run(
    options.pdfinfoPath ?? process.env.AP_PDFINFO ?? "pdfinfo",
    ["-box", "-f", String(page), "-l", String(page), file],
    { timeout: options.timeoutMs ?? 15000, maxBuffer: 1024 * 1024 },
  );
  const size = /Page\s+(?:\d+\s+)?size:\s+([\d.]+) x ([\d.]+)/i.exec(stdout);
  const rotation = Number(
    /Page\s+(?:\d+\s+)?rot:\s+(-?\d+)/i.exec(stdout)?.[1] ?? 0,
  );
  if (!size) throw new Error("pdf_frame_unavailable");
  if (rotation !== 0) throw new Error("unsupported_source_rotation");
  const frame: CoordinateFrame = {
    width: Number(size[1]),
    height: Number(size[2]),
    units: "point",
    origin: "top_left",
    rotation: 0,
    transform: [1, 0, 0, 1, 0, 0],
  };
  if (!pdfBoxIdentity(stdout, page, frame.width, frame.height))
    throw new Error("unsupported_source_transform");
  boundedRaster(frame.width, frame.height);
  const folder = join(storageRoot, "renders", source.sha256);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const prefix = join(folder, `page-${page}-144dpi-${randomUUID()}`);
  await run(
    options.pdftoppmPath ?? process.env.AP_PDFTOPPM ?? "pdftoppm",
    [
      "-f",
      String(page),
      "-l",
      String(page),
      "-r",
      "144",
      "-singlefile",
      "-png",
      file,
      prefix,
    ],
    { timeout: options.timeoutMs ?? 20000, maxBuffer: 1024 * 1024 },
  );
  const bytes = await readFile(prefix + ".png");
  if (bytes.length > 24 * 1024 * 1024) throw new Error("render_too_large");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    Math.abs(width - frame.width * 2) > 1 ||
    Math.abs(height - frame.height * 2) > 1
  )
    throw new Error("raster_frame_mismatch");
  return {
    bytes,
    mimeType: "image/png",
    frame,
    artifact: await saveArtifact(storageRoot, bytes, "png"),
  };
}
export function parseTsv(
  tsv: string,
  page: number,
  scaleX: number,
  scaleY: number,
): Word[] {
  const rows = tsv.trim().split(/\r?\n/);
  const head = rows.shift()?.split("\t") ?? [];
  const idx = (s: string) => head.indexOf(s);
  if (idx("text") < 0) throw new Error("invalid_ocr_tsv");
  return rows.flatMap((line, i) => {
    const c = line.split("\t");
    if (c[idx("level")] !== "5" || !c[idx("text")]?.trim()) return [];
    const n = (k: string) => Number(c[idx(k)]);
    return [
      {
        id: `ocr:${page}:${i}`,
        text: c.slice(idx("text")).join("\t"),
        page,
        line: `${page}:${n("block_num")}:${n("par_num")}:${n("line_num")}`,
        box: {
          x: n("left") * scaleX,
          y: n("top") * scaleY,
          width: n("width") * scaleX,
          height: n("height") * scaleY,
        },
      },
    ];
  });
}
export async function localOcr(
  source: SourceDocument,
  storageRoot: string,
  options: OcrOptions = {},
): Promise<GroundingData> {
  const binary =
    options.tesseractPath ?? process.env.AP_TESSERACT ?? "tesseract";
  const traineddataPath =
    options.traineddataPath ?? process.env.AP_TESSDATA_ENG;
  if (!traineddataPath) throw new Error("ocr_traineddata_not_configured");
  const trained = await readFile(traineddataPath).catch(() => {
    throw new Error("ocr_traineddata_unavailable");
  });
  if (sha256(trained) !== TRAINEDDATA_SHA256)
    throw new Error("ocr_traineddata_version_mismatch");
  const version = await run(
    binary,
    ["--version"],
    { timeout: 5000, maxBuffer: 1024 * 1024 },
    "ocr",
  );
  if (
    !new RegExp(`tesseract ${OCR_VERSION.replaceAll(".", "\\.")}\\b`).test(
      version.stdout + version.stderr,
    )
  )
    throw new Error("ocr_engine_version_mismatch");
  if (source.pageCount > (options.maxPages ?? 8))
    throw new Error("ocr_page_budget_exceeded");
  const config = {
    engine: "tesseract",
    version: OCR_VERSION,
    language: "eng",
    psm: 6,
    dpi: 144,
    timeoutMs: options.timeoutMs ?? 20000,
    maxPages: options.maxPages ?? 8,
    traineddataSha256: TRAINEDDATA_SHA256,
    rasterToOriginal:
      "x * originalWidth / rasterWidth; y * originalHeight / rasterHeight",
    source: {
      sourceId: source.sourceId,
      revision: source.revision,
      sha256: source.sha256,
    },
  };
  const configArtifact = await saveArtifact(storageRoot, canonical(config));
  const pages: GroundingData["pages"] = [],
    words: Word[] = [],
    rasters: unknown[] = [],
    raw: unknown[] = [];
  for (let page = 1; page <= source.pageCount; page++) {
    const rendered = await renderPage({ source, page, storageRoot, options });
    const raster = Buffer.from(rendered.bytes);
    const width = raster.readUInt32BE(16),
      height = raster.readUInt32BE(20);
    const { stdout } = await run(
      binary,
      [
        inside(storageRoot, rendered.artifact.ref),
        "stdout",
        "--tessdata-dir",
        traineddataPath.replace(/[/\\]eng\.traineddata$/, ""),
        "-l",
        "eng",
        "--psm",
        "6",
        "tsv",
      ],
      { timeout: options.timeoutMs ?? 20000, maxBuffer: 8 * 1024 * 1024 },
      "ocr",
    );
    words.push(
      ...parseTsv(
        stdout,
        page,
        rendered.frame.width / width,
        rendered.frame.height / height,
      ),
    );
    pages.push({
      number: page,
      frame: rendered.frame,
      complete: true,
      rotation: 0,
    });
    rasters.push({
      page,
      artifact: rendered.artifact,
      width,
      height,
      frame: rendered.frame,
    });
    raw.push({ page, tsv: stdout });
  }
  const tokenArtifact = await saveArtifact(
    storageRoot,
    canonical({
      source: {
        sourceId: source.sourceId,
        revision: source.revision,
        sha256: source.sha256,
      },
      words,
    }),
  );
  const processor: Processor = {
    provider: "tesseract",
    model: "eng",
    version: OCR_VERSION,
    resolvedVersion: OCR_VERSION,
    jobId: null,
    implementationVersion: "ap-local-ocr-v1",
    configHash: configArtifact.sha256,
    configArtifact,
    rawArtifact: await saveArtifact(storageRoot, canonical(raw)),
    tokenArtifact,
    rasterArtifact: await saveArtifact(storageRoot, canonical(rasters)),
    traineddata: {
      language: "eng",
      version: "tessdata-fast-87416418657359cb625c412a48b6e1d6d41c29bd",
      sha256: TRAINEDDATA_SHA256,
    },
  };
  return { pages, native: [], words, processor };
}
