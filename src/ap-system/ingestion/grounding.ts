import type {
  Grounding,
  Processor,
  CoordinateFrame,
  EvidenceRegion,
} from "../contracts";
import { groundingSchema } from "../contracts";
import type { Json, ProviderOutput } from "./provider";
export const NORMALIZATION =
  "html_decode+nfc+whitespace+casefold;no_character_substitution" as const;
export function decode(text: string) {
  return text
    .replace(/<\/?(?:b|strong|em|i)>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}
export const normalize = (text: string) =>
  decode(text).normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
export type Word = {
  id: string;
  text: string;
  page: number;
  line: string;
  box: { x: number; y: number; width: number; height: number };
};
export type NativeRegion = {
  text: string;
  page: number;
  regions: EvidenceRegion[];
};
export type Page = {
  number: number;
  frame: CoordinateFrame;
  complete: boolean;
  rotation: number;
  nativeValid?: boolean;
  rawValid?: boolean;
  providerScale?: { x: number; y: number };
};
export type GroundingData = {
  pages: Page[];
  native: NativeRegion[];
  words: Word[];
  processor: Processor;
};
const box = (b: Json): Word["box"] => ({
  x: b.x,
  y: b.y,
  width: b.w ?? b.width,
  height: b.h ?? b.height,
});
export function validBox(b: Word["box"], frame: CoordinateFrame) {
  return (
    [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
    b.x >= 0 &&
    b.y >= 0 &&
    b.width > 0 &&
    b.height > 0 &&
    b.x + b.width <= frame.width + 0.01 &&
    b.y + b.height <= frame.height + 0.01
  );
}
function span(md: string, s: unknown) {
  if (!Array.isArray(s) || s.length !== 2) return "";
  return Buffer.from(md, "utf8")
    .subarray(Number(s[0]), Number(s[1]))
    .toString("utf8");
}
/** Multiline cells retain actual per-line boxes; never collapse their intervening whitespace. */
export function cellNativeRegions(text: string, cell: Json): EvidenceRegion[] | undefined {
  const lines: Json[] = Array.isArray(cell.lines) ? cell.lines : [];
  const multiline = decode(text).split(/\r?\n/).filter(s => s.trim()).length > 1 || lines.length > 1;
  const completeLines = lines.length > 0 && lines.every((line, index) => {
    const prior = lines[index - 1];
    return line.bbox && Array.isArray(line.span) && line.span.length === 2 &&
      line.span.every(Number.isInteger) && line.span[0] >= 0 &&
      line.span[1] > line.span[0] && line.span[1] <= Buffer.byteLength(text) &&
      (!prior || line.span[0] >= prior.span[1] &&
        line.bbox.y >= prior.bbox.y + prior.bbox.h - 0.01);
  }) && normalize(lines.map(line => span(text, line.span)).join(" ")) === normalize(text);
  if (multiline || !cell.bbox) {
    if (!completeLines || multiline && lines.length < 2) return undefined;
    return lines.map(line => ({...box(line.bbox), granularity: "line", tokenRefs: []}));
  }
  return (Array.isArray(cell.bbox) ? cell.bbox : [cell.bbox]).map((b: Json) => ({...box(b), granularity: "cell", tokenRefs: []}));
}
export function providerGrounding(output: ProviderOutput): GroundingData {
  const rawPages: Json[] = output.result.items?.pages ?? [];
  const coverageValid =
    output.result.__apPageCoverageValid !== false &&
    rawPages.every((p, i) => p.page_number === i + 1) &&
    (!output.result.__apOriginalFrames ||
      output.result.__apOriginalFrames.length === rawPages.length);
  const pages: Page[] = rawPages
    .filter(
      (p) =>
        Number.isInteger(p.page_number) &&
        p.page_number > 0 &&
        Number.isFinite(p.page_width) &&
        p.page_width > 0 &&
        Number.isFinite(p.page_height) &&
        p.page_height > 0,
    )
    .map((p) => ({
      number: p.page_number,
      frame: {
        width: p.page_width,
        height: p.page_height,
        units: "point",
        origin: "top_left",
        rotation: 0,
        transform: [1, 0, 0, 1, 0, 0],
      },
      complete: p.success === true && coverageValid,
      rotation: (() => {
        const original = output.result.__apOriginalFrames?.find(
          (f: Json) => f.page === p.page_number,
        );
        if (
          original &&
          (original.units === "pixel"
            ? Math.abs(
                original.width / original.height - p.page_width / p.page_height,
              ) > 0.001
            : Math.abs(original.width - p.page_width) > 0.1 ||
              Math.abs(original.height - p.page_height) > 0.1)
        )
          return -1;
        return (
          original?.rotation ??
          output.result.metadata?.pages?.find(
            (m: Json) => m.page_number === p.page_number,
          )?.original_orientation_angle ??
          0
        );
      })(),
    }));
  for (const p of pages) {
    const validArtifact = (records: Json[], native: boolean) => {
      const found = records.filter((r) => r.page_number === p.number);
      return (
        found.length === 1 &&
        (!native || found[0]!.success === true) &&
        Math.abs(found[0]!.page_width - p.frame.width) < 0.1 &&
        Math.abs(found[0]!.page_height - p.frame.height) < 0.1
      );
    };
    p.nativeValid = validArtifact(output.grounded, true);
    p.rawValid = validArtifact(output.rawWords, false);
    const original = output.result.__apOriginalFrames?.find(
      (f: Json) => f.page === p.number,
    );
    if (original?.units === "pixel") {
      p.providerScale = {
        x: original.width / p.frame.width,
        y: original.height / p.frame.height,
      };
      p.frame = {
        ...p.frame,
        width: original.width,
        height: original.height,
        units: "pixel",
      };
    }
  }
  const native: NativeRegion[] = [];
  for (const page of output.grounded) {
    for (const [ii, item] of (page.items ?? []).entries()) {
      const md = String(item.md ?? item.value ?? "");
      for (const [li, line] of (item.grounding?.lines ?? []).entries()) {
        // A word-only region is bound to the UTF-8 word span, never its whole parent paragraph.
        for (const [wi, word] of (line.words ?? []).entries())
          if (word.bbox)
            native.push({
              text: span(md, word.span),
              page: page.page_number,
              regions: [
                {
                  ...box(word.bbox),
                  granularity: "word",
                  tokenRefs: [`native:${page.page_number}:${ii}:${li}:${wi}`],
                },
              ],
            });
        if (line.bbox)
          native.push({
            text: span(md, line.span),
            page: page.page_number,
            regions: [
              { ...box(line.bbox), granularity: "line", tokenRefs: [] },
            ],
          });
      }
      for (const [ri, row] of (item.rows ?? []).entries())
        for (const [ci, text] of row.entries()) {
          const cell = item.grounding?.rows?.[ri]?.[ci];
          if (!cell) continue;
          const regions = cellNativeRegions(String(text), cell);
          if (regions) native.push({text: String(text), page: page.page_number, regions});
        }
    }
  }
  const words: Word[] = [];
  for (const page of output.rawWords)
    for (const [i, w] of (page.raw_words ?? []).entries())
      words.push({
        id: `raw:${page.page_number}:${i}`,
        text: String(w.str ?? w.text ?? ""),
        page: page.page_number,
        line: `raw:${page.page_number}:${Math.round(w.y / (w.h || 1))}`,
        box: box(w),
      });
  for (const n of native) {
    const scale = pages.find((p) => p.number === n.page)?.providerScale;
    if (scale)
      n.regions = n.regions.map((r) => ({
        ...r,
        x: r.x * scale.x,
        y: r.y * scale.y,
        width: r.width * scale.x,
        height: r.height * scale.y,
      }));
  }
  for (const w of words) {
    const scale = pages.find((p) => p.number === w.page)?.providerScale;
    if (scale)
      w.box = {
        x: w.box.x * scale.x,
        y: w.box.y * scale.y,
        width: w.box.width * scale.x,
        height: w.box.height * scale.y,
      };
  }
  return { pages, native, words, processor: output.processor };
}
export function uniqueExactWords(
  query: string,
  words: Word[],
  page?: number,
): { status: "unique"; words: Word[] } | { status: "missing" | "ambiguous" } {
  // Provider line breaks are source structure, not permission to bridge unrelated OCR cells.
  const logicalLines = decode(query)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (logicalLines.length > 1) {
    const selected: Word[][] = [];
    for (const line of logicalLines) {
      const match = uniqueExactWords(line, words, page);
      if (match.status !== "unique") return match;
      selected.push(match.words);
    }
    const used = new Set<string>();
    let priorBottom = -Infinity;
    const firstPage = selected[0]![0]!.page;
    for (const line of selected) {
      const top = Math.min(...line.map((w) => w.box.y)),
        bottom = Math.max(...line.map((w) => w.box.y + w.box.height));
      const unique = [...new Map(line.map((w) => [w.id, w])).values()];
      if (
        line.some((w) => w.page !== firstPage) ||
        unique.some((w) => used.has(w.id)) ||
        top < priorBottom ||
        bottom - top > Math.max(...line.map((w) => w.box.height)) * 1.6
      )
        return { status: "missing" };
      unique.forEach((w) => used.add(w.id));
      priorBottom = bottom;
    }
    return { status: "unique", words: selected.flat() };
  }
  const q = normalize(query).split(" ").filter(Boolean);
  if (!q.length) return { status: "missing" };
  const matches: Word[][] = [];
  // Expand whitespace-bearing OCR tokens without changing characters; each fragment keeps the source token ID.
  const tokens = words
    .filter((w) => page === undefined || w.page === page)
    .flatMap((w) =>
      normalize(w.text)
        .split(" ")
        .filter(Boolean)
        .map((text) => ({ ...w, text })),
    );
  for (let i = 0; i <= tokens.length - q.length; i++) {
    const window = tokens.slice(i, i + q.length);
    if (window.every((w, j) => w.text === q[j] && w.page === window[0]!.page))
      matches.push(window);
  }
  if (matches.length !== 1)
    return { status: matches.length ? "ambiguous" : "missing" };
  return { status: "unique", words: matches[0]! };
}
function regionsFor(words: Word[]): EvidenceRegion[] {
  const lines: Word[][] = [];
  for (const w of words) {
    const last = lines.at(-1);
    const prev = last?.at(-1);
    if (
      prev &&
      w.page === prev.page &&
      Math.abs(w.box.y - prev.box.y) <=
        Math.max(w.box.height, prev.box.height) * 0.55 &&
      w.box.x >= prev.box.x
    )
      last!.push(w);
    else lines.push([w]);
  }
  return lines.map((ws) => {
    const x = Math.min(...ws.map((w) => w.box.x)),
      y = Math.min(...ws.map((w) => w.box.y));
    return {
      x,
      y,
      width: Math.max(...ws.map((w) => w.box.x + w.box.width)) - x,
      height: Math.max(...ws.map((w) => w.box.y + w.box.height)) - y,
      granularity: "line",
      tokenRefs: [...new Set(ws.map((w) => w.id))],
    };
  });
}
export async function groundText(
  query: string,
  data: GroundingData,
  opts: {
    page?: number;
    nativeHint?: NativeRegion;
    localOcr?: () => Promise<GroundingData>;
  } = {},
): Promise<Grounding> {
  const base = {
    normalization: NORMALIZATION,
    processor: data.processor,
    elementPath: null,
  };
  const wanted = normalize(query);
  const hint = opts.nativeHint;
  const scale = hint
    ? data.pages.find((p) => p.number === hint.page)?.providerScale
    : undefined;
  const scaledHint =
    hint && scale
      ? {
          ...hint,
          regions: hint.regions.map((r) => ({
            ...r,
            x: r.x * scale.x,
            y: r.y * scale.y,
            width: r.width * scale.x,
            height: r.height * scale.y,
          })),
        }
      : hint;
  const native = (scaledHint ? [scaledHint] : data.native).filter(
    (n) =>
      normalize(n.text) === wanted &&
      (opts.page === undefined || n.page === opts.page),
  );
  const uniqueNative = [
    ...new Map(
      native.map((n) => [
        JSON.stringify([
          n.page,
          n.regions.map((r) => [r.x, r.y, r.width, r.height]),
        ]),
        n,
      ]),
    ).values(),
  ];
  if (uniqueNative.length === 1) {
    const n = uniqueNative[0]!,
      p = data.pages.find((p) => p.number === n.page);
    if (
      p &&
      p.complete &&
      p.nativeValid !== false &&
      p.rotation === 0 &&
      n.regions.every((r) => validBox(r, p.frame))
    )
      return groundingSchema.parse({
        ...base,
        status: "native",
        method: "native",
        page: n.page,
        frame: p.frame,
        regions: n.regions,
        contextRegions: [],
        failureReason: null,
      });
  }
  const raw = uniqueExactWords(query, data.words, opts.page);
  if (raw.status === "unique") {
    const p = data.pages.find((p) => p.number === raw.words[0]!.page);
    if (
      p &&
      p.complete &&
      p.rawValid !== false &&
      p.rotation === 0 &&
      raw.words.every((w) => validBox(w.box, p.frame))
    )
      return groundingSchema.parse({
        ...base,
        status: "derived",
        method: "raw_word_exact",
        page: p.number,
        frame: p.frame,
        regions: regionsFor(raw.words),
        contextRegions: [],
        failureReason: null,
      });
  }
  let reason =
    raw.status === "ambiguous" ? "ambiguous_exact_text" : "missing_exact_text";
  if (
    data.pages.some(
      (p) =>
        (opts.page === undefined || p.number === opts.page) && p.rotation !== 0,
    )
  )
    reason = data.pages.some((p) => p.rotation === -1)
      ? "unsupported_source_transform"
      : "unsupported_source_rotation";
  if (opts.localOcr && !reason.startsWith("unsupported_source_"))
    try {
      const local = await opts.localOcr(),
        matched = uniqueExactWords(query, local.words, opts.page);
      if (matched.status === "unique") {
        const p = local.pages.find((p) => p.number === matched.words[0]!.page);
        if (
          p &&
          p.complete &&
          p.rotation === 0 &&
          matched.words.every((w) => validBox(w.box, p.frame))
        )
          return groundingSchema.parse({
            ...base,
            processor: local.processor,
            status: "derived",
            method: "local_ocr_exact",
            page: p.number,
            frame: p.frame,
            regions: regionsFor(matched.words),
            contextRegions: [],
            failureReason: null,
          });
      }
      reason = `local_ocr_${matched.status}`;
    } catch (e) {
      reason =
        e instanceof Error &&
        /^(ocr_|local_ocr_|unsupported_|render_|raster_|original_)[a-z_]+$/.test(
          e.message,
        )
          ? e.message
          : "local_ocr_execution_failed";
    }
  const p =
    data.pages.find((p) => p.number === opts.page) ??
    (data.pages.length === 1 ? data.pages[0] : undefined);
  return groundingSchema.parse({
    ...base,
    status: "unresolved",
    method: "none",
    page: p?.number ?? null,
    frame: p?.frame ?? null,
    regions: [],
    contextRegions: p
      ? [
          {
            x: 0,
            y: 0,
            width: p.frame.width,
            height: p.frame.height,
            granularity: "page",
            tokenRefs: [],
          },
        ]
      : [],
    failureReason: reason,
  });
}
