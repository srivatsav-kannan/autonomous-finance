import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processDocument } from "../src/agents/handlers/ap";
import { SeatRuntime, type Task } from "../src/agents/runtime";
import { MemoryStore } from "../src/memory/store";
import type { Vendor } from "../src/memory/schemas";
import type { WorldBank } from "../src/world/bank";

const vendorPath = "vendors/test-produce.yaml";
const vendor: Vendor = {
  id: "test-produce", legalName: "Test Produce", category: "produce", expenseAccount: "5000", termsNetDays: 30, status: "active",
  remitTo: { bank: "Test Bank", accountLast4: "1234", verifiedOn: "2026-01-01", verifiedBy: "system", method: "onboarding" },
  contacts: [{ name: "Billing", email: "billing@test.example", phone: "555-0100", source: "onboarding" }],
  contractPrices: [], credits: [], notes: [],
};
let dir: string;
let mem: MemoryStore;
function runtime(seatId: string, store = mem) {
  const rt = new SeatRuntime("test", { seatId, role: "ap_clerk", name: seatId }, "token", store, {} as WorldBank);
  vi.spyOn(rt.kernel.client, "mutation").mockResolvedValue({ ok: true });
  vi.spyOn(rt.kernel.client, "query").mockResolvedValue([]);
  vi.spyOn(rt, "simDate").mockResolvedValue("2026-01-05");
  return rt;
}
async function credit(rt: SeatRuntime, id: string) {
  vi.spyOn(rt, "event").mockResolvedValue({ payload: {
    kind: "credit_memo", from: "billing@test.example",
    text: `CREDIT MEMO ${id}\nCredit amount: $10.00\nReference invoice: INV-1\nReason: Short shipment`,
  } } as Awaited<ReturnType<SeatRuntime["event"]>>);
  return processDocument(rt, { _id: `task-${id}`, payload: { eventId: `event-${id}`, externalId: id } } as Task);
}

beforeEach(async () => {
  vi.stubEnv("CONVEX_URL", "https://test.convex.cloud");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-credit-"));
  mem = new MemoryStore(path.join(dir, "memory.git"));
  await mem.init();
  await mem.bootstrap([{ path: vendorPath, data: vendor }], { seatId: "system", name: "System" }, "Seed vendor");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("AP credit updates", () => {
  it.each(["credit", "decision"] as const)("recovers a credit memo after its %s mirror fails", async (boundary) => {
    const ap = runtime("ap-1");
    const mirror = vi.mocked(ap.kernel.client.mutation);
    if (boundary === "decision") mirror.mockResolvedValueOnce({ ok: true });
    mirror.mockRejectedValueOnce(new Error("mirror unavailable"));
    await expect(credit(ap, "CREDIT-A")).rejects.toThrow("mirror unavailable");
    const originalCreditPayload = mirror.mock.calls[0]![1];
    const originalDecisionPayload = boundary === "decision" ? mirror.mock.calls[1]![1] : undefined;
    expect((await credit(ap, "CREDIT-A")).outcome).toBe("duplicate");
    const retryStart = boundary === "decision" ? 2 : 1;
    expect(mirror.mock.calls[retryStart]![1]).toEqual(originalCreditPayload);
    if (originalDecisionPayload) expect(mirror.mock.calls[retryStart + 1]![1]).toEqual(originalDecisionPayload);
    expect((await mem.read<Vendor>(vendorPath))!.credits.map((c) => c.id)).toEqual(["CREDIT-A"]);
    expect(await mem.list("decisions/")).toHaveLength(1);
  });

  it("still rejects controlled and schema-invalid updates without changing memory", async () => {
    const ap = runtime("ap-1");
    const before = await mem.head();
    await expect(ap.updateVendor(vendor.id, (current) => ({ ...current, termsNetDays: 90 }), "Unapproved terms change"))
      .rejects.toMatchObject({ code: "controlled" });
    await expect(ap.updateVendor(vendor.id, (current) => ({ ...current, credits: [{ id: "BAD", amountCents: 0.5, reason: "invalid", issuedOn: "2026-01-05" }] }), "Fractional cent credit"))
      .rejects.toMatchObject({ code: "schema" });
    expect(await mem.head()).toBe(before);
    expect(ap.kernel.client.mutation).not.toHaveBeenCalled();
  });

  it("consumes a credit already short-paid on its reference invoice instead of leaving it open", async () => {
    const ap = runtime("ap-1");
    vi.mocked(ap.kernel.client.query).mockResolvedValue([{ invoiceNumber: "1", status: "approved", exceptions: ["short_shipment: KALE-24 invoiced 6, received 4"] }]);
    expect((await credit(ap, "CREDIT-A")).outcome).toBe("recorded");
    expect((await mem.read<Vendor>(vendorPath))!.credits).toEqual([expect.objectContaining({ id: "CREDIT-A", appliedTo: "1" })]);
  });

  it("leaves a credit open when its reference invoice was paid in full", async () => {
    const ap = runtime("ap-1");
    vi.mocked(ap.kernel.client.query).mockResolvedValue([{ invoiceNumber: "1", status: "approved", exceptions: [] }]);
    await credit(ap, "CREDIT-A");
    expect((await mem.read<Vendor>(vendorPath))!.credits[0]!.appliedTo).toBeUndefined();
  });

  it("keeps both credits when separate AP seats have warmed vendor caches", async () => {
    const first = runtime("ap-1");
    const second = runtime("ap-2");
    await Promise.all([first.vendors(), second.vendors()]);
    expect((await credit(first, "CREDIT-A")).outcome).toBe("recorded");
    expect((await credit(second, "CREDIT-B")).outcome).toBe("recorded");
    expect((await mem.read<Vendor>(vendorPath))!.credits.map((c) => c.id).sort()).toEqual(["CREDIT-A", "CREDIT-B"]);
  });

  it("preserves applied credit state, notes and approved master data added after the cache was filled", async () => {
    const existingCredit = { id: "CREDIT-A", amountCents: 1_000, reason: "short shipment", issuedOn: "2026-01-01" };
    await mem.write({ changes: [{ path: vendorPath, data: { ...vendor, credits: [existingCredit] } }], author: { seatId: "ap-1", name: "AP" }, message: "Initial credit" });
    const ap = runtime("ap-2");
    await ap.vendors();
    const latest = { ...vendor, credits: [{ ...existingCredit, appliedTo: "INV-1" }], notes: [{ on: "2026-01-05", by: "controller", text: "Dispute recorded" }], termsNetDays: 45 };
    // Bootstrap stands in for a reviewed master-data change between reads; it is real Git.
    await mem.bootstrap([{ path: vendorPath, data: latest }], { seatId: "controller", name: "Controller" }, "Approved vendor update");
    await credit(ap, "CREDIT-B");
    const saved = (await mem.read<Vendor>(vendorPath))!;
    expect(saved.credits[0]).toEqual(latest.credits[0]);
    expect(saved.notes).toEqual(latest.notes);
    expect(saved.termsNetDays).toBe(45);
    expect(saved.credits).toHaveLength(2);
  });

  it.each([false, true])("rebases concurrent credit appends after a forced CAS conflict (same memo: %s)", async (sameMemo) => {
    const other = new MemoryStore(mem.dir);
    const first = runtime("ap-1");
    const second = runtime("ap-2", other);
    await Promise.all([first.vendors(), second.vendors()]);
    let arrived = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => { release = resolve; });
    for (const store of [mem, other]) {
      const git = store.git.bind(store);
      let gated = false;
      vi.spyOn(store, "git").mockImplementation(async (args, opts) => {
        if (!gated && args[0] === "update-ref" && args[1] === "refs/heads/main") {
          gated = true;
          if (++arrived === 2) release();
          await bothReady;
        }
        return git(args, opts);
      });
    }
    await Promise.all([credit(first, "CREDIT-A"), credit(second, sameMemo ? "CREDIT-A" : "CREDIT-B")]);
    const saved = (await mem.read<Vendor>(vendorPath))!;
    expect(saved.credits.map((c) => c.id).sort()).toEqual(sameMemo ? ["CREDIT-A"] : ["CREDIT-A", "CREDIT-B"]);
  });
});
