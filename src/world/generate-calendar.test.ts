import { describe, expect, it } from "vitest";
import { generateWorld } from "./generate";
import { addDays } from "./rng";
import { VENDORS } from "../../company/sweetgreen/profile";

const world = (start: string, days: number, plantErrors = true) =>
  generateWorld({ seed: 7, storeCount: 3, start, days, plantErrors });

describe("simulation calendar", () => {
  it.each([1, 2, 7, 14, 31, 60])("keeps a %i-day world's events and answer key inside its window", (days) => {
    const start = "2026-01-01";
    const end = addDays(start, days - 1);
    const w = world(start, days);
    for (const item of [...w.events, ...w.answerKey.errors, ...w.answerKey.decoys]) {
      expect(item.occurredOn >= start && item.occurredOn <= end, JSON.stringify(item)).toBe(true);
    }
    expect([...new Set(w.events.map((e) => e.occurredOn))]).toEqual(Array.from({ length: days }, (_, i) => addDays(start, i)));
    expect(w.events.filter((e) => e.type === "day.end")).toHaveLength(days);
    expect(w.truth.events).toBe(w.events.length);
  });

  it("keeps delayed resends and credits on their actual delivery dates when in range", () => {
    const w = world("2026-01-01", 21);
    const duplicate = w.answerKey.errors.find((e) => e.type === "duplicate_lookalike")!;
    const originalRef = duplicate.subject.ref.replace(/-R$/, "");
    const original = w.events.find((e) => e.externalId === `doc-${duplicate.subject.vendor}-${originalRef}`)!;
    expect(duplicate.occurredOn).toBe(addDays(original.occurredOn, 3));
    expect(w.events.some((e) => e.externalId === `doc-${duplicate.subject.vendor}-${duplicate.subject.ref}`)).toBe(true);
    expect(w.events.some((e) => e.payload.kind === "credit_memo")).toBe(true);
  });

  it.each([
    ["2026-01-01", 60, ["2026-01-01", "2026-02-01", "2026-03-01"], ["2026-01-05", "2026-02-05", "2026-03-01"]],
    ["2026-01-30", 32, ["2026-01-30", "2026-02-01", "2026-03-01"], ["2026-01-30", "2026-02-05", "2026-03-02"]],
    ["2024-02-01", 30, ["2024-02-01", "2024-03-01"], ["2024-02-05", "2024-03-01"]],
  ] as const)("generates each month's obligations from %s for %i days", (start, days, rentDates, supplierDates) => {
    const w = world(start, days, false);
    const leases = w.events.filter((e) => e.payload.kind === "lease_invoice");
    expect(leases).toHaveLength(rentDates.length * 3);
    expect([...new Set(leases.map((e) => e.occurredOn))]).toEqual(rentDates);
    for (const vendor of VENDORS.filter((v) => v.deliveriesPerWeek === 0)) {
      const bills = w.events.filter((e) => e.payload.kind === "invoice" && e.payload.from === vendor.contact.email);
      expect(bills).toHaveLength(supplierDates.length * 3);
      expect([...new Set(bills.map((e) => e.occurredOn))]).toEqual(supplierDates);
    }
    expect(new Set(w.events.map((e) => e.externalId)).size).toBe(w.events.length);
    const billedRent = leases.reduce((sum, e) => {
      const text = e.payload.text as string;
      const amount = text.match(/Total due:\s*\$([\d,.]+)/i);
      expect(amount, text).not.toBeNull();
      return sum + Math.round(Number(amount![1]!.replaceAll(",", "")) * 100);
    }, 0);
    expect(w.truth.legitRentCents).toBe(billedRent);
  });

  it("is deterministic across a multi-month scenario", () => {
    expect(world("2026-01-01", 60)).toEqual(world("2026-01-01", 60));
  });
});
