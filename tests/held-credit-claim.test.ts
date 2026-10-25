import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewHeld } from "../src/agents/handlers/controller";
import { SeatRuntime, type Task } from "../src/agents/runtime";
import { MemoryStore } from "../src/memory/store";
import type { Vendor } from "../src/memory/schemas";

const vendorPath = "vendors/test-produce.yaml";
const vendor: Vendor = {
  id: "test-produce", legalName: "Test Produce", category: "produce", expenseAccount: "5000", termsNetDays: 30, status: "active",
  remitTo: { bank: "Test Bank", accountLast4: "1234", verifiedOn: "2026-01-01", verifiedBy: "system", method: "onboarding" },
  contacts: [{ name: "Billing", email: "billing@test.example", phone: "555-0100", source: "onboarding" }],
  contractPrices: [], credits: [{ id: "CR-1", amountCents: 1_000, reason: "short shipment", issuedOn: "2026-01-01" }], notes: [],
};
const bills: Record<string, { _id: string; vendor: string; invoiceNumber: string; totalCents: number; status: string }> = {
  "bill-a": { _id: "bill-a", vendor: vendor.id, invoiceNumber: "A1", totalCents: 5_000, status: "held" },
  "bill-b": { _id: "bill-b", vendor: vendor.id, invoiceNumber: "B1", totalCents: 5_000, status: "held" },
};
// What AP hands the controller when both invoices arrive before either review: the same open credit.
const task = (billId: string) => ({
  _id: `review-${billId}`,
  payload: { billId, recommendedCents: 4_000, decisionPath: "decisions/2026-01/ap.yaml",
    exceptions: [{ code: "open_credit", detail: "open credit CR-1 ($10.00) not deducted on this invoice", deltaCents: -1_000, ref: "CR-1" }] },
}) as unknown as Task;

let dir: string;
let mem: MemoryStore;
const approved: { billId: string; approvedCents?: number }[] = [];
function runtime(store = mem) {
  const rt = new SeatRuntime("test", { seatId: "controller", role: "controller", name: "Controller" }, "token", store);
  vi.spyOn(rt.kernel.client, "query").mockImplementation((async (ref: unknown, args: { billId?: string }) =>
    getFunctionName(ref as never) === "ap:bill" ? bills[args.billId!] : []) as never);
  vi.spyOn(rt.kernel.client, "mutation").mockImplementation((async (ref: unknown, args: { billId: string; approvedCents?: number }) => {
    if (getFunctionName(ref as never) === "ap:resolveHeldBill") approved.push({ billId: args.billId, approvedCents: args.approvedCents });
    return { ok: true };
  }) as never);
  return rt;
}

beforeEach(async () => {
  vi.stubEnv("CONVEX_URL", "https://test.convex.cloud");
  approved.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-credit-"));
  mem = new MemoryStore(path.join(dir, "memory.git"));
  await mem.init();
  await mem.bootstrap([{ path: vendorPath, data: vendor }], { seatId: "system", name: "System" }, "Seed vendor");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("held bill credit deductions", () => {
  it("deducts one open credit once across sequential reviews", async () => {
    const rt = runtime();
    await reviewHeld(rt, task("bill-a"));
    await reviewHeld(rt, task("bill-b"));
    expect(approved).toEqual([{ billId: "bill-a", approvedCents: 4_000 }, { billId: "bill-b", approvedCents: 5_000 }]);
    expect((await mem.read<Vendor>(vendorPath))!.credits).toEqual([expect.objectContaining({ id: "CR-1", appliedTo: "A1" })]);
  });

  it("lets only one of two concurrent reviews claim the credit", async () => {
    const other = new MemoryStore(mem.dir);
    await Promise.all([reviewHeld(runtime(), task("bill-a")), reviewHeld(runtime(other), task("bill-b"))]);
    expect(approved.map((a) => a.approvedCents).sort()).toEqual([4_000, 5_000]);
    const winner = approved.find((a) => a.approvedCents === 4_000)!.billId;
    expect((await mem.read<Vendor>(vendorPath))!.credits[0]!.appliedTo).toBe(bills[winner]!.invoiceNumber);
  });

  it("keeps a claimed credit on retry after the bill update failed", async () => {
    const rt = runtime();
    const mutation = vi.mocked(rt.kernel.client.mutation);
    const real = mutation.getMockImplementation()!;
    mutation.mockImplementation((async (ref: unknown, args: never) => {
      if (getFunctionName(ref as never) === "ap:resolveHeldBill" && !approved.some((a) => a.billId === "lost")) {
        approved.push({ billId: "lost" });
        throw new Error("transport lost");
      }
      return real(ref as never, args);
    }) as never);
    await expect(reviewHeld(rt, task("bill-a"))).rejects.toThrow("transport lost");
    await reviewHeld(rt, task("bill-a"));
    expect(approved.filter((a) => a.billId === "bill-a")).toEqual([{ billId: "bill-a", approvedCents: 4_000 }]);
  });
});
