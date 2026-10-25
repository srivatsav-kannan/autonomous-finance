import { describe, expect, it } from "vitest";
import { renderInvoice, type InvoiceDoc } from "../world/documents";
import { ParsedInvoice } from "./invoice";
import { ParserSpec } from "./parser-spec";
import { NARRATIVE_SPEC, PIPE_SPEC, cap } from "./fixtures/parser-specs";
import type { MemoryStore } from "../memory/store";
import { compileParser, loadMemoryParsers, parseWith, LegacyParserRecord, type ParserRecord } from "./parsers";

const doc: InvoiceDoc = {
  vendorName: "Golden State Produce", vendorEmail: "ar@gsproduce.example", invoiceNumber: "GSP-1042",
  invoiceDate: "2026-01-10", dueDate: "2026-02-09", storeId: "sf-hayes", storeName: "Hayes Valley", deliveryId: "DLV-77",
  lines: [
    { sku: "KALE-24", description: "Kale, curly (24 ct)", quantity: 3, unitCents: 2_450, amountCents: 7_350 },
    { sku: "AVO-48", description: "Avocado, Hass", quantity: 2, unitCents: 6_125, amountCents: 12_250 },
  ],
  totalCents: 19_600, remitBank: "First Republic", remitLast4: "4421", termsNetDays: 30, note: "Balance forward: $0.00",
};

const expected = (over: Partial<ParsedInvoice> = {}): ParsedInvoice => ({
  vendorName: doc.vendorName, invoiceNumber: doc.invoiceNumber, invoiceDate: doc.invoiceDate, dueDate: doc.dueDate,
  storeId: doc.storeId, deliveryId: doc.deliveryId!, lines: doc.lines, totalCents: doc.totalCents,
  remitBank: doc.remitBank, remitLast4: doc.remitLast4, note: null, ...over,
});

const record = (signature: string, spec: unknown, tests: ParserRecord["tests"]): ParserRecord =>
  ({ id: `parser-${signature}`, signature, description: "test", spec, tests, author: "integrations" }) as ParserRecord;

describe("declarative parser specs", () => {
  it("cover the pipe layout that has no built-in parser", () => {
    const text = renderInvoice(doc, "pipe");
    const out = parseWith([compileParser(record("pipe", PIPE_SPEC, []))], text);
    expect(out).toEqual({ ok: true, invoice: expected(), parser: "parser-pipe", origin: "memory" });
  });

  it("map an empty optional capture to null", () => {
    const text = renderInvoice({ ...doc, deliveryId: undefined }, "pipe");
    const out = parseWith([compileParser(record("pipe", PIPE_SPEC, []))], text);
    expect(out).toMatchObject({ ok: true, invoice: { deliveryId: null } });
  });

  it("cover the narrative layout, including long dates, money and an optional note", () => {
    const text = renderInvoice(doc, "narrative");
    const out = parseWith([compileParser(record("narrative", NARRATIVE_SPEC, []))], text);
    expect(out).toEqual({ ok: true, invoice: expected({ note: "Balance forward: $0.00" }), parser: "parser-narrative", origin: "memory" });
  });

  it("still enforce the arithmetic check on spec output", () => {
    const text = renderInvoice({ ...doc, totalCents: 99_999 }, "pipe");
    const out = parseWith([compileParser(record("pipe", PIPE_SPEC, []))], text);
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("lines sum to 19600") });
  });

  it("still enforce the invoice schema on spec output", () => {
    const spec = structuredClone(PIPE_SPEC);
    spec.fields.invoiceDate = cap("^H\\|[^|]*\\|[^|]*\\|(\\d{8})\\|", "text"); // "20260110" is not YYYY-MM-DD
    const out = parseWith([compileParser(record("pipe", spec, []))], renderInvoice(doc, "pipe"));
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("parser-pipe failed") });
  });

  it("fail a required field whose pattern does not match", () => {
    const spec = structuredClone(PIPE_SPEC);
    spec.fields.storeId = cap("^STORE (\\S+)$");
    const out = parseWith([compileParser(record("pipe", spec, []))], renderInvoice(doc, "pipe"));
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("storeId") });
  });

  it.each([
    ["nested quantifier", "^(a+)+$"],
    ["quantified group with a quantifier inside", "^(?:[^|]*\\|){3}(\\d+)"],
    ["quantified alternation", "^(a|ab)*c"],
    ["backreference", "^(\\w+) \\1$"],
    ["named backreference", "^(?<w>\\w+) \\k<w>$"],
    ["invalid regex", "^(unclosed"],
    ["oversized pattern", `^${"a".repeat(600)}(b)`],
    ["empty pattern", ""],
  ])("reject a %s before anything runs", (_name, pattern) => {
    const spec = structuredClone(PIPE_SPEC);
    spec.fields.vendorName = cap(pattern);
    expect(ParserSpec.safeParse(spec).success).toBe(false);
    expect(() => compileParser(record("pipe", spec, []))).toThrow();
  });

  it.each(["g", "y", "s", "d", "v", "u", "mm"])("reject the %s regex flag", (flags) => {
    const spec = structuredClone(PIPE_SPEC);
    spec.fields.vendorName = { ...cap("^H\\|([^|]*)\\|"), flags } as never;
    expect(ParserSpec.safeParse(spec).success).toBe(false);
  });

  it("reject a capture group outside 1-9", () => {
    const spec = structuredClone(PIPE_SPEC);
    spec.fields.vendorName = { ...cap("^H\\|([^|]*)\\|"), group: 0 };
    expect(ParserSpec.safeParse(spec).success).toBe(false);
    spec.fields.vendorName = { ...cap("^H\\|([^|]*)\\|"), group: 10 };
    expect(ParserSpec.safeParse(spec).success).toBe(false);
  });

  it("reject extra keys such as code", () => {
    expect(ParserSpec.safeParse({ ...PIPE_SPEC, code: "return {}" }).success).toBe(false);
  });

  it("refuse oversized documents instead of scanning them", () => {
    const parser = compileParser(record("pipe", PIPE_SPEC, []));
    const text = `${renderInvoice(doc, "pipe")}\n${"x".repeat(200_000)}`;
    expect(parseWith([parser], text)).toMatchObject({ ok: false, reason: expect.stringContaining("too large") });
  });
});

describe("legacy JavaScript parser records", () => {
  const legacy = {
    id: "parser-pipe", signature: "pipe", description: "old", author: "integrations",
    code: "globalThis.__legacyParserRan = true; return {};", tests: [{ input: "H|x", expected: {} }],
  };

  it("are recognized but never executed", () => {
    expect(LegacyParserRecord.safeParse(legacy).success).toBe(true);
    expect(() => compileParser(legacy as unknown as ParserRecord)).toThrow(/no longer executed/);
    expect((globalThis as Record<string, unknown>).__legacyParserRan).toBeUndefined();
  });

  it("are skipped when memory loads, so the layout falls back to extraction and is re-learned", async () => {
    const text = renderInvoice(doc, "pipe");
    const current = record("narrative", NARRATIVE_SPEC, []);
    const files: Record<string, unknown> = { "integrations/parsers/parser-pipe.yaml": legacy, "integrations/parsers/parser-narrative.yaml": current };
    const mem = { head: async () => "sha", list: async () => Object.keys(files), read: async (f: string) => files[f] } as unknown as MemoryStore;
    const loaded = await loadMemoryParsers(mem);
    expect(loaded.map((p) => p.id)).toEqual(["parser-narrative"]);
    expect(parseWith(loaded, text)).toMatchObject({ ok: false, reason: "no parser recognizes this layout" });
    expect((globalThis as Record<string, unknown>).__legacyParserRan).toBeUndefined();
  });
});
