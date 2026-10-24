import { describe, expect, it } from "vitest";
import { generateWorld, type WorldEvent } from "./generate";

interface PayoutReport {
  platform: string;
  periodStart: string;
  periodEnd: string;
  lines: {
    store: string;
    grossCents: number;
    commissionCents: number;
    refundsCents: number;
    adjustmentsCents: number;
    netCents: number;
  }[];
  netCents: number;
  notes: { store: string; adjustmentCents: number; reason: string }[];
}

function verifyPayouts(events: WorldEvent[]) {
  const sales = events.filter((event) => event.type === "sales.daily");
  const reports = events.filter((event) => event.type === "payout.report");
  let totalGross = 0;
  expect(reports).toHaveLength(4);
  for (const event of reports) {
    const report = event.payload as unknown as PayoutReport;
    for (const line of report.lines) {
      const grossFromSales = sales
        .filter((sale) => sale.payload.store === line.store && sale.occurredOn >= report.periodStart && sale.occurredOn <= report.periodEnd)
        .reduce((sum, sale) => sum + (sale.payload.marketplace as Record<string, number>)[report.platform]!, 0);
      expect(line.grossCents, `${event.externalId}/${line.store}`).toBe(grossFromSales);
      expect(line.netCents).toBe(line.grossCents - line.commissionCents - line.refundsCents + line.adjustmentsCents);
      totalGross += line.grossCents;
    }
    expect(report.netCents).toBe(report.lines.reduce((sum, line) => sum + line.netCents, 0));
    const deposit = events.find((candidate) => candidate.type === "bank.transaction" && candidate.externalId === `dep-${event.externalId}`);
    expect(deposit?.payload.amountCents).toBe(report.netCents);
  }
  return totalGross;
}

describe("weekly marketplace payouts", () => {
  it.each([1, 2, 7, 42, 99])("clears the exact daily platform receivables for clean seed %i", (seed) => {
    const world = generateWorld({ seed, storeCount: 3, start: "2026-01-01", days: 14, plantErrors: false });
    expect(verifyPayouts(world.events)).toBe(world.truth.revenueCents.marketplace);
    // Seed 1 previously generated 5,798,615 cents of payout gross from 5,798,613 cents of sales.
    if (seed === 1) expect(world.truth.revenueCents.marketplace).toBe(5_798_613);
  });

  it.each([1, 7])("preserves planted short payouts and explained refunds for seed %i", (seed) => {
    const world = generateWorld({ seed, storeCount: 3, start: "2026-01-01", days: 14, plantErrors: true });
    expect(verifyPayouts(world.events)).toBe(world.truth.revenueCents.marketplace);
    const short = world.events.find((event) => event.externalId === "payout-ubereats-sim-w1")!.payload as unknown as PayoutReport;
    const explained = world.events.find((event) => event.externalId === "payout-doordash-sim-w1")!.payload as unknown as PayoutReport;
    expect(short.lines.map((line) => line.adjustmentsCents)).toEqual([-18_750, 0, 0]);
    expect(short.notes).toEqual([]);
    expect(explained.lines.map((line) => line.adjustmentsCents)).toEqual([-1_200, 0, 0]);
    expect(explained.notes).toEqual([{ store: explained.lines[0]!.store, adjustmentCents: -1_200, reason: "Customer refund: missing item, order DD-77812" }]);
    expect(world.answerKey.errors.find((error) => error.type === "payout_short")).toMatchObject({
      subject: { ref: "payout-ubereats-sim-w1" }, amountAtRiskCents: 18_750,
    });
    expect(world.answerKey.decoys.find((decoy) => decoy.type === "explained_payout_adjustment")).toMatchObject({
      subject: { ref: "payout-doordash-sim-w1" }, expected: "accept",
    });
  });
});
