import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  businessFixture,
  acceptance,
  binding,
  br,
  syncPrimary,
} from "./business-fixture";
import { packet } from "./accounting-fixture";
import type { APIntake } from "../../src/ap-system/contracts";
import type { CreditPlan } from "../../src/ap-system/domain-contracts";
import type { Id } from "../../convex/_generated/dataModel";
afterEach(() => vi.unstubAllEnvs());
async function setup() {
  const input = packet("V4-CREDIT-ORIGINAL"),
    c = input.candidate!;
  c.lines[0]!.taxCents = 770;
  c.taxCents = 770;
  c.totalCents = 8470;
  c.lines[0]!.allocations[0]!.amountCents = 8470;
  syncPrimary(input);
  const f = await businessFixture({ input });
  const a = acceptance(input);
  a.lines[0]!.allocations = [
    { ...a.lines[0]!.allocations[0]!, amountCents: 4235 },
    {
      ...a.lines[0]!.allocations[0]!,
      account: "1200",
      treatment: "inventory",
      amountCents: 4235,
    },
  ];
  const original = await f.recognize(f.detail, a);
  async function makeCredit(number: string, prior?: APIntake) {
    const p = packet(number),
      c = p.candidate!;
    c.kind = "credit_note";
    p.documents[0]!.kind = "credit_note";
    c.lines[0]!.quantity.decimal = "1";
    c.lines[0]!.amountCents = 3850;
    c.lines[0]!.taxCents = 385;
    c.lines[0]!.allocations[0]!.amountCents = 4235;
    c.subtotalCents = 3850;
    c.taxCents = 385;
    c.totalCents = 4235;
    if (prior) {
      p.documents[2] = structuredClone(prior.documents[2]!);
      p.documents[2]!.sourceId += "-copy";
      p.documents[2]!.deliveryId += "-copy";
      p.purchasingEvidence[1] = structuredClone(prior.purchasingEvidence[1]!);
      p.purchasingEvidence[1]!.source = binding(p.documents[2]!);
      p.purchasingEvidence[1]!.lines[0]!.lineId += "-renumbered";
    } else {
      const doc = p.documents[2]!,
        text = `Independent return ${number}: KALE-24 1 case received by receiver on2026-10-19`;
      doc.originalBase64 = Buffer.from(text).toString("base64");
      doc.byteLength = Buffer.byteLength(text);
      doc.extractedText = text;
      doc.sha256 = createHash("sha256").update(text).digest("hex");
      p.purchasingEvidence[1]!.source = binding(doc);
      p.purchasingEvidence[1]!.lines[0]!.quantity.decimal = "1";
    }
    syncPrimary(p);
    const d = await f.reviewed(p);
    const plan: CreditPlan = {
      originalCaseId: f.detail.caseId,
      originalApprovalId: original.proposal.proposalId,
      freightCents: 0,
      discountCents: 0,
      lines: [
        {
          creditLineId: "line-1",
          originalLineId: "line-1",
          basis: "quantity_return",
          quantity: "1",
          netCents: 3850,
          taxCents: 385,
          returnEvidence: [binding(p.documents[2]!)],
        },
      ],
      reason: "One original unit returned; no price or tax adjustment",
    };
    const propose = () =>
      f.t.mutation(br.propose!, {
        ...f.ap,
        input: {
          caseId: d.caseId,
          expectedRevision: d.revision,
          snapshotHash: d.snapshotHash,
          idempotencyKey: "credit-" + number,
          policyVersion: f.policy.version,
          supplierRevision: 1,
          credit: plan,
        },
      });
    return { p, d, plan, propose };
  }
  return { ...f, original, makeCredit };
}
describe("V4 independent credits and return-source capacity", () => {
  it("cannot recredit the same return bytes by renumbering the return line", async () => {
    const f = await setup(),
      first = await f.makeCredit("V4-CN1");
    await f.vote(await first.propose());
    const copy = await f.makeCredit("V4-CN2", first.p);
    await expect(copy.propose()).rejects.toThrow(
      /already_used|consumption_source_conflict|source_line_identity/,
    );
    expect(
      await f.t.run((ctx) => ctx.db.query("demoCredits").collect()),
    ).toHaveLength(1);
  });
  it("reverses every original allocated cent once and atomically rolls back a multi-credit overdraw", async () => {
    const f = await setup(),
      credits: Id<"demoCredits">[] = [];
    for (const n of [1, 2]) {
      const c = await f.makeCredit("V4-EXACT-" + n),
        result = await f.vote(await c.propose());
      credits.push(result.creditId);
    }
    const links = await f.t.run((ctx) =>
      ctx.db.query("apCreditLinks").collect(),
    );
    expect(
      links.map((l) =>
        l.allocations.map((a: { amountCents: number }) => a.amountCents),
      ),
    ).toEqual([
      [2118, 2117],
      [2117, 2118],
    ]);
    const d = await f.get(f.detail.caseId),
      args = {
        scope: f.scope,
        caseId: d.caseId,
        expectedRevision: d.revision,
        snapshotHash: d.snapshotHash,
        billVersion: d.links.billVersion,
        idempotencyKey: "v4-multi-credit",
        reason: "Explicit credit-only application",
        credits: [
          { creditId: credits[0]!, amountCents: 1000 },
          { creditId: credits[1]!, amountCents: 5000 },
        ],
      };
    await expect(
      f.humans.finance!.mutation(br.applyCredits!, args),
    ).rejects.toThrow(/credit_unavailable/);
    expect(
      await f.t.run((ctx) => ctx.db.query("apCreditApplications").collect()),
    ).toEqual([]);
    expect(
      (await f.t.run((ctx) => ctx.db.query("demoCredits").collect())).map(
        (c) => c.consumedCents,
      ),
    ).toEqual([0, 0]);
    expect((await f.get(d.caseId)).amounts.outstandingCents).toBe(8470);
    const exact = {
      ...args,
      idempotencyKey: "v4-exact-credit",
      credits: credits.map((creditId) => ({ creditId, amountCents: 4235 })),
    };
    expect(
      await f.humans.finance!.mutation(br.applyCredits!, exact),
    ).toMatchObject({ appliedCents: 8470, cashCents: 0 });
    expect(
      await f.humans.finance!.mutation(br.applyCredits!, exact),
    ).toMatchObject({ appliedCents: 8470 });
    const final = await f.get(d.caseId);
    expect(final.amounts).toMatchObject({
      acceptedCents: 8470,
      creditedCents: 8470,
      settledCents: 0,
      outstandingCents: 0,
    });
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(3);
    expect(
      await f.t.run((ctx) => ctx.db.query("demoCommands").collect()),
    ).toEqual([]);
  });
});
