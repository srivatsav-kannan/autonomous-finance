import { beforeEach, describe, expect, it, vi } from "vitest";
import { ParsedInvoice } from "../../integrations/invoice";
import type { ParserRecord } from "../../integrations/parsers";
import { PIPE_SPEC } from "../../integrations/fixtures/parser-specs";
import { IntegrationParser } from "../../memory/schemas";
import { renderInvoice, type InvoiceDoc } from "../../world/documents";
import type { SeatRuntime, Task } from "../runtime";

const llm = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock("../llm", async (importOriginal) => ({ ...(await importOriginal<typeof import("../llm")>()), llmAvailable: () => true, extract: llm.extract }));

const { reviewProposal } = await import("./controller");
const { buildParser } = await import("./integrations");

const doc = (invoiceNumber: string, totalUnits = 2): InvoiceDoc => ({
  vendorName: "New Vendor", vendorEmail: "ar@new.example", invoiceNumber, invoiceDate: "2026-01-10", dueDate: "2026-02-09",
  storeId: "sf-hayes", storeName: "Hayes Valley",
  lines: [{ sku: "SKU-1", description: "Widget", quantity: totalUnits, unitCents: 500, amountCents: totalUnits * 500 }],
  totalCents: totalUnits * 500, remitBank: "Bank", remitLast4: "1234", termsNetDays: 30,
});
const parsed = (d: InvoiceDoc) => ParsedInvoice.parse({
  vendorName: d.vendorName, invoiceNumber: d.invoiceNumber, invoiceDate: d.invoiceDate, dueDate: d.dueDate, storeId: d.storeId,
  deliveryId: null, lines: d.lines, totalCents: d.totalCents, remitBank: d.remitBank, remitLast4: d.remitLast4, note: null,
});

function reviewFixture(rec: unknown) {
  const path = "integrations/parsers/parser-pipe.yaml";
  const mem = {
    proposalPaths: vi.fn(async () => ({ paths: [path], head: "head", base: "base", proposer: "integrations" })),
    read: vi.fn(async () => rec),
    rejectProposal: vi.fn(async () => undefined),
    merge: vi.fn(async () => ({ sha: "merged" })),
  };
  const rt = {
    runId: "run", seat: { seatId: "controller" }, author: { seatId: "controller", name: "Controller" }, mem,
    kernel: { auth: {}, client: { mutation: vi.fn(async () => ({ ok: true })) } },
    decide: vi.fn(async () => ({ path: "decisions/d.yaml" })),
  };
  const task = { _id: "task", payload: { proposalId: "p1" } };
  return { rt, mem, run: () => reviewProposal(rt as unknown as SeatRuntime, task as unknown as Task) };
}

const specRecord = (tests: ParserRecord["tests"], spec: unknown = PIPE_SPEC) =>
  ({ id: "parser-pipe", signature: "pipe", description: "pipe", spec, tests, author: "integrations" });

describe("controller review of parser proposals", () => {
  it("merges a spec that passes every stored test", async () => {
    const a = doc("A-1"), b = doc("B-2", 3);
    const f = reviewFixture(specRecord([{ input: renderInvoice(a, "pipe"), expected: parsed(a) }, { input: renderInvoice(b, "pipe"), expected: parsed(b) }]));
    expect(await f.run()).toMatchObject({ outcome: "merged" });
    expect(f.mem.merge).toHaveBeenCalled();
  });

  it("rejects a spec that fails any stored test, not only the first", async () => {
    const a = doc("A-1"), b = doc("B-2", 3);
    const f = reviewFixture(specRecord([{ input: renderInvoice(a, "pipe"), expected: parsed(a) }, { input: renderInvoice(b, "pipe"), expected: parsed(a) }]));
    expect(await f.run()).toMatchObject({ outcome: "rejected", summary: expect.stringContaining("test 2") });
    expect(f.mem.merge).not.toHaveBeenCalled();
  });

  it("rejects a test whose expected output fails the arithmetic check", async () => {
    const a = doc("A-1");
    const bad = renderInvoice({ ...a, totalCents: 1 }, "pipe");
    const f = reviewFixture(specRecord([{ input: bad, expected: { ...parsed(a), totalCents: 1 } }]));
    expect(await f.run()).toMatchObject({ outcome: "rejected", summary: expect.stringContaining("lines sum") });
  });

  it("rejects an unsafe spec without running it", async () => {
    const spec = structuredClone(PIPE_SPEC);
    spec.fields.vendorName = { pattern: "^(a+)+$", flags: "m", group: 1, as: "text", optional: false };
    const a = doc("A-1");
    const f = reviewFixture(specRecord([{ input: renderInvoice(a, "pipe"), expected: parsed(a) }], spec));
    expect(await f.run()).toMatchObject({ outcome: "rejected" });
  });

  it("rejects a legacy JavaScript parser proposal without executing it", async () => {
    const f = reviewFixture({ id: "parser-pipe", signature: "pipe", description: "js", author: "integrations",
      code: "globalThis.__reviewRan = true; return {};", tests: [{ input: "H|x", expected: {} }] });
    expect(await f.run()).toMatchObject({ outcome: "rejected", summary: expect.stringContaining("no longer executed") });
    expect((globalThis as Record<string, unknown>).__reviewRan).toBeUndefined();
  });
});

describe("memory schema for parser records", () => {
  it("accepts specs and refuses JavaScript code", () => {
    const a = doc("A-1");
    expect(IntegrationParser.safeParse(specRecord([{ input: renderInvoice(a, "pipe"), expected: parsed(a) }])).success).toBe(true);
    expect(IntegrationParser.safeParse({ id: "x", signature: "pipe", description: "js", author: "i", code: "return {}", tests: [{ input: "", expected: {} }] }).success).toBe(false);
  });
});

describe("integrations engineer writes a parser spec", () => {
  beforeEach(() => llm.extract.mockReset());

  function buildFixture() {
    const a = doc("A-1");
    const rt = {
      seat: { seatId: "integrations" }, usage: {},
      propose: vi.fn(async () => ({ branch: "proposal/parser-pipe", sha: "sha" })),
      decide: vi.fn(async () => ({ path: "d" })), handoff: vi.fn(async () => ({ ok: true })), ask: vi.fn(),
    };
    const task = { _id: "task", payload: { signature: "pipe", sample: renderInvoice(a, "pipe"), expected: parsed(a), sampleEventId: "ev" } };
    return { rt, run: () => buildParser(rt as unknown as SeatRuntime, task as unknown as Task) };
  }

  it("proposes a validated spec, never code, and asks the model for JSON", async () => {
    llm.extract.mockResolvedValueOnce({ description: "pipe-delimited", spec: PIPE_SPEC });
    const f = buildFixture();
    expect(await f.run()).toMatchObject({ outcome: "proposed" });
    const changes = (f.rt.propose.mock.calls[0] as unknown as [string, { data: Record<string, unknown> }[]])[1];
    expect(changes[0]!.data).toMatchObject({ spec: PIPE_SPEC });
    expect(changes[0]!.data).not.toHaveProperty("code");
    const system = (llm.extract.mock.calls[0]![0] as { system: string }).system;
    expect(system).toMatch(/JSON parser spec/);
    expect(system).not.toMatch(/function parse/);
  });

  it("feeds an unsafe or failing spec back to the model and retries", async () => {
    const unsafe = structuredClone(PIPE_SPEC);
    unsafe.fields.vendorName = { pattern: "^(a+)+$", flags: "m", group: 1, as: "text", optional: false };
    llm.extract.mockResolvedValueOnce({ description: "bad", spec: unsafe }).mockResolvedValueOnce({ description: "good", spec: PIPE_SPEC });
    const f = buildFixture();
    expect(await f.run()).toMatchObject({ outcome: "proposed", summary: expect.stringContaining("2 attempt") });
    expect((llm.extract.mock.calls[1]![0] as { input: string }).input).toMatch(/previous attempt failed/);
  });
});
