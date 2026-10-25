import { createHash } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import type { APIntake, APCaseDetail } from "../../src/ap-system/contracts";
import type {
  PhysicalMappingProposal,
  PhysicalLine,
} from "../../src/ap-system/physical-line-contracts";
import {
  currentSupplier,
  resolveAPBusinessPaymentAuthority,
} from "../../convex/lib/apSystem/businessAuthority";
import {
  businessFixture,
  policy,
  subject,
  binding,
  acceptance,
  syncPrimary,
  br,
} from "./business-fixture";
import { packet } from "./accounting-fixture";
const ref = (n: string) =>
  makeFunctionReference<"mutation">(`apPhysicalLines:${n}`);
const close = (n: string) => makeFunctionReference<"mutation">(`apClose:${n}`);
const view = makeFunctionReference<"query">("apPhysicalLines:view");
const periodView = makeFunctionReference<"query">("apClose:view");
const lines = [
  "Dock A KALE-24 1 case received",
  "Dock B KALE-24 1 case received",
];
const physical: PhysicalLine[] = lines.map((quote, i) => ({
  physicalLineId: `dock-${i + 1}`,
  sku: "KALE-24",
  unit: "case",
  capacity: "1",
  unitPriceCents: null,
  locator: {
    page: 1,
    start: i ? lines[0]!.length + 1 : 0,
    end: (i ? lines[0]!.length + 1 : 0) + quote.length,
    quote,
  },
}));
function inputPacket(
  number = "physical",
  style: "split" | "merged" | "reordered" = "split",
) {
  const input = packet(number),
    doc = input.documents[2]!,
    body = lines.join("\n");
  Object.assign(doc, {
    extractedText: body,
    originalBase64: Buffer.from(body).toString("base64"),
    byteLength: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  const p = input.purchasingEvidence[1]!;
  p.source = binding(doc);
  const template = p.lines[0]!;
  p.lines =
    style === "merged"
      ? [
          {
            ...template,
            lineId: `merged-${number}`,
            quantity: { decimal: "2", unit: "case" },
          },
        ]
      : [0, 1].map((i) => ({
          ...template,
          lineId: `row-${i + 1}-${number}`,
          quantity: { decimal: "1", unit: "case" },
        }));
  if (style === "reordered") p.lines.reverse();
  return syncPrimary(input);
}
async function setup() {
  const p = policy();
  p.groups.push({ groupId: "receiving", members: [subject("second")] });
  p.receiptIdentityApprovalGroup = "receiving";
  const f = await businessFixture({ policy: p, input: inputPacket() });
  async function proposeMap(
    input: APIntake = f.input,
    detail: APCaseDetail = f.detail,
    catalogId?: string,
    patch: Partial<PhysicalMappingProposal> = {},
  ) {
    const p = input.purchasingEvidence[1]!;
    const links =
      p.lines.length === 1
        ? physical.map((l) => ({
            parserLineId: p.lines[0]!.lineId,
            physicalLineId: l.physicalLineId,
            quantity: "1",
          }))
        : p.lines.map((l) => ({
            parserLineId: l.lineId,
            physicalLineId: l.lineId.startsWith("row-1") ? "dock-1" : "dock-2",
            quantity: "1",
          }));
    const proposal: PhysicalMappingProposal = {
      caseId: detail.caseId,
      expectedRevision: detail.revision,
      snapshotHash: detail.snapshotHash,
      source: p.source,
      ...(catalogId ? { catalogId } : { physicalLines: physical }),
      links,
      reason: "Human comparison of distinct original dock lines",
      ...patch,
    };
    return f.t.mutation(ref("propose"), {
      ...f.controller,
      idempotencyKey: `map-${detail.caseId}-${JSON.stringify(patch)}`,
      proposal,
    });
  }
  async function approveMap(
    p: { reviewId: string; hash: string },
    outcome = "approved",
  ) {
    return f.humans.second!.mutation(ref("decide"), {
      scope: f.scope,
      input: {
        reviewId: p.reviewId,
        expectedHash: p.hash,
        outcome,
        reason: "Compared each exact original span and conserved quantities",
      },
    });
  }
  function accepted(
    input: APIntake,
    reviewId: string,
    selected = ["dock-1", "dock-2"],
  ) {
    const a = acceptance(input, String(selected.length));
    const p = input.purchasingEvidence[1]!;
    a.lines[0]!.receipts = p.lines
      .filter(
        (l) =>
          p.lines.length === 1 ||
          selected.includes(l.lineId.startsWith("row-1") ? "dock-1" : "dock-2"),
      )
      .map((l) => {
        const ids =
          p.lines.length === 1
            ? selected
            : [l.lineId.startsWith("row-1") ? "dock-1" : "dock-2"];
        return {
          source: p.source,
          lineId: l.lineId,
          quantity: String(ids.length),
          identity: {
            reviewId,
            allocations: ids.map((physicalLineId) => ({
              physicalLineId,
              quantity: "1",
            })),
          },
        };
      });
    return a;
  }
  return { ...f, proposeMap, approveMap, accepted };
}
afterEach(() => vi.unstubAllEnvs());
describe("E04 reviewed physical receipt identities", () => {
  it("retains repeated-SKU holds until a positive independent mapping, then recognizes both physical lines", async () => {
    const f = await setup(),
      a = acceptance(f.input);
    a.lines[0]!.receipts = f.input.purchasingEvidence[1]!.lines.map((l) => ({
      source: f.input.purchasingEvidence[1]!.source,
      lineId: l.lineId,
      quantity: "1",
    }));
    await expect(f.propose(f.detail, a)).rejects.toThrow(
      /source_line_identity|consumption_source_conflict/,
    );
    const p = await f.proposeMap();
    await expect(
      f.propose(f.detail, f.accepted(f.input, p.reviewId)),
    ).rejects.toThrow(/physical_review_required/);
    await f.approveMap(p);
    await f.recognize(f.detail, f.accepted(f.input, p.reviewId));
    const uses = await f.t.run((ctx) =>
      ctx.db.query("apReceiptConsumptions").collect(),
    );
    expect(
      uses
        .filter((u) => u.physicalLineId)
        .map((u) => u.physicalLineId)
        .sort(),
    ).toEqual(["dock-1", "dock-2"]);
  });
  it.each(["merged", "reordered"] as const)(
    "allows reviewed %s parser representation without creating capacity",
    async (style) => {
      const f = await setup(),
        p = await f.proposeMap(),
        approved = await f.approveMap(p);
      await f.recognize(f.detail, f.accepted(f.input, p.reviewId, ["dock-1"]));
      const next = inputPacket("next", style),
        detail = await f.reviewed(next),
        m = await f.proposeMap(next, detail, approved.catalogId);
      await f.approveMap(m);
      await f.recognize(detail, f.accepted(next, m.reviewId, ["dock-2"]));
      const third = inputPacket("over", style),
        over = await f.reviewed(third),
        last = await f.proposeMap(third, over, approved.catalogId);
      await f.approveMap(last);
      await expect(
        f.recognize(over, f.accepted(third, last.reviewId, ["dock-1"])),
      ).rejects.toThrow(/received_units_already_used/);
      expect(
        await f.t.run((ctx) => ctx.db.query("demoBills").collect()),
      ).toHaveLength(2);
    },
  );
  it("rejects a renamed original trying to establish a second catalog", async () => {
    const f = await setup(),
      p = await f.proposeMap();
    await f.approveMap(p);
    const next = inputPacket("renamed"),
      d = await f.reviewed(next);
    await expect(f.proposeMap(next, d)).rejects.toThrow(
      /physical_catalog_exists/,
    );
  });
  it("rejects overlapping or fabricated source locators even with different physical names", async () => {
    const f = await setup();
    await expect(
      f.proposeMap(f.input, f.detail, undefined, {
        physicalLines: [
          physical[0]!,
          { ...physical[1]!, locator: physical[0]!.locator },
        ],
      }),
    ).rejects.toThrow(/physical_locator_overlap/);
    await expect(
      f.proposeMap(f.input, f.detail, undefined, {
        physicalLines: [
          {
            ...physical[0]!,
            locator: {
              ...physical[0]!.locator,
              quote: "Invented KALE-24 case",
            },
          },
          physical[1]!,
        ],
      }),
    ).rejects.toThrow(/physical_locator_invalid|physical_locator_quantity/);
  });
  it("cannot increase aggregate capacity by splitting, merging or changing SKU/unit/price", async () => {
    const f = await setup(),
      p = await f.proposeMap(),
      a = await f.approveMap(p);
    for (const field of ["quantity", "sku", "unitPriceCents", "unit"]) {
      const input = inputPacket(`conflict-${field}`, "merged"),
        l = input.purchasingEvidence[1]!.lines[0]!;
      if (field === "quantity") l.quantity.decimal = "3";
      else if (field === "sku") l.sku = "OTHER";
      else if (field === "unit") l.quantity.unit = "pallet";
      else l.unitPriceCents = 1;
      const d = await f.reviewed(input);
      await expect(f.proposeMap(input, d, a.catalogId)).rejects.toThrow(
        /physical_capacity_mismatch|physical_mapping_invalid/,
      );
    }
  });
  it("does not infer distribution of a partial merged parser line", async () => {
    const f = await setup(),
      input = inputPacket("merged", "merged"),
      d = await f.reviewed(input),
      p = await f.proposeMap(input, d);
    await f.approveMap(p);
    const a = f.accepted(input, p.reviewId, ["dock-1"]);
    a.lines[0]!.receipts[0]!.identity!.allocations = [];
    await expect(f.propose(d, a)).rejects.toThrow();
    const wrong = f.accepted(input, p.reviewId, ["dock-1"]);
    wrong.lines[0]!.receipts[0]!.identity!.allocations[0]!.quantity = "2";
    await expect(f.propose(d, wrong)).rejects.toThrow(
      /physical_claim_invalid|physical_claim_sum/,
    );
  });
  it("requires a current configured independent human and immutable exact decision", async () => {
    const f = await setup(),
      p = await f.proposeMap();
    await expect(
      f.humans.owner!.mutation(ref("decide"), {
        scope: f.scope,
        input: {
          reviewId: p.reviewId,
          expectedHash: p.hash,
          outcome: "approved",
          reason: "No role",
        },
      }),
    ).rejects.toThrow(/approval_group_required/);
    await expect(
      f.humans.second!.mutation(ref("decide"), {
        scope: f.scope,
        input: {
          reviewId: p.reviewId,
          expectedHash: "0".repeat(64),
          outcome: "approved",
          reason: "Wrong hash",
        },
      }),
    ).rejects.toThrow(/physical_review_hash/);
    const a = await f.approveMap(p);
    expect(await f.approveMap(p)).toEqual(a);
    await expect(f.approveMap(p, "rejected")).rejects.toThrow(
      /physical_review_immutable/,
    );
    await f.t.run(async (ctx) => {
      const seat = await ctx.db
        .query("seats")
        .withIndex("by_run_seat", (q) =>
          q.eq("runId", f.scope.runId).eq("seatId", "human-second"),
        )
        .unique();
      await ctx.db.patch(seat!._id, { status: "retired" });
    });
    await expect(
      f.propose(f.detail, f.accepted(f.input, p.reviewId)),
    ).rejects.toThrow(/inactive_approver/);
  });
  it("rechecks physical reviewer authority before payment without rewriting the recognition", async () => {
    const f = await setup(),
      p = await f.proposeMap();
    await f.approveMap(p);
    const b = await f.recognize(f.detail, f.accepted(f.input, p.reviewId));
    await f.t.run(async (ctx) => {
      const seat = await ctx.db
        .query("seats")
        .withIndex("by_run_seat", (q) =>
          q.eq("runId", f.scope.runId).eq("seatId", "human-second"),
        )
        .unique();
      await ctx.db.patch(seat!._id, { status: "retired" });
    });
    await expect(
      f.t.run((ctx) =>
        resolveAPBusinessPaymentAuthority(ctx, f.scope, [b.billId]),
      ),
    ).rejects.toThrow(/inactive_approver/);
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(1);
  });
  it("keeps pre-mapping historical usage held instead of guessing new physical attribution", async () => {
    const f = await setup(),
      plain = packet("old-use"),
      d = await f.reviewed(plain);
    await f.recognize(d, acceptance(plain, "1"));
    const same = structuredClone(plain);
    same.idempotencyKey = "old-use-map";
    const p = same.purchasingEvidence[1]!,
      text = same.documents[2]!.extractedText;
    await expect(
      f.proposeMap(plain, d, undefined, {
        physicalLines: [
          {
            ...physical[0]!,
            capacity: "2",
            locator: { page: 1, start: 0, end: text.length, quote: text },
          },
        ],
        links: [
          {
            parserLineId: p.lines[0]!.lineId,
            physicalLineId: "dock-1",
            quantity: "2",
          },
        ],
      }),
    ).rejects.toThrow(/physical_legacy_usage/);
  });
  it("returns exact proposal replays and deduplicates the one original catalog under concurrent approvals", async () => {
    const f = await setup();
    const [a, b] = await Promise.all([f.proposeMap(), f.proposeMap()]);
    expect(a).toEqual(b);
    await f.approveMap(a);
    expect(
      (await f.humans.second!.query(view, { scope: f.scope })).catalogs,
    ).toHaveLength(1);
    await expect(f.t.query(view, { scope: f.scope })).rejects.toThrow();
  });
  it("keeps period close blocked for unmatched physical lines and for unmapped duplicate SKU rows", async () => {
    const f = await setup();
    let v = await f.humans.finance!.query(periodView, {
      scope: f.scope,
      period: "2026-10",
    });
    expect(v.blockers.some((b: any) => b.code === "source_line_identity")).toBe(
      true,
    );
    const p = await f.proposeMap();
    await f.approveMap(p);
    await f.recognize(f.detail, f.accepted(f.input, p.reviewId, ["dock-1"]));
    v = await f.humans.finance!.query(periodView, {
      scope: f.scope,
      period: "2026-10",
    });
    expect(
      v.blockers.some(
        (b: any) =>
          b.code === "received_not_invoiced" && b.reference.includes("dock-2"),
      ),
    ).toBe(true);
  });
  it("serializes competing final approvals against one physical line", async () => {
    const f = await setup(),
      p = await f.proposeMap(),
      a = await f.approveMap(p),
      input = inputPacket("concurrent"),
      d = await f.reviewed(input),
      m = await f.proposeMap(input, d, a.catalogId);
    await f.approveMap(m);
    const first = await f.propose(
        f.detail,
        f.accepted(f.input, p.reviewId, ["dock-1"]),
        "one",
      ),
      second = await f.propose(
        d,
        f.accepted(input, m.reviewId, ["dock-1"]),
        "two",
      );
    const results = await Promise.allSettled([f.vote(first), f.vote(second)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      await f.t.run((ctx) => ctx.db.query("demoBills").collect()),
    ).toHaveLength(1);
  });
  it("supports repeated reviewed service acceptance lines under the existing non-PO route", async () => {
    const f = await setup(),
      input = inputPacket("service");
    input.documents[1]!.kind = "contract";
    input.purchasingEvidence[0]!.kind = "contract";
    input.purchasingEvidence[1]!.kind = "service_acceptance";
    const d = await f.reviewed(input),
      p = await f.proposeMap(input, d);
    await f.approveMap(p);
    await f.recognize(d, f.accepted(input, p.reviewId));
    expect(
      (await f.t.run((ctx) => ctx.db.query("apReceiptConsumptions").collect()))
        .filter((x) => x.physicalLineId)
        .every((x) => x.kind === "service_acceptance"),
    ).toBe(true);
  });
  it("supports a reviewed split after the first parser merged both physical rows", async () => {
    const f = await setup(),
      first = inputPacket("first-merged", "merged"),
      d = await f.reviewed(first),
      p = await f.proposeMap(first, d),
      a = await f.approveMap(p);
    await f.recognize(d, f.accepted(first, p.reviewId, ["dock-1"]));
    const next = inputPacket("later-split"),
      nd = await f.reviewed(next),
      np = await f.proposeMap(next, nd, a.catalogId);
    await f.approveMap(np);
    await f.recognize(nd, f.accepted(next, np.reviewId, ["dock-2"]));
    expect(
      await f.t.run((ctx) => ctx.db.query("demoBills").collect()),
    ).toHaveLength(2);
  });
  it("uses the same physical capacity protection for explicit supplier return credits", async () => {
    const f = await setup(),
      p = await f.proposeMap();
    await f.approveMap(p);
    const original = await f.recognize(
      f.detail,
      f.accepted(f.input, p.reviewId),
    );
    const texts = lines.map((l) => `Supplier return ${l}`),
      body = texts.join("\n");
    const returnPhysical = physical.map((l, i) => ({
      ...l,
      locator: {
        page: 1,
        start: i ? texts[0]!.length + 1 : 0,
        end: (i ? texts[0]!.length + 1 : 0) + texts[i]!.length,
        quote: texts[i]!,
      },
    }));
    function creditInput(number: string) {
      const input = inputPacket(number),
        c = input.candidate!;
      c.kind = "credit_note";
      input.documents[0]!.kind = "credit_note";
      c.lines[0]!.quantity.decimal = "1";
      c.lines[0]!.amountCents = 3850;
      c.lines[0]!.allocations[0]!.amountCents = 3850;
      c.subtotalCents = 3850;
      c.totalCents = 3850;
      Object.assign(input.documents[2]!, {
        extractedText: body,
        originalBase64: Buffer.from(body).toString("base64"),
        byteLength: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
      });
      input.purchasingEvidence[1]!.source = binding(input.documents[2]!);
      return syncPrimary(input);
    }
    async function proposeCredit(
      input: APIntake,
      d: APCaseDetail,
      reviewId: string,
      physicalLineId: string,
      key: string,
    ) {
      const line =
        input.purchasingEvidence[1]!.lines[
          physicalLineId === "dock-1" ? 0 : 1
        ]!;
      return f.t.mutation(br.propose!, {
        ...f.ap,
        input: {
          caseId: d.caseId,
          expectedRevision: d.revision,
          snapshotHash: d.snapshotHash,
          idempotencyKey: key,
          policyVersion: f.policy.version,
          supplierRevision: 1,
          credit: {
            originalCaseId: f.detail.caseId,
            originalApprovalId: original.proposal.proposalId,
            freightCents: 0,
            discountCents: 0,
            reason: "Explicit supported return",
            lines: [
              {
                creditLineId: "line-1",
                originalLineId: "line-1",
                basis: "quantity_return",
                quantity: "1",
                netCents: 3850,
                taxCents: 0,
                returnEvidence: [binding(input.documents[2]!)],
                returnClaims: [
                  {
                    source: binding(input.documents[2]!),
                    lineId: line.lineId,
                    quantity: "1",
                    identity: {
                      reviewId,
                      allocations: [{ physicalLineId, quantity: "1" }],
                    },
                  },
                ],
              },
            ],
          },
        },
      });
    }
    const one = creditInput("return-one"),
      od = await f.reviewed(one),
      op = await f.proposeMap(one, od, undefined, {
        physicalLines: returnPhysical,
      }),
      oa = await f.approveMap(op);
    await f.vote(
      await proposeCredit(one, od, op.reviewId, "dock-1", "return-first"),
    );
    const two = creditInput("return-two"),
      td = await f.reviewed(two),
      tp = await f.proposeMap(two, td, oa.catalogId);
    await f.approveMap(tp);
    await expect(
      proposeCredit(two, td, tp.reviewId, "dock-1", "return-reused"),
    ).rejects.toThrow(/received_units_already_used/);
    await f.vote(
      await proposeCredit(two, td, tp.reviewId, "dock-2", "return-second"),
    );
    expect(
      await f.t.run((ctx) => ctx.db.query("apCreditLinks").collect()),
    ).toHaveLength(2);
  });
  it("accrues one reviewed physical line and reverses it only against that line's later invoice", async () => {
    const f = await setup(),
      p = await f.proposeMap();
    await f.approveMap(p);
    const accrual = {
      supplierId: f.supplier.supplierId,
      source: f.input.purchasingEvidence[1]!.source,
      lineId: f.input.purchasingEvidence[1]!.lines[1]!.lineId,
      sku: "KALE-24",
      unit: "case",
      description: "Dock B not yet invoiced",
      quantity: "1",
      capacityQuantity: "1",
      unitPriceCents: 3850,
      allocations: acceptance(f.input, "1").lines[0]!.allocations,
      date: "2026-10-19",
      expectedInvoiceCaseId: null,
      quote: lines[1]!,
      reason: "Source-supported accrual",
      identity: { reviewId: p.reviewId, physicalLineId: "dock-2" },
    };
    const proposal = await f.t.mutation(close("propose"), {
      ...f.controller,
      input: {
        idempotencyKey: "physical-accrual",
        action: { kind: "accrual", accrual },
      },
    });
    const posted = await f.humans.owner!.mutation(close("vote"), {
      scope: f.scope,
      input: {
        actionId: proposal.actionId,
        actionHash: proposal.actionHash,
        idempotencyKey: "approve-accrual",
        outcome: "approved",
        reason: "Reviewed exact physical receipt",
      },
    });
    expect(posted.status).toBe("approved");
    const rows = await f.t.run((ctx) => ctx.db.query("apAccruals").collect());
    expect(rows).toHaveLength(1);
    await f.recognize(f.detail, f.accepted(f.input, p.reviewId, ["dock-1"]));
    const next = inputPacket("dock-b", "merged"),
      d = await f.reviewed(next),
      mapped = await f.proposeMap(
        next,
        d,
        (await f.humans.second!.query(view, { scope: f.scope })).catalogs[0]
          .catalogId,
      );
    await f.approveMap(mapped);
    await expect(
      f.propose(d, f.accepted(next, mapped.reviewId, ["dock-2"])),
    ).rejects.toThrow(/accrual_application_required/);
    const q = await f.t.mutation(br.propose!, {
      ...f.ap,
      input: {
        caseId: d.caseId,
        expectedRevision: d.revision,
        snapshotHash: d.snapshotHash,
        idempotencyKey: "invoice-dock-b",
        policyVersion: f.policy.version,
        supplierRevision: 1,
        acceptance: f.accepted(next, mapped.reviewId, ["dock-2"]),
        accrualApplications: [{ accrualId: rows[0]!._id, quantity: "1" }],
      },
    });
    await f.vote(q);
    expect(
      (await f.t.run((ctx) => ctx.db.get(rows[0]!._id)))?.reversedQuantity,
    ).toBe("1");
  });
});
