import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { approvePayment } from "../src/agents/handlers/controller";
import { secondApproval } from "../src/agents/handlers/payments";
import { SeatRuntime, type Task } from "../src/agents/runtime";
import { api } from "../src/core/kernel-client";
import type { Role } from "../src/core/roles";
import { answer } from "../src/human/gateway";
import type { MemoryStore } from "../src/memory/store";
import { legacyKernel } from "./helpers/legacyKernel";

const remitTo = { bank: "Test Bank", accountLast4: "1234" };

async function fixture(amountCents: number, opts: { retireCfo?: boolean } = {}) {
  const k = legacyKernel();
  await k.init();
  const human = await k.seat("human-cfo", "human_cfo", "human");
  const payments = await k.seat("payments", "payments");
  await k.seat("controller", "controller");
  await k.seat("cfo-agent", "cfo_agent");
  if (opts.retireCfo) {
    const cfo = (await k.h.ctx.db.query("seats").withIndex("by_run_seat", (q) => q.eq("runId", k.runId).eq("seatId", "cfo-agent")).unique())!;
    await k.h.ctx.db.patch(cfo._id, { status: "retired" });
  }
  const billId = await k.h.seed("bills", {
    runId: k.runId, vendor: "vendor-1", invoiceNumber: "1", invoiceDate: "2026-01-02", dueDate: "2026-01-30", totalCents: amountCents,
    lines: [], documentEventId: "doc-1", status: "approved", exceptions: [], createdBy: "ap-clerk-1",
  });
  const runtime = (seatId: string, role: Role) => {
    const rt = new SeatRuntime(k.runId, { seatId, role, name: seatId }, `${seatId}-token`, {} as MemoryStore, k.client);
    rt.vendor = async () => ({ vendor: { id: "vendor-1", legalName: "Vendor 1", status: "active", remitTo: { ...remitTo, verifiedOn: "2026-01-01" } } as never, sha: "sha" });
    return rt;
  };
  const request = () => payments.client.mutation(api.payments.requestPayment, {
    ...payments.auth, idempotencyKey: `pay:${amountCents}`, payee: "vendor-1", amountCents, method: "ach",
    remitTo: { ...remitTo, memorySha: "v1" }, billIds: [billId], dueDate: "2026-01-30",
  });
  const tasks = (type: string) => k.h.all("tasks").filter((t) => t.type === type) as Task[];
  /** Run every queued task of a type with that role's handler, as the team loop would. */
  const drain = async () => {
    for (const t of tasks("payments.approve").filter((t) => t.status === "queued")) {
      const r = await approvePayment(runtime("controller", "controller"), t);
      await k.h.ctx.db.patch(t._id, { status: r.waiting ? "waiting" : "done" });
    }
    for (const t of tasks("payments.second_approval").filter((t) => t.status === "queued")) {
      await secondApproval(runtime("cfo-agent", "cfo_agent"), t);
      await k.h.ctx.db.patch(t._id, { status: "done" });
    }
  };
  const openAsks = () => k.h.all("asks").filter((a) => a.status === "open");
  const intent = (id: Id<"paymentIntents">) => k.h.ctx.db.get(id) as Promise<Doc<"paymentIntents">>;
  return { k, human, payments, request, drain, openAsks, intent, tasks };
}

async function requestAndRoute(f: Awaited<ReturnType<typeof fixture>>) {
  const r = await f.request();
  if (!r.ok) throw new Error(r.error);
  await f.payments.client.mutation(api.tasks.createTask, { ...f.payments.auth, type: "payments.approve", role: "controller", payload: { intentId: r.intentId }, idempotencyKey: `approve:${r.intentId}` });
  await f.drain();
  return r.intentId;
}

describe("legacy dual approval above the controller limit", () => {
  it.each([3_000_000, 5_000_000, 6_000_000])("reaches approved for %i cents with one human answer", async (amount) => {
    const f = await fixture(amount);
    const intentId = await requestAndRoute(f);
    const asks = f.openAsks();
    expect(asks).toHaveLength(1);
    await answer(f.human, f.k.runId, asks[0]!._id, "approve");
    await f.drain(); // the controller resumes after the answer and must not ask the same human again
    expect(f.openAsks()).toHaveLength(0);
    const final = await f.intent(intentId);
    expect(final.status).toBe("approved");
    expect(final.approvals.map((a) => a.seatId).sort()).toEqual(["cfo-agent", "human-cfo"]);
    expect(f.k.h.all("asks")).toHaveLength(1);
  });

  it("keeps the controller plus CFO agent path below the controller limit, with no human", async () => {
    const f = await fixture(1_500_000);
    const intentId = await requestAndRoute(f);
    expect(f.k.h.all("asks")).toHaveLength(0);
    expect((await f.intent(intentId)).approvals.map((a) => a.seatId).sort()).toEqual(["cfo-agent", "controller"]);
    expect((await f.intent(intentId)).status).toBe("approved");
  });

  it("allows CFO agent co-approval above its limit only where a human is also required", async () => {
    const f = await fixture(6_000_000);
    // A run whose human threshold is above the amount: two agents would have to cover 60,000.
    await f.k.h.ctx.db.patch((await f.k.h.ctx.db.query("runs").withIndex("by_runId", (q) => q.eq("runId", f.k.runId)).unique())!._id,
      { config: { policy: { humanApprovalCents: 10_000_000 } } });
    const r = await f.request();
    expect(r).toMatchObject({ ok: false, code: "unsatisfiable_approval" });
    expect(f.k.h.all("paymentIntents")).toHaveLength(0);
  });

  it("refuses a request no active seats can approve, before anyone is asked", async () => {
    const f = await fixture(3_000_000, { retireCfo: true });
    expect(await f.request()).toMatchObject({ ok: false, code: "unsatisfiable_approval" });
    expect(f.k.h.all("paymentIntents")).toHaveLength(0);
    expect(f.k.h.all("asks")).toHaveLength(0);
  });
});
