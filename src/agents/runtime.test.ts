import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE_CAPABILITIES } from "../core/roles";
import { parseWith, type ParserRecord } from "../integrations/parsers";
import { MemoryStore } from "../memory/store";
import { WorldBank } from "../world/bank";
import { SeatRuntime } from "./runtime";

const text = "H|test invoice";
const author = { seatId: "integrations", name: "Integrations" };
const approver = { seatId: "controller", name: "Controller" };

function parserRecord(invoiceNumber: string): ParserRecord {
  const invoice = {
    vendorName: "Test Vendor", invoiceNumber, invoiceDate: "2026-01-10", dueDate: null,
    storeId: "test-store", deliveryId: null,
    lines: [{ sku: "TEST", description: "Test", quantity: 1, unitCents: 100, amountCents: 100 }],
    totalCents: 100, remitBank: null, remitLast4: null, note: null,
  };
  return {
    id: "test-parser", signature: "pipe", description: "Test parser",
    code: `return ${JSON.stringify(invoice)};`, tests: [{ input: text, expected: invoice }], author: author.seatId,
  };
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
    runtime = new SeatRuntime("test", { seatId: "ap", role: "ap_clerk", name: "AP" }, "test", mem, new WorldBank("test"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function propose(id: string, invoiceNumber: string) {
    await mem.propose({
      id, author, message: "Add test parser",
      changes: [{ path: "integrations/parsers/test-parser.yaml", data: parserRecord(invoiceNumber) }],
    });
  }

  async function merge(id: string) {
    await mem.merge({ id, approver, caps: ROLE_CAPABILITIES.controller, note: "Approved" });
  }

  it("activates a parser after approval without a restart or explicit refresh", async () => {
    const initial = await runtime.parsersNow();
    expect(parseWith(initial, text).ok).toBe(false);
    await propose("first", "INV-1");
    expect(await runtime.parsersNow()).toBe(initial);
    expect(parseWith(await runtime.parsersNow(), text).ok).toBe(false);

    await merge("first");
    expect(parseWith(await runtime.parsersNow(), text)).toMatchObject({
      ok: true, parser: "test-parser", origin: "memory", invoice: { invoiceNumber: "INV-1" },
    });
  });

  it("loads one approved snapshot when main advances between listing and reading", async () => {
    await propose("first", "INV-1");
    await merge("first");
    const list = mem.list.bind(mem);
    vi.spyOn(mem, "list").mockImplementationOnce(async (prefix, ref) => {
      const files = await list(prefix, ref);
      await propose("second", "INV-2");
      await merge("second");
      return files;
    });

    expect(parseWith(await runtime.parsersNow(), text)).toMatchObject({ ok: true, invoice: { invoiceNumber: "INV-1" } });
    expect(parseWith(await runtime.parsersNow(), text)).toMatchObject({ ok: true, invoice: { invoiceNumber: "INV-2" } });
  });
});
