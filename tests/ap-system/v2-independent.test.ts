import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeFunctionReference } from "convex/server";
import { fixture as baseFixture, packet, refs } from "./accounting-fixture";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { ExecutePaymentEffect } from "../../src/payments/application/execute-payment-effect";
import { ReconcilePaymentEvidence } from "../../src/payments/application/reconcile-payment-evidence";
import { createConvexPaymentKernel } from "../../src/payments/adapters/convex-payment-kernel";
import { createConvexPaymentEvidence } from "../../src/payments/adapters/convex-payment-evidence";
import type { KernelTransport } from "../../src/payments/adapters/convex-transport";
import {
  groundText,
  providerGrounding,
  type GroundingData,
} from "../../src/ap-system/ingestion/grounding";
import {
  intakeSchema,
  type APIntake,
  type APCaseDetail,
} from "../../src/ap-system/contracts";

// Independently frozen expectations are in V2-expectations.json. Runtime does not read them.
const requestPayment = makeFunctionReference<"mutation">(
  "apCasePayments:request",
);
const authorizePayment = makeFunctionReference<"mutation">(
  "apCasePayments:authorize",
);
const cleanup: (() => void)[] = [];
const traceSources: (() => Promise<unknown>)[] = [];
const traces: unknown[] = [];
afterAll(() => {
  if (process.env.V2_EVIDENCE_PATH)
    writeFileSync(
      process.env.V2_EVIDENCE_PATH,
      JSON.stringify(traces, null, 2) + "\n",
    );
});
afterEach(async () => {
  for (const capture of traceSources.splice(0))
    traces.push({
      scenario: expect.getState().currentTestName,
      state: await capture(),
    });
  for (const fn of cleanup.splice(0)) fn();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const sourceBinding = (d: APIntake["documents"][number]) => ({
  sourceId: d.sourceId,
  revision: d.revision,
  sha256: d.sha256,
});
function originalPacket(discrepancy = false): APIntake {
  const p = packet(discrepancy ? "INV-1001-QTY" : "INV-1001");
  const sourceTemplate = p.documents[0]!;
  const fieldTemplate = p.candidate!.evidence[0]!;
  const names = [
    discrepancy ? "invoice-quantity-discrepancy" : "invoice",
    "purchase-order",
    "receipt",
    "contract",
  ];
  const kinds = ["invoice", "purchase_order", "receipt", "contract"] as const;
  p.documents = names.map((name, i) => {
    const file = resolve(
      "fixtures/ap-system/golden-state-v1/input",
      name + ".pdf",
    );
    const bytes = readFileSync(file);
    return {
      ...structuredClone(sourceTemplate),
      sourceId: "gs-" + name,
      deliveryId: "v2-delivery-" + name + (discrepancy ? "-variant" : ""),
      name: name + ".pdf",
      kind: kinds[i]!,
      originalRef: file,
      originalBase64: bytes.toString("base64"),
      sha256: hash(bytes),
      byteLength: bytes.length,
      extractedText:
        "Independent V1 source transcription supplied for state/recovery verification; no parser run.",
      provenance: {
        kind: "synthetic",
        description:
          "Real A1 synthetic PDF bytes; manually transcribed V1 facts for V2 state tests.",
        license: "Synthetic repository fixture",
        originalFilename: name + ".pdf",
      },
    };
  });
  const facts = [
    ["KALE-24", "Organic Kale, 24ct case", discrepancy ? 6 : 5, 3850],
    ["ROM-CS", "Romaine Hearts, case", 4, 4275],
    ["AVO-48", "Hass Avocados, 48ct", 3, 6890],
    ["TOM-25", "Heirloom Tomatoes, 25lb", 2, 5420],
  ] as const;
  const c = p.candidate!;
  c.invoiceNumber = discrepancy ? "INV-1001-QTY" : "INV-1001";
  c.sources = p.documents.map(sourceBinding);
  c.subtotalCents = c.totalCents = discrepancy ? 71710 : 67860;
  const fields: [string, string | number][] = [
    ["extractedSupplierName", "Golden State Produce Co."],
    ["invoiceNumber", c.invoiceNumber],
    ["invoiceDate", "2026-10-19"],
    ["totalCents", c.totalCents],
  ];
  c.lines = facts.map(([sku, description, qty, price], i) => {
    const lineId = `line-${i + 1}`,
      amount = qty * price;
    fields.push(
      [`lines.${lineId}.sku`, sku],
      [`lines.${lineId}.description`, description],
      [`lines.${lineId}.quantity`, String(qty)],
      [`lines.${lineId}.unitPriceCents`, price],
      [`lines.${lineId}.amountCents`, amount],
    );
    return {
      ...structuredClone(c.lines[0]!),
      lineId,
      sku,
      description,
      quantity: { decimal: String(qty), unit: "case" },
      unitPriceCents: price,
      amountCents: amount,
      evidenceIds: [],
      poLineId: "po-" + lineId,
      receiptLineIds: ["receipt-" + lineId],
      allocations: [{ ...c.lines[0]!.allocations[0]!, amountCents: amount }],
    };
  });
  c.evidence = fields.map(([path, value]) => ({
    ...structuredClone(fieldTemplate),
    evidenceId: "v2-" + path,
    fieldPath: path,
    rawValue: String(value),
    normalizedValue: value,
    quote: String(value),
    source: sourceBinding(p.documents[0]!),
  }));
  c.lines.forEach(
    (l) =>
      (l.evidenceIds = c.evidence
        .filter((e) => e.fieldPath.startsWith(`lines.${l.lineId}.`))
        .map((e) => e.evidenceId)),
  );
  p.extraction.evidence = c.evidence;
  p.purchasingEvidence = [1, 2, 3].map((i) => ({
    supplierId: "golden-state-produce",
    source: sourceBinding(p.documents[i]!),
    kind: kinds[i] as "purchase_order" | "receipt" | "contract",
    reference: [
      "",
      "PO-GS-20261019-001",
      "DLV-sf-hayes-valley-20261019-GOL",
      "CONTRACT-GS-2026",
    ][i]!,
    acceptedBy: i === 2 ? "Fixture Receiving Operator (simulated)" : null,
    acceptedAt: i === 2 ? "2026-10-19T10:00:00Z" : null,
    lines: c.lines.map((l, n) => ({
      lineId: (i === 1 ? "po-" : i === 2 ? "receipt-" : "contract-") + l.lineId,
      sku: l.sku!,
      quantity: { decimal: String([5, 4, 3, 2][n]), unit: "case" },
      unitPriceCents: i === 2 ? null : l.unitPriceCents,
      invoiceLineId: l.lineId,
    })),
  }));
  return intakeSchema.parse(p);
}
function revision(p: APIntake, caseId: string) {
  const next = structuredClone(p);
  next.idempotencyKey = "explicit-source-revision";
  next.explicitRevisionOf = caseId;
  next.candidate!.revision = 2;
  const s = next.documents[0]!;
  s.replaces = sourceBinding(s);
  s.revision = 2;
  s.deliveryId += "-revision-2";
  const revisedBytes = Buffer.concat([
    Buffer.from(s.originalBase64!, "base64"),
    Buffer.from("\n% V2 source revision provenance\n"),
  ]);
  s.originalBase64 = revisedBytes.toString("base64");
  s.sha256 = hash(revisedBytes);
  s.byteLength = revisedBytes.length;
  next.candidate!.sources = next.documents.map(sourceBinding);
  for (const e of next.candidate!.evidence) e.source = sourceBinding(s);
  next.extraction.evidence = next.candidate!.evidence;
  return next;
}
async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-25T12:00:00Z"));
  const f = await baseFixture();
  const dir = mkdtempSync(join(tmpdir(), "ap97-v2-"));
  const options = {
    path: join(dir, "bank.sqlite"),
    scope: f.scope,
    seed: "ap97-v2",
    startTime: new Date(Date.now()).toISOString(),
  };
  let bank = openFakeBank(options);
  cleanup.push(() => {
    bank.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = f.t as unknown as KernelTransport;
  const kernel = createConvexPaymentKernel(transport, f.scope, "test-dispatch");
  const evidence = createConvexPaymentEvidence(
    transport,
    f.scope,
    "test-evidence",
  );
  let lease = 0;
  const dispatcher = () =>
    new ExecutePaymentEffect(
      kernel,
      bank.provider,
      "v2-independent-dispatcher",
      {
        now: Date.now,
        newLeaseToken: () => `v2-independent-lease-${++lease}`,
        startHeartbeat: () => () => {},
      },
    );
  const reconciler = () =>
    new ReconcilePaymentEvidence(evidence, bank.provider, f.scope, Date.now);
  const state = () =>
    f.t.run(async (ctx) => ({
      cases: await ctx.db.query("apCaseRecords").collect(),
      bills: await ctx.db.query("demoBills").collect(),
      versions: await ctx.db.query("demoVersions").collect(),
      commands: await ctx.db.query("demoCommands").collect(),
      journals: await ctx.db.query("journalEntries").collect(),
      balances: await ctx.db.query("balances").collect(),
      heads: await ctx.db.query("ledgerHeads").collect(),
      transactions: await ctx.db.query("demoTransactions").collect(),
      observations: await ctx.db.query("demoObservations").collect(),
    }));
  traceSources.push(async () => {
    const rows = await state(),
      bankState = bank.harness.inspect();
    return {
      scope: f.scope,
      cases: rows.cases.map((c) => ({
        caseId: c._id,
        revision: c.currentRevision,
        snapshotHash: c.snapshotHash,
        billId: c.billId ?? null,
        documentStatus: c.documentStatus,
        businessStatus: c.businessStatus,
      })),
      bills: rows.bills.map((b) => ({
        billId: b._id,
        originalCents: b.originalCents,
        approvedCents: b.approvedCents ?? null,
        paidCents: b.paidCents,
        reservedVersionId: b.reservedVersionId ?? null,
      })),
      versions: rows.versions.map((v) => ({
        versionId: v._id,
        status: v.status,
        reservations: v.reservations,
        snapshotHash: v.snapshotHash,
        amountCents: v.snapshot.amountCents,
      })),
      commands: rows.commands.map((c) => ({
        effectId: c._id,
        operationId: c.command.commandId,
        idempotencyKey: c.command.idempotencyKey,
        requestHash: c.command.requestHash,
        execution: c.execution,
        posting: c.posting,
        reconciliation: c.reconciliation,
        attemptCount: c.attemptCount,
        firstAttemptAt: c.firstAttemptAt ?? null,
        providerTransferId: c.providerTransferId ?? null,
      })),
      transactions: rows.transactions.map((t) => ({
        transactionId: t.transaction.id,
        operationId: t.transaction.commandId,
        state: t.state,
        journalId: t.entryId ?? null,
      })),
      journals: rows.journals.map((j) => ({
        journalId: j._id,
        source: j.source,
        lines: j.lines,
      })),
      bank: {
        calls: bankState.calls,
        transfers: bankState.transfers.map((t) => ({
          transferId: t.id,
          operationId: t.commandId,
          idempotencyKey: t.idempotencyKey,
          requestHash: t.requestHash,
          amountCents: t.amountCents,
          status: t.status,
          originalTransactionId: t.originalTransactionId ?? null,
        })),
      },
    };
  });
  const ingest = async (p = originalPacket()) => {
    const result = await f.t.mutation(refs.ingest, { ...f.ap, input: p });
    return f.get(result.caseId);
  };
  const review = async (d: APCaseDetail, key = "field-review") => {
    await f.human.mutation(refs.review, {
      scope: f.scope,
      input: f.request(d, key),
    });
    return f.get(d.caseId);
  };
  const approve = async (d: APCaseDetail) => {
    await f.human.mutation(refs.approve, {
      scope: f.scope,
      input: {
        ...f.request(d, "business-approval"),
        acceptedCents: d.candidate!.totalCents,
      },
    });
    return f.get(d.caseId);
  };
  const recognized = async () => approve(await review(await ingest()));
  const bind = (d: APCaseDetail) => ({
    scope: f.scope,
    caseId: d.caseId,
    expectedRevision: d.revision,
    snapshotHash: d.snapshotHash,
  });
  const prepare = (d: APCaseDetail, key = "v2-payment") =>
    f.t.mutation(requestPayment, {
      ...bind(d),
      seatId: "payments",
      token: "token-payments",
      idempotencyKey: key,
    });
  const authorize = (
    d: APCaseDetail,
    p: { versionId: string; snapshotHash: string },
  ) =>
    f.human.mutation(authorizePayment, {
      ...bind(d),
      versionId: p.versionId,
      paymentSnapshotHash: p.snapshotHash,
    });
  return {
    ...f,
    state,
    ingest,
    review,
    approve,
    recognized,
    bind,
    prepare,
    authorize,
    dispatcher,
    reconciler,
    evidence,
    get bank() {
      return bank;
    },
    restartBank() {
      bank.close();
      bank = openFakeBank(options);
    },
  };
}
describe("V2 independent actual AP mutations through FakeBank recovery", () => {
  it.each([
    "missing_receipt",
    "contradictory_content",
    "quantity_conflict",
  ] as const)(
    "holds %s without creating an obligation or bank operation",
    async (scenario) => {
      const f = await fixture();
      const p = originalPacket(scenario === "quantity_conflict");
      if (scenario === "missing_receipt") {
        p.documents = p.documents.filter((d) => d.kind !== "receipt");
        p.candidate!.sources = p.documents.map(sourceBinding);
        p.purchasingEvidence = p.purchasingEvidence.filter(
          (e) => e.kind !== "receipt",
        );
      }
      if (scenario === "contradictory_content")
        p.candidate!.evidence[0]!.contentStatus = "conflicting";
      let d = await f.ingest(p);
      if (scenario === "contradictory_content")
        await expect(f.review(d)).rejects.toThrow(/Incomplete\/conflicting/);
      else {
        d = await f.review(d);
        expect(d.exceptions.map((e) => e.code)).toEqual(
          expect.arrayContaining(
            scenario === "missing_receipt"
              ? ["missing_receipt"]
              : ["po_mismatch", "receipt_mismatch"],
          ),
        );
        await expect(f.approve(d)).rejects.toThrow(
          /missing_receipt|po_mismatch/,
        );
      }
      expect(d.amounts.invoicedCents).toBe(
        scenario === "quantity_conflict" ? 71710 : 67860,
      );
      expect(d.amounts.acceptedCents).toBeNull();
      await expect(f.prepare(d)).rejects.toThrow();
      const rows = await f.state();
      expect([
        rows.bills.length,
        rows.commands.length,
        rows.journals.length,
        f.bank.harness.inspect().transfers.length,
      ]).toEqual([0, 0, 0, 0]);
    },
  );
  it("preserves one economic effect across renamed duplicate deliveries, retries and duplicate bank observations", async () => {
    const f = await fixture();
    const d = await f.recognized();
    const p = await f.prepare(d);
    expect(await f.prepare(d)).toEqual(p);
    await f.authorize(d, p);
    await f.authorize(d, p);
    const duplicate = originalPacket();
    duplicate.idempotencyKey = "renamed-delivery";
    duplicate.documents.forEach((s) => {
      s.name = "renamed-" + s.name;
      s.deliveryId = "copy-" + s.deliveryId;
    });
    expect((await f.ingest(duplicate)).caseId).toBe(d.caseId);
    expect((await f.ingest(duplicate)).caseId).toBe(d.caseId);
    const sent = await f.dispatcher().tick();
    expect(sent.providerTransferId).toBeTruthy();
    const settled = f.bank.harness.settle(sent.providerTransferId!);
    const tx = await f.bank.provider.getTransaction(
      f.scope,
      settled.originalTransactionId!,
    );
    await f.evidence.observeTransfer({
      observation: settled,
      transactions: [tx],
    });
    await f.evidence.observeTransfer({
      observation: settled,
      transactions: [tx],
    });
    expect(await f.reconciler().tick()).toEqual({ posted: 1, errors: [] });
    expect(await f.reconciler().tick()).toEqual({ posted: 0, errors: [] });
    const rows = await f.state();
    expect([
      rows.cases.length,
      rows.bills.length,
      rows.versions.length,
      rows.commands.length,
      rows.journals.length,
      rows.transactions.length,
      f.bank.harness.inspect().transfers.length,
    ]).toEqual([1, 1, 1, 1, 2, 1, 1]);
    expect(rows.commands[0]).toMatchObject({
      execution: "settled",
      posting: "posted",
      reconciliation: "matched",
    });
    expect(rows.bills[0]!.paidCents).toBe(67860);
    expect(
      rows.journals.flatMap((j) => j.lines).filter((l) => l.account === "1000"),
    ).toEqual([{ account: "1000", debit: 0, credit: 67860 }]);
  });
  it("does not merge a different original invoice merely because its filename is unchanged", async () => {
    const f = await fixture();
    const first = await f.ingest();
    const different = originalPacket(true);
    different.idempotencyKey = "same-name-different-source";
    different.documents[0]!.name = "invoice.pdf";
    const second = await f.ingest(different);
    expect(second.caseId).not.toBe(first.caseId);
    expect(second.currentSourceBindings[0]!.sha256).not.toBe(
      first.currentSourceBindings[0]!.sha256,
    );
    expect((await f.state()).cases).toHaveLength(2);
    expect((await f.state()).bills).toHaveLength(0);
  });
  it("invalidates an old review on revision and permits only a fresh complete source-bound review", async () => {
    const f = await fixture();
    const d = await f.review(await f.ingest());
    const next = await f.ingest(revision(originalPacket(), d.caseId));
    await expect(f.approve(d)).rejects.toThrow(/current case revision/);
    await expect(f.approve(next)).rejects.toThrow(
      /separate authenticated review/,
    );
    expect(next.sources.length).toBe(5);
    expect(next.currentSourceBindings.length).toBe(4);
    const fresh = await f.approve(await f.review(next, "fresh-review"));
    expect(fresh.amounts.acceptedCents).toBe(67860);
    expect((await f.state()).journals).toHaveLength(1);
    expect((await f.state()).commands).toHaveLength(0);
  });
  it.each(["prepared", "queued"] as const)(
    "cancels %s unsent payment on source revision and blocks stale authorization",
    async (stage) => {
      const f = await fixture();
      const d = await f.recognized();
      const p = await f.prepare(d);
      if (stage === "queued") await f.authorize(d, p);
      await f.ingest(revision(originalPacket(), d.caseId));
      await expect(f.authorize(d, p)).rejects.toThrow(/Stale/);
      expect(await f.dispatcher().tick()).toEqual({ dispatched: false });
      const rows = await f.state();
      expect(rows.versions[0]).toMatchObject({
        status: "cancelled",
        reservations: "released",
      });
      expect(rows.bills[0]!.reservedVersionId).toBeUndefined();
      if (stage === "queued")
        expect(rows.commands[0]).toMatchObject({
          execution: "cancelled",
          attemptCount: 0,
        });
      expect(f.bank.harness.inspect().transfers).toHaveLength(0);
    },
  );
  it("recovers a lost response after a possible-send source revision without changing the original key or reservation", async () => {
    const f = await fixture();
    const d = await f.recognized();
    const p = await f.prepare(d);
    await f.authorize(d, p);
    const original = (await f.state()).commands[0]!.command;
    expect(original.idempotencyKey).toBe(`demo:${p.versionId}`);
    f.bank.harness.scheduleFault({
      operation: "createTransfer",
      call: 1,
      kind: "accept_then_lost_response",
    });
    expect(await f.dispatcher().tick()).toMatchObject({ error: "transport" });
    expect(f.bank.harness.inspect().transfers).toHaveLength(1);
    const changed = await f.ingest(revision(originalPacket(), d.caseId));
    await expect(f.prepare(changed, "replacement")).rejects.toThrow();
    await expect(
      f.human.mutation(api.demoPayments.cancel, {
        scope: f.scope,
        versionId: p.versionId,
      }),
    ).rejects.toThrow();
    await expect(f.review(changed, "cannot-reapprove-posted")).rejects.toThrow(
      /correction/,
    );
    const before = await f.state();
    expect(before.versions[0]!.reservations).toBe("reserved");
    expect(before.bills[0]!.reservedVersionId).toBe(p.versionId);
    expect(before.commands[0]!.command).toEqual(original);
    f.restartBank();
    vi.setSystemTime(before.commands[0]!.nextAttemptAt + 1);
    const recovered = await f.dispatcher().tick();
    expect(recovered.providerTransferId).toBe(
      f.bank.harness.inspect().transfers[0]!.id,
    );
    expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
    expect((await f.state()).commands[0]!.command).toEqual(original);
    expect((await f.state()).commands[0]!.firstAttemptAt).toBe(
      before.commands[0]!.firstAttemptAt,
    );
    f.bank.harness.settle(recovered.providerTransferId!);
    expect(await f.reconciler().tick()).toEqual({ posted: 1, errors: [] });
    expect((await f.state()).journals).toHaveLength(2);
  });
  it("retains settled evidence through interrupted local posting, then posts once without resending", async () => {
    const f = await fixture();
    const d = await f.recognized();
    const p = await f.prepare(d);
    await f.authorize(d, p);
    const sent = await f.dispatcher().tick();
    f.bank.harness.settle(sent.providerTransferId!);
    const bill = (await f.state()).bills[0]!;
    await f.t.run((ctx) =>
      ctx.db.patch(bill._id, { reservedVersionId: undefined }),
    );
    const before = await f.state();
    const failed = await f.reconciler().tick();
    expect(failed.posted).toBe(0);
    expect(failed.errors.join(" ")).toContain("reservation ownership");
    const rows = await f.state();
    expect(rows.journals).toEqual(before.journals);
    expect(rows.balances).toEqual(before.balances);
    expect(rows.heads).toEqual(before.heads);
    expect(rows.commands[0]).toMatchObject({
      execution: "settled",
      posting: "unposted",
    });
    expect(rows.transactions[0]!.entryId).toBeUndefined();
    expect(await f.dispatcher().tick()).toEqual({ dispatched: false });
    await f.t.run((ctx) =>
      ctx.db.patch(bill._id, {
        reservedVersionId: p.versionId as Id<"demoVersions">,
      }),
    );
    expect(await f.reconciler().tick()).toEqual({ posted: 1, errors: [] });
    expect(await f.reconciler().tick()).toEqual({ posted: 0, errors: [] });
    expect((await f.state()).journals).toHaveLength(2);
    expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
  });
  it("rejects anonymous/agent and foreign human authorization, stale snapshots and self-review", async () => {
    const f = await fixture();
    const d = await f.recognized();
    const p = await f.prepare(d);
    const args = {
      ...f.bind(d),
      versionId: p.versionId,
      paymentSnapshotHash: p.snapshotHash,
    };
    await expect(f.t.mutation(authorizePayment, args)).rejects.toThrow(/human/);
    const foreign = f.t.withIdentity({
      issuer: "https://foreign.invalid",
      subject: "reviewer",
      tokenIdentifier: "https://foreign.invalid|reviewer",
    });
    await expect(foreign.mutation(authorizePayment, args)).rejects.toThrow(
      /human/,
    );
    await expect(
      f.human.mutation(authorizePayment, {
        ...args,
        paymentSnapshotHash: "a".repeat(64),
      }),
    ).rejects.toThrow(/Stale/);
    expect((await f.state()).commands).toHaveLength(0);
    const other = await f.ingest(originalPacket(true));
    await f.t.run((ctx) =>
      ctx.db.patch(other.caseId as Id<"apCaseRecords">, {
        createdBy: "human_cfo",
      }),
    );
    await expect(f.review(other, "self-review")).rejects.toThrow(/creator/);
  });
});
describe("V2 independent geometry negative and fallback-retry checks", () => {
  function data(): GroundingData {
    const processor =
      originalPacket().candidate!.evidence[0]!.grounding.processor;
    return {
      processor,
      pages: [
        {
          number: 1,
          complete: true,
          rotation: 0,
          frame: {
            width: 612,
            height: 792,
            units: "point",
            origin: "top_left",
            rotation: 0,
            transform: [1, 0, 0, 1, 0, 0],
          },
        },
      ],
      native: [],
      words: [
        {
          id: "kale-word",
          text: "Kale",
          page: 1,
          line: "line1",
          box: { x: 20, y: 30, width: 30, height: 10 },
        },
      ],
    };
  }
  it("does not accept a precise location on the wrong page or in an invalid frame", async () => {
    const d = data();
    expect((await groundText("Kale", d, { page: 2 })).status).toBe(
      "unresolved",
    );
    d.words[0]!.box.x = 9999;
    expect((await groundText("Kale", d)).status).toBe("unresolved");
  });
  it("rejects provider geometry whose page dimensions disagree with the retained original frame", async () => {
    const source = data();
    const parsed = providerGrounding({
      reused: false,
      result: {
        items: {
          pages: [
            {
              page_number: 1,
              page_width: 800,
              page_height: 600,
              success: true,
            },
          ],
        },
        __apOriginalFrames: [
          { page: 1, width: 612, height: 792, units: "point", rotation: 0 },
        ],
      },
      grounded: [],
      rawWords: [
        {
          page_number: 1,
          raw_words: [{ str: "Kale", x: 20, y: 30, w: 30, h: 10 }],
        },
      ],
      processor: source.processor,
    } as Parameters<typeof providerGrounding>[0]);
    const fallback = vi.fn(async () => data());
    expect(
      await groundText("Kale", parsed, { localOcr: fallback }),
    ).toMatchObject({
      status: "unresolved",
      regions: [],
      failureReason: "unsupported_source_transform",
    });
    expect(fallback).not.toHaveBeenCalled();
  });
  it("preserves mismatch/ambiguity and retries an interrupted fallback without fabricated geometry", async () => {
    const d = data();
    d.words[0]!.text = "Ka1e";
    expect((await groundText("Kale", d)).regions).toEqual([]);
    const failed = await groundText("Kale", d, {
      localOcr: async () => {
        throw Error("ocr_process_timeout");
      },
    });
    expect(failed).toMatchObject({
      status: "unresolved",
      regions: [],
      failureReason: "ocr_process_timeout",
    });
    const retried = await groundText("Kale", d, {
      localOcr: async () => data(),
    });
    expect(retried).toMatchObject({
      status: "derived",
      method: "local_ocr_exact",
    });
    const duplicate = data();
    duplicate.words.push({
      ...duplicate.words[0]!,
      id: "second-kale",
      box: { x: 60, y: 30, width: 30, height: 10 },
    });
    expect((await groundText("Kale", duplicate)).failureReason).toBe(
      "ambiguous_exact_text",
    );
  });
  it("rejects stale precise evidence source revision at intake before any case is stored", async () => {
    const f = await fixture();
    const p = originalPacket();
    const g = data();
    g.native = [
      {
        text: "Golden State Produce Co.",
        page: 1,
        regions: [
          {
            x: 10,
            y: 10,
            width: 100,
            height: 20,
            granularity: "line",
            tokenRefs: [],
          },
        ],
      },
    ];
    p.candidate!.evidence[0]!.grounding = await groundText(
      "Golden State Produce Co.",
      g,
    );
    expect(p.candidate!.evidence[0]!.grounding.status).toBe("native");
    p.candidate!.evidence[0]!.source.revision = 2;
    await expect(f.ingest(p)).rejects.toThrow(/binding/);
    expect((await f.state()).cases).toHaveLength(0);
  });
});
