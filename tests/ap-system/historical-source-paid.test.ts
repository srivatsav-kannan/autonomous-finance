import { afterEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { fixture, packet, refs } from "./accounting-fixture";
import { businessFixture } from "./business-fixture";
import { statementPaymentMatches } from "../../src/ap-system/replay/apex-sources";
import { api } from "../../convex/_generated/api";
afterEach(() => vi.unstubAllEnvs());
const record = makeFunctionReference<"mutation">(
  "apCases:recordHistoricalPayment",
);
function proof(
  d: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["get"]>>,
) {
  const s = d.sources.find((s) => s.kind === "invoice")!;
  return {
    version: "source-paid-v1",
    dataset: "synthetic-test",
    datasetRevision: "v1",
    sourceBillId: "legacy-bill-1",
    bankTransactionId: "legacy-transfer-1",
    reference: "ACH-123",
    paidAt: "2026-10-20",
    amountCents: 7700,
    invoiceSource: {
      sourceId: s.sourceId,
      revision: s.revision,
      sha256: s.sha256,
    },
    evidenceHashes: ["a".repeat(64), "b".repeat(64)],
    reason: "Test-only retained historical ledger and statement proof",
  };
}
it("retains source-paid status through reimport and explicit revision without fabricating settlement", async () => {
  const f = await fixture(),
    input = packet(),
    d = await f.reviewed(input),
    args = {
      ...f.ap,
      caseId: d.caseId,
      expectedRevision: d.revision,
      snapshotHash: d.snapshotHash,
      proof: proof(d),
    };
  await f.t.mutation(record, args);
  await f.t.mutation(record, args);
  await expect(
    f.human.mutation(refs.approve, {
      scope: f.scope,
      input: { ...f.request(d, "approve-paid"), acceptedCents: 7700 },
    }),
  ).rejects.toThrow(/historical_source_paid/);
  await f.t.mutation(refs.ingest, {
    ...f.ap,
    input: {
      ...input,
      idempotencyKey: "renamed",
      documents: input.documents.map((s) => ({
        ...s,
        name: `renamed-${s.name}`,
        deliveryId: `resend-${s.deliveryId}`,
      })),
    },
  });
  const revised = structuredClone(input);
  revised.explicitRevisionOf = d.caseId;
  revised.idempotencyKey = "revision";
  revised.candidate!.revision = 2;
  await f.t.mutation(refs.ingest, { ...f.ap, input: revised });
  let next = await f.get(d.caseId);
  await f.fieldReviewer.mutation(refs.review, {
    scope: f.scope,
    input: f.request(next, "review-revision"),
  });
  next = await f.get(d.caseId);
  expect(next.historicalPayment).toEqual(args.proof);
  expect(
    next.exceptions.some(
      (e) => e.code === "historical_source_paid" && e.blocking,
    ),
  ).toBe(true);
  await expect(
    f.human.mutation(refs.approve, {
      scope: f.scope,
      input: { ...f.request(next, "approve-revision"), acceptedCents: 7700 },
    }),
  ).rejects.toThrow(/historical_source_paid/);
  expect(next.journals).toHaveLength(0);
  expect(next.payments).toHaveLength(0);
  expect(next.amounts.settledCents).toBe(0);
  expect(
    await f.t.run((ctx) => ctx.db.query("demoBills").collect()),
  ).toHaveLength(0);
});
it("blocks governed recognition even with complete contract, receipt, field review and configured approvers", async () => {
  const f = await businessFixture();
  await f.t.mutation(record, {
    ...f.ap,
    caseId: f.detail.caseId,
    expectedRevision: f.detail.revision,
    snapshotHash: f.detail.snapshotHash,
    proof: proof(f.detail),
  });
  await expect(f.propose()).rejects.toThrow(/historical_source_paid/);
  expect(
    await f.t.run((ctx) => ctx.db.query("apApprovalProposals").collect()),
  ).toHaveLength(0);
});
it("rejects wrong invoice evidence and refuses to reclassify a booked payable", async () => {
  const f = await fixture(),
    d = await f.reviewed(),
    args = {
      ...f.ap,
      caseId: d.caseId,
      expectedRevision: d.revision,
      snapshotHash: d.snapshotHash,
      proof: proof(d),
    };
  await expect(
    f.t.mutation(record, { ...args, proof: { ...args.proof, amountCents: 1 } }),
  ).rejects.toThrow(/historical_identity_mismatch/);
  await f.human.mutation(refs.approve, {
    scope: f.scope,
    input: { ...f.request(d, "book"), acceptedCents: 7700 },
  });
  await expect(f.t.mutation(record, args)).rejects.toThrow(/too_late/);
});
const expected = {
  reference: "ACH-123",
  date: "2026-10-20",
  payee: "Supplier Co.",
  amountCents: 350000,
};
it("matches one complete statement transaction", () =>
  expect(
    statementPaymentMatches(
      "2026-10-20  Supplier Co.  ACH-123  $3,500.00",
      expected,
    ),
  ).toBe(true));
it.each([
  "2026-10-20 Supplier Co. ACH-123 $2,000.00\n2026-10-20 Other Co. ACH-999 $3,500.00",
  "2026-10-20 Supplier Co. ACH-1234 $3,500.00",
  "2026-10-21 Supplier Co. ACH-123 $3,500.00",
  "2026-10-20 Other Co. ACH-123 $3,500.00",
  "2026-10-20 Supplier Co. ACH-123 $3,500.00\n2026-10-20 Supplier Co. ACH-123 $3,500.00",
  "2026-10-20 Supplier Co. ACH-123 $2,000.00 $3,500.00",
])("refuses split, ambiguous or inconsistent statement matches (%s)", (text) =>
  expect(statementPaymentMatches(text, expected)).toBe(false),
);
