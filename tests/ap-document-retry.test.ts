import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc } from "../convex/_generated/dataModel";
import { processDocument } from "../src/agents/handlers/ap";
import { SeatRuntime, type Task } from "../src/agents/runtime";
import { MemoryStore } from "../src/memory/store";
import { seedFiles } from "../src/memory/seed";
import type { Decision, Vendor } from "../src/memory/schemas";
import type { WorldBank } from "../src/world/bank";
import type { ParsedInvoice } from "../src/integrations/invoice";

let dir: string;
let mem: MemoryStore;
let vendor: Vendor;
let storeId: string;
beforeEach(async () => {
  vi.stubEnv("CONVEX_URL", "https://test.convex.cloud");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-document-retry-"));
  mem = new MemoryStore(path.join(dir, "memory.git"));
  await mem.init();
  const seed = seedFiles(1).filter((f) => f.path === "vendors/golden-state-produce.yaml" || f.path.startsWith("stores/") || f.path.startsWith("policies/"));
  await mem.bootstrap(seed, { seatId: "system", name: "System" }, "Seed AP memory");
  vendor = (await mem.read<Vendor>("vendors/golden-state-produce.yaml"))!;
  storeId = seed.find((f) => f.path.startsWith("stores/"))!.path.slice(7, -5);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(mode: "approve" | "hold" | "reject") {
  const rt = new SeatRuntime("test", { seatId: "ap-1", role: "ap_clerk", name: "AP" }, "token", mem, {} as WorldBank);
  const item = vendor.contractPrices[0]!;
  const invoice: ParsedInvoice = {
    vendorName: vendor.legalName, invoiceNumber: "INV-42", invoiceDate: "2026-01-05", dueDate: "2026-02-05", storeId, deliveryId: null,
    lines: [{ sku: item.sku, description: item.description, quantity: 1, unitCents: item.unitCents, amountCents: item.unitCents }],
    totalCents: item.unitCents, remitBank: vendor.remitTo.bank, remitLast4: vendor.remitTo.accountLast4, note: null,
  };
  if (mode === "hold") {
    invoice.lines[0]!.unitCents += 1000;
    invoice.lines[0]!.amountCents += 1000;
    invoice.totalCents += 1000;
  }
  const bills: Doc<"bills">[] = [];
  if (mode === "reject") bills.push({ _id: "original-bill", vendor: vendor.id, invoiceNumber: "42", status: "approved", documentEventId: "another-document" } as Doc<"bills">);
  const task = { _id: "document-task", payload: { eventId: "source-document", externalId: "external-invoice" } } as Task;
  vi.spyOn(rt, "event").mockResolvedValue({ _id: "source-document", externalId: "external-invoice", payload: { kind: "invoice", from: vendor.contacts[0]!.email, text: "fixture invoice" } } as Doc<"events">);
  vi.spyOn(rt, "simDate").mockResolvedValue("2026-01-05");
  vi.spyOn(rt, "parsersNow").mockResolvedValue([{ id: "fixture", origin: "builtin", detect: () => true, parse: () => invoice }]);
  vi.spyOn(rt.kernel.client, "query").mockImplementation(async (...call) => {
    const [ref] = call;
    if (getFunctionName(ref) === "ap:bills") return structuredClone(bills);
    throw new Error(`unexpected query ${getFunctionName(ref)}`);
  });
  let failBillResponse = false;
  let handoffFailure: "before" | "after" | undefined;
  const handoffs = new Map<string, unknown>();
  let originalBillPayload: string | undefined;
  const mutation = vi.spyOn(rt.kernel.client, "mutation").mockImplementation(async (...call) => {
    const [ref, args] = call;
    switch (getFunctionName(ref)) {
      case "observe:recordCommit": return { ok: true };
      case "ap:recordBill": {
        // The transport double rejects changed requests, just like kernel idempotency.
        if (originalBillPayload) {
          if (JSON.stringify(args) !== originalBillPayload) return { ok: false, code: "idempotency_conflict", error: "retried recordBill with a recalculated payload" };
          return { ok: true, billId: "recorded-bill", replayed: true };
        }
        originalBillPayload = JSON.stringify(args);
        bills.push({ ...args, _id: "recorded-bill", invoiceNumber: "42", entryId: args.decision === "approve" ? "accrual" : undefined, status: args.decision === "approve" ? "approved" : args.decision === "hold" ? "held" : "rejected" } as Doc<"bills">);
        if (failBillResponse) { failBillResponse = false; throw new Error("bill response lost"); }
        return { ok: true, billId: "recorded-bill" };
      }
      case "tasks:createTask": {
        const fail = handoffFailure;
        handoffFailure = undefined;
        if (fail === "before") throw new Error("handoff unavailable");
        if (!handoffs.has(args.idempotencyKey)) handoffs.set(args.idempotencyKey, structuredClone(args));
        if (fail === "after") throw new Error("handoff response lost");
        return { ok: true, taskId: "review-task" };
      }
      default: throw new Error(`unexpected mutation ${getFunctionName(ref)}`);
    }
  });
  return { rt, task, bills, mutation, handoffs, run: () => processDocument(rt, task),
    loseBillResponse: () => { failBillResponse = true; }, failHandoff: (at: "before" | "after") => { handoffFailure = at; } };
}

describe("AP document retry after kernel acceptance", () => {
  it.each(["approve", "reject"] as const)("reuses a recorded %s decision after its response is lost", async (mode) => {
    const f = fixture(mode);
    f.loseBillResponse();
    await expect(f.run()).rejects.toThrow("bill response lost");
    const before = await mem.head();
    const recorded = structuredClone(f.bills.at(-1));
    const result = await f.run();
    expect(result.outcome).toBe(mode === "approve" ? "approved" : "rejected");
    expect(f.bills.at(-1)).toEqual(recorded);
    expect(await mem.head()).toBe(before);
    expect(f.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === "ap:recordBill")).toHaveLength(1);
  });

  it.each(["bill response", "handoff before", "handoff after"] as const)("recovers held review after losing %s", async (boundary) => {
    const f = fixture("hold");
    if (boundary === "bill response") f.loseBillResponse();
    else f.failHandoff(boundary === "handoff before" ? "before" : "after");
    await expect(f.run()).rejects.toThrow();
    const bill = f.bills[0]!;
    const expectedDecision = await mem.read<Decision>(bill.decisionPath!);
    // A later memory change must not alter the original review recommendation.
    await mem.update<Vendor>({ path: `vendors/${vendor.id}.yaml`, author: rtAuthor(), message: "Credit arrived after original hold", update: (current) => ({ ...current, credits: [{ id: "LATER", amountCents: 200, reason: "later credit", issuedOn: "2026-01-06" }] }) });
    const result = await f.run();
    expect(result.outcome).toBe("held");
    expect(f.handoffs.size).toBe(1);
    const handoff = [...f.handoffs.values()][0] as { payload: { billId: string; decisionPath: string; exceptions: unknown[]; recommendedCents: number } };
    expect(handoff.payload).toEqual({ billId: bill._id, decisionPath: bill.decisionPath, exceptions: [{ code: "price_over_contract", detail: expect.any(String), deltaCents: -1000 }], recommendedCents: vendor.contractPrices[0]!.unitCents });
    expect(await mem.read<Decision>(bill.decisionPath!)).toEqual(expectedDecision);
    expect(f.bills).toHaveLength(1);
    expect(f.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === "ap:recordBill")).toHaveLength(1);
  });

  it("fails explicitly for an old held bill without persisted review inputs", async () => {
    const f = fixture("hold");
    f.bills.push({ _id: "legacy-bill", vendor: vendor.id, invoiceNumber: "42", status: "held", documentEventId: "source-document", decisionPath: "decisions/2026-01/missing.yaml" } as Doc<"bills">);
    await expect(f.run()).rejects.toThrow(/cannot recover held bill.*review/i);
    expect(f.handoffs.size).toBe(0);
    expect(f.mutation).not.toHaveBeenCalled();
  });

  it("does not mistake an old orphan approved bill for a completed accrual", async () => {
    const f = fixture("approve");
    f.bills.push({ _id: "legacy-bill", vendor: vendor.id, invoiceNumber: "42", status: "approved", documentEventId: "source-document" } as Doc<"bills">);
    await expect(f.run()).rejects.toThrow(/approved bill has no accrual entry/);
    expect(f.mutation).not.toHaveBeenCalled();
  });
});
function rtAuthor() { return { seatId: "ap-2", name: "Another AP" }; }
