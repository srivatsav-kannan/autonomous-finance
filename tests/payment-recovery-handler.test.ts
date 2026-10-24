import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { Doc } from "../convex/_generated/dataModel";
import { recoverPayments } from "../src/agents/handlers/payments";
import type { SeatRuntime, Task } from "../src/agents/runtime";

const intent = (id = "intent-1") => ({
  _id: id, status: "submitted", payee: "vendor", amountCents: 5000,
  remitTo: { bank: "Original Bank", accountLast4: "4321", memorySha: "approved-sha" },
}) as Doc<"paymentIntents">;
const command = (id = "intent-1", sentOn: string | undefined = "2026-01-10") => ({
  intentId: id, payee: "vendor", amountCents: 5000, bank: "Original Bank", accountLast4: "4321", sentOn,
});

function runtime(intents = [intent()]) {
  const execute = vi.fn(async (id: string): Promise<any> => ({ ok: true, status: "submitted", command: command(id) }));
  const settle = vi.fn(async (_args: unknown) => ({ ok: true }));
  const get = vi.fn((_id: string): any => undefined);
  const send = vi.fn((request: ReturnType<typeof command>) => ({ ...request, bankRef: "ACH-existing" }));
  const vendor = vi.fn(async () => { throw new Error("submitted payments must not read changing vendor memory"); });
  const rt = {
    runId: "fixture", vendor, note: vi.fn(), bank: { get, send },
    kernel: {
      auth: { runId: "fixture", seatId: "payments", token: "test" },
      client: {
        query: vi.fn(async () => intents),
        mutation: vi.fn(async (ref, args) => {
          switch (getFunctionName(ref)) {
            case "payments:executePayment": return execute(args.intentId);
            case "payments:settlePayment": return settle(args);
            default: throw new Error(`unexpected mutation ${getFunctionName(ref)}`);
          }
        }),
      },
    },
  } as unknown as SeatRuntime;
  return { rt, execute, settle, get, send, vendor, recover: () => recoverPayments(rt, {} as Task) };
}

describe("submitted-payment recovery guards", () => {
  it("stops before bank access if another worker has already settled", async () => {
    const f = runtime();
    f.execute.mockResolvedValue({ ok: true, status: "settled", replayed: true });
    await f.recover();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.settle).not.toHaveBeenCalled();
  });

  it("does not interpret unavailable receipt lookup as permission to send", async () => {
    const f = runtime();
    f.get.mockImplementation(() => { throw new Error("receipt storage unavailable"); });
    await expect(f.recover()).rejects.toThrow("receipt storage unavailable");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.settle).not.toHaveBeenCalled();
  });

  it("refuses a receipt for a different destination", async () => {
    const f = runtime();
    f.get.mockReturnValue({ ...command(), accountLast4: "9999", bankRef: "ACH-existing" });
    await expect(f.recover()).rejects.toThrow("receipt conflicts");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.settle).not.toHaveBeenCalled();
  });

  it("recovers a legacy submitted intent from its original receipt", async () => {
    const f = runtime();
    f.execute.mockResolvedValue({ ok: true, status: "submitted", command: { ...command(), sentOn: undefined } });
    f.get.mockReturnValue({ ...command(), sentOn: "2026-01-03", bankRef: "ACH-legacy" });
    await f.recover();
    expect(f.vendor).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ bankRef: "ACH-legacy", settledOn: "2026-01-03" }));
  });

  it("requires manual review for a legacy intent without a receipt or frozen date", async () => {
    const f = runtime();
    f.execute.mockResolvedValue({ ok: true, status: "submitted", command: { ...command(), sentOn: undefined } });
    await expect(f.recover()).rejects.toThrow("manual review required");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.settle).not.toHaveBeenCalled();
  });

  it("uses the kernel dispatch command rather than the earlier query snapshot", async () => {
    const stale = { ...intent(), amountCents: 9999, remitTo: { bank: "Stale Bank", accountLast4: "0000", memorySha: "old" } };
    const f = runtime([stale]);
    await f.recover();
    expect(f.send).toHaveBeenCalledWith(command());
    expect(f.vendor).not.toHaveBeenCalled();
    expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ settledOn: "2026-01-10" }));
  });

  it("recovers unrelated intents even when one receipt lookup fails", async () => {
    const f = runtime([intent("bad"), intent("good")]);
    f.get.mockImplementation((id) => { if (id === "bad") throw new Error("bad receipt"); return undefined; });
    await expect(f.recover()).rejects.toThrow("bad receipt");
    expect(f.send).toHaveBeenCalledExactlyOnceWith(command("good"));
    expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ intentId: "good" }));
  });
});
