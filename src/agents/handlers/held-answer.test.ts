import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { reviewHeld } from "./controller";
import type { SeatRuntime, Task } from "../runtime";

function fixture(answer?: "pay" | "reject") {
  const bill = { _id: "bill", vendor: "vendor", invoiceNumber: "42", totalCents: 10000, status: "held" };
  const asks: any[] = answer ? [{ _id: "ask", taskId: "task", to: "human_cfo", status: "answered", options: [{ id: "pay" }, { id: "reject" }], answer: { optionId: answer, by: "human-cfo", at: 1000, note: "Verified receipt" } }] : [];
  const query = vi.fn(async (ref: any) => getFunctionName(ref) === "ap:bill" ? bill : asks);
  const mutation = vi.fn(async () => ({ ok: true }));
  const rt = {
    runId: "run", seat: { seatId: "controller" }, kernel: { auth: {}, client: { query, mutation } },
    ask: vi.fn(async () => ({ ok: true })), decide: vi.fn(async (_decision: unknown) => ({ path: "decisions/d.yaml", memorySha: "sha" })),
    vendor: vi.fn(async () => undefined), commit: vi.fn(),
  };
  const task = { _id: "task", payload: { billId: "bill", recommendedCents: 8000, exceptions: [{ code: "no_receiving_record", detail: "missing receipt", deltaCents: 0 }, { code: "open_credit", detail: "credit", deltaCents: -2000, ref: "CM-1" }] } };
  return { rt, task, asks, bill, run: () => reviewHeld(rt as unknown as SeatRuntime, task as unknown as Task) };
}

describe("held bill human answers", () => {
  it.each(["pay", "reject"] as const)("consumes %s without asking again", async (answer) => {
    const f = fixture(answer);
    const result = await f.run();
    expect(f.rt.ask).not.toHaveBeenCalled();
    expect(f.rt.kernel.client.mutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      billId: "bill", decision: answer === "pay" ? "approve" : "reject", approvedCents: answer === "pay" ? 10000 : undefined,
    }));
    expect(result.waiting).not.toBe(true);
    expect(result.outcome).toBe(answer === "pay" ? "approved" : "rejected");
    expect(f.rt.decide.mock.calls[0]?.[0]).toMatchObject({ facts: expect.arrayContaining([expect.objectContaining({ key: "human_answer" })]) });
    expect(f.rt.commit).not.toHaveBeenCalled();
  });
  it("waits for a valid human answer", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ outcome: "asked", waiting: true });
    expect(f.rt.kernel.client.mutation).not.toHaveBeenCalled();
  });
  it.each(["open", "wrong recipient", "invalid option"])("does not resolve from an %s ask", async (kind) => {
    const f = fixture("pay");
    if (kind === "open") f.asks[0].status = "open";
    if (kind === "wrong recipient") f.asks[0].to = "ap_clerk";
    if (kind === "invalid option") f.asks[0].answer.optionId = "ack";
    expect(await f.run()).toMatchObject({ waiting: true });
    expect(f.rt.kernel.client.mutation).not.toHaveBeenCalled();
  });
  it("does not repeat resolution after the bill was already resolved", async () => {
    const f = fixture("pay"); f.bill.status = "approved";
    expect(await f.run()).toMatchObject({ outcome: "noop" });
    expect(f.rt.kernel.client.mutation).not.toHaveBeenCalled();
    expect(f.rt.ask).not.toHaveBeenCalled();
  });
});
