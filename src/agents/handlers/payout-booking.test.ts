import { describe, expect, it, vi } from "vitest";
import { matchBankTxn } from "./cash";
import type { SeatRuntime, Task } from "../runtime";

const line = (adjustmentsCents: number) => {
  const grossCents = 100_000, commissionCents = 15_000, refundsCents = 400;
  return { store: "sg-001", grossCents, commissionCents, refundsCents, adjustmentsCents, netCents: grossCents - commissionCents - refundsCents + adjustmentsCents };
};

async function book(adjustmentsCents: number, notes: { store: string; adjustmentCents: number; reason: string }[] = []) {
  const lines = [line(adjustmentsCents), { ...line(0), store: "sg-002" }];
  const net = lines.reduce((s, l) => s + l.netCents, 0);
  const mutation = vi.fn(async (_ref: unknown, _args: { memo: string; lines: { account: string; debit: number; credit: number }[] }) => ({ ok: true }));
  const rt = {
    kernel: { auth: {}, client: { mutation } },
    event: vi.fn(async () => ({ payload: { account: "deposits", txnId: "dep-1", date: "2026-01-08", amountCents: net, description: "UBER EATS PAYOUT payout-1" } })),
    eventsOfType: vi.fn(async () => [{ payload: { reportId: "payout-1", lines, notes } }]),
    mem: { read: vi.fn(async () => ({ payoutToleranceCents: 500 })) },
  };
  const result = await matchBankTxn(rt as unknown as SeatRuntime, { payload: { eventId: "e" } } as unknown as Task);
  const args = mutation.mock.calls[0]![1];
  const amount = (account: string) => args.lines.filter((l) => l.account === account).reduce((s, l) => s + l.debit - l.credit, 0);
  return { result, args, net, cash: amount("1020"), commissions: amount("5410"), receivable: amount("1110") };
}

describe("delivery payout booking", () => {
  it("keeps an unexplained short payment in the platform receivable", async () => {
    const r = await book(-18_750);
    expect(r.result.outcome).toBe("posted");
    expect(r.cash).toBe(r.net);
    expect(r.commissions).toBe(2 * (15_000 + 400));
    expect(r.receivable).toBe(-(200_000 - 18_750));
    expect(r.args.memo).toContain("disputed");
  });

  it("expenses an itemized refund adjustment", async () => {
    const r = await book(-1_200, [{ store: "sg-001", adjustmentCents: -1_200, reason: "Customer refund" }]);
    expect(r.commissions).toBe(2 * (15_000 + 400) + 1_200);
    expect(r.receivable).toBe(-200_000);
    expect(r.args.memo).not.toContain("disputed");
  });

  it("expenses an immaterial unexplained adjustment within tolerance", async () => {
    const r = await book(-300);
    expect(r.commissions).toBe(2 * (15_000 + 400) + 300);
    expect(r.receivable).toBe(-200_000);
  });
});
