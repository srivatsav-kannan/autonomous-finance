import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE_CAPABILITIES } from "../core/roles";
import { cap, PIPE_SPEC } from "../integrations/fixtures/parser-specs";
import { compileParser, parseWith, type ParserRecord } from "../integrations/parsers";
import { renderInvoice } from "../world/documents";
import { MemoryStore } from "../memory/store";
import { SeatRuntime } from "./runtime";

const text = renderInvoice({
  vendorName: "Test Vendor", vendorEmail: "ar@test.example", invoiceNumber: "INV-1", invoiceDate: "2026-01-10", dueDate: "2026-02-09",
  storeId: "test-store", storeName: "Test", lines: [{ sku: "TEST", description: "Test", quantity: 1, unitCents: 100, amountCents: 100 }],
  totalCents: 100, remitBank: "Bank", remitLast4: "1234", termsNetDays: 30,
}, "pipe");
const author = { seatId: "integrations", name: "Integrations" };
const approver = { seatId: "controller", name: "Controller" };

/** Two versions of the same parser differ only in what they read into `note`. */
function parserRecord(note: string | null): ParserRecord {
  const spec = structuredClone(PIPE_SPEC);
  spec.fields.note = note ? cap(`^T\\|\\d+\\|(${note})\\|`) : null;
  const invoice = parseWith([compileParser({ id: "probe", signature: "pipe", description: "", spec, tests: [], author: "" } as never)], text);
  if (!invoice.ok) throw new Error(invoice.reason);
  return { id: "test-parser", signature: "pipe", description: "Test parser", spec, tests: [{ input: text, expected: invoice.invoice }], author: author.seatId };
}

describe("approved parser cache", () => {
  let dir: string;
  let mem: MemoryStore;
  let runtime: SeatRuntime;

  beforeEach(async () => {
    vi.stubEnv("CONVEX_URL", "http://127.0.0.1:3210");
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "parser-cache-"));
    mem = new MemoryStore(path.join(dir, "memory.git"));
    await mem.init();
    runtime = new SeatRuntime("test", { seatId: "ap", role: "ap_clerk", name: "AP" }, "test", mem);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function propose(id: string, note: string | null) {
    await mem.propose({
      id, author, message: "Add test parser",
      changes: [{ path: "integrations/parsers/test-parser.yaml", data: parserRecord(note) }],
    });
  }

  async function merge(id: string) {
    await mem.merge({ id, approver, caps: ROLE_CAPABILITIES.controller, note: "Approved" });
  }

  it("activates a parser after approval without a restart or explicit refresh", async () => {
    const initial = await runtime.parsersNow();
    expect(parseWith(initial, text).ok).toBe(false);
    await propose("first", null);
    expect(await runtime.parsersNow()).toBe(initial);
    expect(parseWith(await runtime.parsersNow(), text).ok).toBe(false);

    await merge("first");
    expect(parseWith(await runtime.parsersNow(), text)).toMatchObject({
      ok: true, parser: "test-parser", origin: "memory", invoice: { invoiceNumber: "INV-1", note: null },
    });
  });

  it("loads one approved snapshot when main advances between listing and reading", async () => {
    await propose("first", null);
    await merge("first");
    const list = mem.list.bind(mem);
    vi.spyOn(mem, "list").mockImplementationOnce(async (prefix, ref) => {
      const files = await list(prefix, ref);
      await propose("second", "USD");
      await merge("second");
      return files;
    });

    expect(parseWith(await runtime.parsersNow(), text)).toMatchObject({ ok: true, invoice: { note: null } });
    expect(parseWith(await runtime.parsersNow(), text)).toMatchObject({ ok: true, invoice: { note: "USD" } });
  });
});
