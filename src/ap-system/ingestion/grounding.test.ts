import { describe, it, expect } from "vitest";
import {
  groundText,
  uniqueExactWords,
  providerGrounding,
  type GroundingData,
  type Word,
} from "./grounding";
import {
  groundingSchema,
  frameSchema,
  sourceDocumentSchema,
  intakeSchema,
} from "../contracts";
const h = "a".repeat(64);
const processor = {
  provider: "test",
  model: null,
  version: "test-v1",
  configHash: h,
  jobId: null,
  resolvedVersion: "test-v1",
  implementationVersion: "test-v1",
  configArtifact: { ref: "config", sha256: h },
  rawArtifact: { ref: "raw", sha256: h },
  tokenArtifact: { ref: "words", sha256: h },
  rasterArtifact: null,
  traineddata: null,
};
const frame = {
  width: 612,
  height: 792,
  units: "point" as const,
  origin: "top_left" as const,
  rotation: 0 as const,
  transform: [1, 0, 0, 1, 0, 0] as [
    number,
    number,
    number,
    number,
    number,
    number,
  ],
};
function words(text: string, page = 1): Word[] {
  return text
    .split(" ")
    .map((text, i) => ({
      id: `w${page}-${i}`,
      text,
      page,
      line: "one",
      box: { x: 10 + i * 20, y: 20, width: 18, height: 10 },
    }));
}
const data = (text = "Organic Kale"): GroundingData => ({
  pages: [{ number: 1, frame, complete: true, rotation: 0 }],
  native: [],
  words: words(text),
  processor,
});
describe("exact grounding", () => {
  it("uses valid native geometry before fallbacks", async () => {
    const d = data();
    d.native = [
      {
        text: "Organic Kale",
        page: 1,
        regions: [
          {
            x: 10,
            y: 20,
            width: 100,
            height: 12,
            granularity: "cell",
            tokenRefs: [],
          },
        ],
      },
    ];
    expect(
      (
        await groundText("Organic Kale", d, {
          localOcr: () => {
            throw Error("must_not_call");
          },
        })
      ).status,
    ).toBe("native");
  });
  it("derives raw-word geometry with source token IDs", async () => {
    const g = await groundText("Organic Kale", data());
    expect(g.method).toBe("raw_word_exact");
    expect(g.regions[0]?.tokenRefs).toEqual(["w1-0", "w1-1"]);
  });
  it("rejects character correction and repeated exact text", () => {
    expect(uniqueExactWords("Organic Kale", words("0rganic Kale")).status).toBe(
      "missing",
    );
    expect(
      uniqueExactWords("Organic Kale", words("Organic Kale Organic Kale"))
        .status,
    ).toBe("ambiguous");
  });
  it("does not align across pages", () => {
    expect(
      uniqueExactWords("Organic Kale", [
        ...words("Organic", 1),
        ...words("Kale", 2),
      ]).status,
    ).toBe("missing");
  });
  it("falls back to attributed local OCR", async () => {
    const g = await groundText("Organic Kale", data("0rganic Kale"), {
      localOcr: async () => ({
        ...data(),
        processor: { ...processor, provider: "tesseract" },
      }),
    });
    expect(g.method).toBe("local_ocr_exact");
    expect(g.processor.provider).toBe("tesseract");
  });
  it("preserves explicit failed/unavailable OCR reason", async () => {
    const g = await groundText("Absent text", data(), {
      localOcr: async () => {
        throw Error("ocr_dependency_unavailable");
      },
    });
    expect(g.status).toBe("unresolved");
    expect(g.failureReason).toBe("ocr_dependency_unavailable");
    expect(g.regions).toHaveLength(0);
    expect(g.contextRegions[0]?.granularity).toBe("page");
  });
  it("keeps multiline matches in separate regions", async () => {
    const d = data("Organic Kale Fresh Produce");
    d.words.slice(2).forEach((w, i) => {
      w.box.y = 40;
      w.box.x = 10 + i * 20;
    });
    expect(
      (await groundText("Organic Kale Fresh Produce", d)).regions,
    ).toHaveLength(2);
  });
  it("aligns each provider line uniquely even when an adjacent amount interrupts reading order", async () => {
    const d = data("Organic Kale $10.00 Fresh Produce");
    d.words.slice(3).forEach((w, i) => {
      w.box.y = 40;
      w.box.x = 10 + i * 20;
    });
    const g = await groundText("Organic Kale<br/>Fresh Produce", d);
    expect(g.method).toBe("raw_word_exact");
    expect(g.regions).toHaveLength(2);
    expect(g.regions.flatMap((r) => r.tokenRefs)).not.toContain("w1-2");
    d.words.push(
      ...d.words
        .slice(3)
        .map((w) => ({ ...w, id: w.id + "copy", box: { ...w.box, y: 60 } })),
    );
    expect(
      (await groundText("Organic Kale\nFresh Produce", d)).failureReason,
    ).toBe("ambiguous_exact_text");
  });
  it("rejects multiline alignment in reverse source order", () => {
    const d = data("Organic Kale Fresh Produce");
    d.words.slice(2).forEach((w, i) => {
      w.box.y = 40;
      w.box.x = 10 + i * 20;
    });
    expect(
      uniqueExactWords("Fresh Produce\nOrganic Kale", d.words).status,
    ).toBe("missing");
  });
  it("rejects rotated and invalid-frame grounding", async () => {
    const d = data();
    d.pages[0]!.rotation = 90;
    expect((await groundText("Organic Kale", d)).status).toBe("unresolved");
    d.pages[0]!.rotation = 0;
    d.words[0]!.box.width = 1000;
    expect((await groundText("Organic Kale", d)).status).toBe("unresolved");
  });
  it("does not accept coarse rectangles as precise native geometry", async () => {
    const g = await groundText("Organic Kale", data());
    expect(
      groundingSchema.safeParse({
        ...g,
        status: "native",
        method: "native",
        regions: [{ ...g.regions[0], granularity: "table" }],
      }).success,
    ).toBe(false);
    expect(
      frameSchema.safeParse({ ...frame, transform: [0, 0, 0, 0, 0, 0] })
        .success,
    ).toBe(false);
  });
  it("requires explicit source revision and complete page coverage", () => {
    const source = {
      sourceId: "s",
      revision: 1,
      sha256: h,
      deliveryId: "d",
      name: "x.pdf",
      kind: "invoice",
      mimeType: "application/pdf",
      originalRef: "x",
      byteLength: 5,
      extractedText: "",
      provenance: {
        kind: "synthetic",
        description: "test",
        license: "test",
        originalFilename: "x.pdf",
      },
      replaces: null,
      pageCount: 2,
      pageStatus: [{ page: 1, status: "complete", reason: null }],
      parser: null,
    };
    expect(sourceDocumentSchema.safeParse(source).success).toBe(false);
    const valid = { ...source, pageCount: 1 };
    const evidence = {
      evidenceId: "e",
      source: { sourceId: "s", revision: 2, sha256: h },
      fieldPath: "invoiceNumber",
      rawValue: "x",
      normalizedValue: "x",
      contentStatus: "supported",
      quote: "x",
      grounding: {
        status: "unresolved",
        method: "none",
        page: 1,
        frame,
        regions: [],
        contextRegions: [],
        normalization:
          "html_decode+nfc+whitespace+casefold;no_character_substitution",
        processor,
        failureReason: "test",
        elementPath: null,
      },
    };
    expect(
      intakeSchema.safeParse({
        contractVersion: "ap-evidence-v1",
        idempotencyKey: "x",
        documents: [valid],
        candidate: null,
        extraction: {
          status: "incomplete",
          evidence: [evidence],
          reasons: ["missing"],
        },
        purchasingEvidence: [],
        explicitRevisionOf: null,
      }).success,
    ).toBe(false);
  });
});

describe('multiline native table cells',()=>{
  const text='Wrapped<br/>description';
  const make=(cell:any)=>providerGrounding({result:{items:{pages:[{page_number:1,page_width:612,page_height:792,success:true}]}},grounded:[{page_number:1,page_width:612,page_height:792,success:true,items:[{rows:[[text]],grounding:{rows:[[cell]]}}]}],rawWords:[],processor,reused:true});
  const first={span:[0,7],bbox:{x:10,y:20,w:40,h:10}};
  const second={span:[12,23],bbox:{x:10,y:36,w:60,h:10}};
  it('prefers exact separate line regions over a broad enclosing cell box',async()=>{
    const g=await groundText('Wrapped\ndescription',make({bbox:{x:10,y:20,w:60,h:26},lines:[first,second]}));
    expect(g.status).toBe('native');expect(g.regions).toHaveLength(2);expect(g.regions.map(r=>r.height)).toEqual([10,10]);
  });
  it('does not use an enclosing cell box when line geometry is missing',async()=>{
    const g=await groundText('Wrapped\ndescription',make({bbox:{x:10,y:20,w:60,h:26}}));
    expect(g.status).toBe('unresolved');expect(g.regions).toEqual([]);
  });
  it('refuses incomplete or wrongly bound line spans',async()=>{
    const g=await groundText('Wrapped\ndescription',make({bbox:{x:10,y:20,w:60,h:26},lines:[first,{...second,span:[12,18]}]}));
    expect(g.status).toBe('unresolved');
  });
});
