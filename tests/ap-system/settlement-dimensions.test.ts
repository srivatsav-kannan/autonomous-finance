import { afterEach, describe, expect, it, vi } from "vitest";
import { businessPolicySchema } from "../../src/ap-system/domain-contracts";
import { businessFixture, acceptance, policy } from "./business-fixture";
import { creditFixture } from "./quickbooks-business-fixture";
const dimensions = {
  version: "ap-gl-dimensions-v1" as const,
  scope: "cost_and_settlement" as const,
  settlementDepartment: "homogeneous_approved_department" as const,
  departments: ["ops", "sales"],
  projects: [],
};
afterEach(() => vi.unstubAllEnvs());
describe("Explicit immutable settlement location recognition", () => {
  it("requires the operator's scope/rule pair and rejects mixed including null departments before recognition", async () => {
    const p = { ...policy(), dimensions };
    expect(
      businessPolicySchema.safeParse({
        ...p,
        dimensions: { ...dimensions, settlementDepartment: undefined },
      }).success,
    ).toBe(false);
    expect(
      businessPolicySchema.safeParse({
        ...p,
        dimensions: { ...dimensions, scope: "cost_allocations" },
      }).success,
    ).toBe(false);
    const f = await businessFixture({ policy: p });
    for (const department of [null, "sales"]) {
      const a = acceptance(f.input),
        line = a.lines[0]!;
      line.allocations = [
        { ...line.allocations[0]!, amountCents: 3850, department: "ops" },
        { ...line.allocations[0]!, amountCents: 3850, department },
      ];
      await expect(
        f.propose(f.detail, a, `mixed-${department}`),
      ).rejects.toThrow("settlement_department_mixed_or_unknown");
    }
    expect(
      await f.t.run((ctx) => ctx.db.query("demoBills").collect()),
    ).toHaveLength(0);
  });
  it("posts and exports exact original AP department on recognition and linked credit", async () => {
    const f = await creditFixture(0, {
      department: "ops",
      scope: "cost_and_settlement",
    });
    const c = await f.credit(),
      invoice = await f.load(),
      credit = await f.load(c.caseId);
    for (const r of [invoice.recognizedInvoice!, credit.recognizedCredit!]) {
      expect(r.settlementAuthority).toMatchObject({
        version: "ap-settlement-dimensions-v1",
        mode: "department_as_location",
        department: "ops",
      });
      expect(r.settlementAuthority!.policyHash).toMatch(/^[a-f0-9]{64}$/);
      const j = (await f.t.run((ctx) => ctx.db.get(r.journalId as any))) as any;
      expect(j.lines.find((l: any) => l.account === "2000").dims).toEqual({
        vendor: f.supplier.supplierId,
        department: "ops",
      });
      expect(r.settlementAuthority!.journalHash).toBe(j.hash);
    }
    const original = invoice.recognizedInvoice!;
    await f.t.run(async (ctx) => {
      const p = await ctx.db.query("apBusinessPolicies").first();
      await ctx.db.patch(p!._id, { status: "superseded" });
    });
    expect((await f.load()).recognizedInvoice).toEqual(original);
  });
  it("retains legacy cost-only AP dimensions and does not claim settlement authority", async () => {
    const f = await creditFixture(0, {
      department: "ops",
      scope: "cost_allocations",
    });
    const e = await f.load();
    expect(e.recognizedInvoice).not.toHaveProperty("settlementAuthority");
    const j = (await f.t.run((ctx) =>
      ctx.db.get(e.recognizedInvoice!.journalId as any),
    )) as any;
    expect(j.lines.find((l: any) => l.account === "2000").dims).toEqual({
      vendor: f.supplier.supplierId,
    });
  });
  it("retains explicit null settlement authority and rejects changed historical AP coordinates", async () => {
    const f = await creditFixture(0, {
      department: null,
      scope: "cost_and_settlement",
    });
    const e = await f.load();
    expect(e.recognizedInvoice!.settlementAuthority!.department).toBeNull();
    await f.t.run(async (ctx) => {
      const j = (await ctx.db.get(
        e.recognizedInvoice!.journalId as any,
      )) as any;
      await ctx.db.patch(j._id, {
        lines: j.lines.map((l: any) =>
          l.account === "2000"
            ? { ...l, dims: { ...l.dims, department: "ops" } }
            : l,
        ),
      });
    });
    await expect(f.load()).rejects.toThrow("recognition_journal_mismatch");
  });
});
