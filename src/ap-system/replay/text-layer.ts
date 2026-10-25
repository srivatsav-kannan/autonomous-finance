/** Local, free PDF text-layer reader (poppler `pdftotext -bbox`). No provider or network access. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export type TextWord = { id: string; page: number; text: string; xMin: number; yMin: number; xMax: number; yMax: number };
export type TextPage = { page: number; width: number; height: number; words: TextWord[] };
export const TEXT_LAYER_IMPLEMENTATION = "apex-text-layer-v1";

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Parses the XHTML that `pdftotext -bbox` writes. Coordinates are PDF points, top-left origin. */
export function parseBboxXhtml(xhtml: string): TextPage[] {
  const pages: TextPage[] = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
  for (const p of xhtml.matchAll(pageRe)) {
    const page = pages.length + 1;
    const words: TextWord[] = [];
    for (const w of p[3]!.matchAll(wordRe))
      words.push({ id: `p${page}w${words.length + 1}`, page, text: decode(w[5]!), xMin: Number(w[1]), yMin: Number(w[2]), xMax: Number(w[3]), yMax: Number(w[4]) });
    pages.push({ page, width: Number(p[1]), height: Number(p[2]), words });
  }
  return pages;
}

export async function popplerVersion(pdftotextPath = "pdftotext") {
  const { stderr, stdout } = await run(pdftotextPath, ["-v"], { timeout: 10000 });
  const version = /pdftotext version ([\d.]+)/.exec(stderr + stdout)?.[1];
  if (!version) throw new Error("text_layer_version_unavailable");
  return version;
}

export async function readTextLayer(file: string, pdftotextPath = "pdftotext") {
  const { stdout } = await run(pdftotextPath, ["-bbox", "-enc", "UTF-8", file, "-"], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  return { xhtml: stdout, pages: parseBboxXhtml(stdout) };
}
