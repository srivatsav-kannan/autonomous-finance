import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  caseDetailSchema,
  sourceDocumentSchema,
} from "../../src/ap-system/contracts";
import { fixture, packet, refs } from "./accounting-fixture";
afterEach(() => vi.unstubAllEnvs());
describe("source -> field review -> obligation recognition", () => {
  it("requires separate authenticated decisions and posts the same case once on replay", async () => {
    const f = await fixture();
    const input = packet();
    input.candidate!.sources = input.candidate!.sources.slice(0, 1);
    const r = await f.t.mutation(refs.ingest, { ...f.ap, input });
    const first = await f.get(r.caseId);
    expect(first.amounts.acceptedCents).toBeNull();
    expect(first.states.authorization).toBe("not_requested");
    await expect(
      f.human.mutation(refs.approve, {
        scope: f.scope,
        input: { ...f.request(first), acceptedCents: 7700 },
      }),
    ).rejects.toThrow("separate authenticated review");
    await expect(
      f.t.mutation(refs.review, { scope: f.scope, input: f.request(first) }),
    ).rejects.toThrow("authenticated human");
    await f.human.mutation(refs.review, {
      scope: f.scope,
      input: f.request(first),
    });
    const request = { ...f.request(first, "bill"), acceptedCents: 7700 };
    const approved = await f.human.mutation(refs.approve, {
      scope: f.scope,
      input: request,
    });
    expect(
      await f.human.mutation(refs.approve, { scope: f.scope, input: request }),
    ).toEqual(approved);
    expect(
      await f.human.mutation(refs.approve, {
        scope: f.scope,
        input: { ...request, idempotencyKey: "same-approved-obligation" },
      }),
    ).toEqual(approved);
    const state = await f.get(r.caseId);
    expect(caseDetailSchema.safeParse(state).success).toBe(true);
    expect(state.links.billId).toBe(approved.billId);
    expect(state.decisions.map((d) => d.kind)).toEqual([
      "field_review",
      "bill_approval",
    ]);
    expect(state.states).toMatchObject({
      document: "reviewed",
      business: "approved",
      accounting: "recognized",
      authorization: "not_requested",
      execution: "not_started",
    });
    expect(state.journals[0]!.lines).toEqual([
      { account: "5000", debit: 7700, credit: 0 },
      { account: "2000", debit: 0, credit: 7700 },
    ]);
    const count = await f.t.run(async (ctx) => ({
      bills: (await ctx.db.query("demoBills").collect()).length,
      journals: (await ctx.db.query("journalEntries").collect()).length,
      commands: (await ctx.db.query("demoCommands").collect()).length,
    }));
    expect(count).toEqual({ bills: 1, journals: 1, commands: 0 });
  });
  it("keeps renamed duplicates on the original obligation and hides private artifact paths", async () => {
    const f = await fixture();
    const d = await f.reviewed();
    await f.human.mutation(refs.approve, {
      scope: f.scope,
      input: { ...f.request(d, "bill"), acceptedCents: 7700 },
    });
    const p = packet();
    p.idempotencyKey = "renamed";
    p.documents = p.documents.map((s) => ({
      ...s,
      name: `renamed-${s.name}`,
      deliveryId: `renamed-${s.deliveryId}`,
    }));
    const result = await f.t.mutation(refs.ingest, { ...f.ap, input: p });
    expect(result.caseId).toBe(d.caseId);
    expect(result.duplicate).toBe(true);
    const state = await f.get(d.caseId);
    expect(JSON.stringify(state)).not.toContain("/private/ap/");
    expect(state.sources.every((s) => !s.originalBase64)).toBe(true);
    expect(state.journals).toHaveLength(1);
    expect(
      state.timeline.filter((e) => e.kind === "source_delivery"),
    ).toHaveLength(6);
  });
  it("validates original bytes, exact source serving and scope", async () => {
    const f = await fixture();
    const p = packet();
    p.documents[0]!.sha256 = "f".repeat(64);
    p.candidate!.sources[0]!.sha256 = p.documents[0]!.sha256;
    p.candidate!.evidence.forEach(
      (e) => (e.source.sha256 = p.documents[0]!.sha256),
    );
    p.extraction.evidence = p.candidate!.evidence;
    await expect(
      f.t.mutation(refs.ingest, { ...f.ap, input: p }),
    ).rejects.toThrow("Original bytes");
    const good = packet();
    await f.t.mutation(refs.ingest, { ...f.ap, input: good });
    const s = good.documents[0]!;
    const data = await f.t.query(refs.source, {
      ...f.ap,
      sourceId: s.sourceId,
      revision: 1,
      sha256: s.sha256,
    });
    expect(data.originalBase64).toBe(s.originalBase64);
    expect(sourceDocumentSchema.safeParse(data).success).toBe(true);
    expect(data).toMatchObject({
      sourceId: s.sourceId,
      revision: s.revision,
      pageCount: s.pageCount,
      pageStatus: s.pageStatus,
      parser: s.parser,
      provenance: s.provenance,
    });
    await expect(
      f.t.query(refs.source, {
        ...f.ap,
        sourceId: s.sourceId,
        revision: 1,
        sha256: "f".repeat(64),
      }),
    ).rejects.toThrow("Exact original");
    await expect(
      f.t.query(refs.source, {
        ...f.ap,
        scope: { ...f.scope, organizationId: "other" },
        sourceId: s.sourceId,
        revision: 1,
        sha256: s.sha256,
      }),
    ).rejects.toThrow("mismatch");
  });
  it("keeps failed/incomplete cases in the denominator with unknown amount", async () => {
    const f = await fixture();
    const p = packet();
    p.candidate = null;
    p.extraction = {
      status: "failed",
      evidence: [],
      reasons: ["provider failed"],
    };
    p.documents[0]!.pageStatus[0]!.status = "failed";
    const r = await f.t.mutation(refs.ingest, { ...f.ap, input: p });
    const d = await f.get(r.caseId);
    expect(d.candidate).toBeNull();
    expect(d.amounts.invoicedCents).toBeNull();
    expect(d.states.document).toBe("failed");
    expect(await f.t.query(refs.list, f.ap)).toHaveLength(1);
    await expect(
      f.human.mutation(refs.review, { scope: f.scope, input: f.request(d) }),
    ).rejects.toThrow("Incomplete/conflicting");
  });
  it("holds missing receipts after field review and refuses unilateral short-pay", async () => {
    const f = await fixture();
    const p = packet();
    p.purchasingEvidence = p.purchasingEvidence.filter(
      (e) => e.kind !== "receipt",
    );
    const d = await f.reviewed(p);
    await expect(
      f.human.mutation(refs.approve, {
        scope: f.scope,
        input: { ...f.request(d, "bill"), acceptedCents: 7700 },
      }),
    ).rejects.toThrow("missing_receipt");
    await expect(
      f.human.mutation(refs.approve, {
        scope: f.scope,
        input: { ...f.request(d, "short-pay"), acceptedCents: 5000 },
      }),
    ).rejects.toThrow("adjustments need");
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(0);
  });
  it("invalidates stale review on explicit source revision and preserves historical decisions", async () => {
    const f = await fixture();
    const d = await f.reviewed();
    const p = packet();
    p.explicitRevisionOf = d.caseId;
    p.idempotencyKey = "revision";
    p.candidate!.revision = 2;
    const invoice = p.documents[0]!;
    invoice.replaces = {
      sourceId: invoice.sourceId,
      revision: invoice.revision,
      sha256: invoice.sha256,
    };
    invoice.revision = 2;
    invoice.deliveryId = "revised-invoice-delivery";
    p.candidate!.sources[0]!.revision = 2;
    p.candidate!.evidence.forEach((e) => (e.source.revision = 2));
    const r = await f.t.mutation(refs.ingest, { ...f.ap, input: p });
    expect(r.revision).toBe(2);
    await expect(
      f.human.mutation(refs.approve, {
        scope: f.scope,
        input: { ...f.request(d, "old-bill"), acceptedCents: 7700 },
      }),
    ).rejects.toThrow("current case revision");
    const next = await f.get(d.caseId);
    expect(next.decisions).toHaveLength(1);
    expect(next.sources).toHaveLength(4);
    expect(next.currentSourceBindings).toHaveLength(3);
    expect(
      next.currentSourceBindings
        .filter((s) => s.sourceId === invoice.sourceId)
        .map((s) => s.revision),
    ).toEqual([2]);
    expect(next.states.document).toBe("review_required");
    await expect(
      f.human.mutation(refs.approve, {
        scope: f.scope,
        input: { ...f.request(next, "new-bill"), acceptedCents: 7700 },
      }),
    ).rejects.toThrow("separate authenticated review");
  });
  it("rolls back bill creation if the accounting period is closed", async () => {
    const f = await fixture();
    const d = await f.reviewed();
    await f.t.run(async (ctx) => {
      const period = await ctx.db.query("periods").first();
      await ctx.db.patch(period!._id, { status: "closed" });
    });
    await expect(
      f.human.mutation(refs.approve, {
        scope: f.scope,
        input: { ...f.request(d, "bill"), acceptedCents: 7700 },
      }),
    ).rejects.toThrow("closed");
    expect(
      await f.t.run((ctx) => ctx.db.query("demoBills").collect()),
    ).toHaveLength(0);
  });
  it("does not let legacy acceptance erase AP evidence policy", async () => {
    const f = await fixture();
    const d = await f.reviewed();
    const approved = await f.human.mutation(refs.approve, {
      scope: f.scope,
      input: { ...f.request(d, "bill"), acceptedCents: 7700 },
    });
    await expect(
      f.human.mutation(api.demoPayments.humanAcceptBill, {
        scope: f.scope,
        billId: approved.billId,
        approvedCents: 7700,
      }),
    ).rejects.toThrow("versioned case");
  });
  it("does not recognize the same received units against a second invoice", async () => {
    const f = await fixture();
    const first = packet();
    const d = await f.reviewed(first);
    await f.human.mutation(refs.approve, {
      scope: f.scope,
      input: { ...f.request(d, "bill-1"), acceptedCents: 7700 },
    });
    const revised = packet();
    revised.explicitRevisionOf = d.caseId;
    revised.idempotencyKey = "recognition-preserves-receipt";
    revised.candidate!.revision = 2;
    revised.purchasingEvidence = revised.purchasingEvidence.filter(
      (p) => p.kind !== "receipt",
    );
    await f.t.mutation(refs.ingest, { ...f.ap, input: revised });
    const second = packet("GS-1043");
    second.documents[2] = {
      ...first.documents[2]!,
      deliveryId: "resend-shared-receipt",
    };
    second.candidate!.sources[2] = { ...first.candidate!.sources[2]! };
    second.purchasingEvidence[1] = { ...first.purchasingEvidence[1]! };
    const r = await f.t.mutation(refs.ingest, { ...f.ap, input: second });
    const next = await f.get(r.caseId);
    await f.human.mutation(refs.review, {
      scope: f.scope,
      input: f.request(next, "review-2"),
    });
    await expect(
      f.human.mutation(refs.approve, {
        scope: f.scope,
        input: { ...f.request(next, "bill-2"), acceptedCents: 7700 },
      }),
    ).rejects.toThrow("another recognized obligation");
    expect(
      await f.t.run((ctx) => ctx.db.query("demoBills").collect()),
    ).toHaveLength(1);
  });
  it.each([false, true])(
    "source revision cancels only unsent requests (attempted=%s)",
    async (attempted) => {
      const f = await fixture();
      const d = await f.reviewed();
      const approved = await f.human.mutation(refs.approve, {
        scope: f.scope,
        input: { ...f.request(d, "bill"), acceptedCents: 7700 },
      });
      const request = await f.t.mutation(api.demoPayments.requestPayment, {
        scope: f.scope,
        seatId: "payments",
        token: "token-payments",
        requestKey: "pay-case",
        billIds: [approved.billId],
        credits: [],
      });
      const queued = await f.human.mutation(api.demoPayments.approveAndQueue, {
        scope: f.scope,
        ...request,
      });
      if (attempted)
        await f.t.mutation(api.demoPayments.claim, {
          scope: f.scope,
          token: "test-dispatch",
          paymentExecutorVersion: "scoped-ap-v2",
          workerId: "worker",
          leaseToken: "lease-proof-123456789",
        });
      const before = await f.t.run((ctx) => ctx.db.get(queued.commandId));
      const p = packet();
      p.explicitRevisionOf = d.caseId;
      p.idempotencyKey = "revised-evidence";
      p.candidate!.revision = 2;
      await f.t.mutation(refs.ingest, { ...f.ap, input: p });
      const state = await f.t.run(async (ctx) => ({
        command: await ctx.db.get(queued.commandId),
        version: await ctx.db.get(request.versionId),
        bill: await ctx.db.get(approved.billId as Id<"demoBills">),
      }));
      expect(state.command!.command).toEqual(before!.command);
      expect(state.bill!.flags).toContain("ap_case_revision_requires_review");
      expect(state.command!.execution).toBe(
        attempted ? "in_flight" : "cancelled",
      );
      expect(state.version!.reservations).toBe(
        attempted ? "reserved" : "released",
      );
      expect(state.bill!.reservedVersionId).toBe(
        attempted ? request.versionId : undefined,
      );
    },
  );
  it("does not identify unrelated originals by filename", async () => {
    const f = await fixture();
    const a = packet();
    const b = packet("GS-2042");
    b.documents[0]!.name = a.documents[0]!.name;
    const x = await f.t.mutation(refs.ingest, { ...f.ap, input: a });
    const y = await f.t.mutation(refs.ingest, { ...f.ap, input: b });
    expect(x.caseId).not.toBe(y.caseId);
    expect(await f.t.query(refs.list, f.ap)).toHaveLength(2);
  });
  it("stores a multi-chunk original once and rejects silent metadata replacement", async () => {
    const f = await fixture();
    const p = packet();
    const source = p.documents[0]!;
    const bytes = Buffer.from(source.extractedText + " ".repeat(1_200_000));
    source.originalBase64 = bytes.toString("base64");
    source.byteLength = bytes.length;
    source.sha256 = createHash("sha256").update(bytes).digest("hex");
    p.candidate!.sources[0]!.sha256 = source.sha256;
    p.candidate!.evidence.forEach((e) => (e.source.sha256 = source.sha256));
    p.extraction.evidence = p.candidate!.evidence;
    await f.t.mutation(refs.ingest, { ...f.ap, input: p });
    const stored = await f.t.run(async (ctx) => ({
      cases: await ctx.db.query("apCaseRecords").collect(),
      revisions: await ctx.db.query("apCaseRevisions").collect(),
      sources: await ctx.db.query("apCaseSources").collect(),
      chunks: await ctx.db.query("apCaseSourceChunks").collect(),
    }));
    expect(stored.chunks.length).toBeGreaterThan(6);
    expect(
      JSON.stringify([stored.cases, stored.revisions, stored.sources]),
    ).not.toContain(source.originalBase64);
    const original = await f.t.query(refs.source, {
      ...f.ap,
      sourceId: source.sourceId,
      revision: 1,
      sha256: source.sha256,
    });
    expect(original.originalBase64).toBe(source.originalBase64);
    const changed = structuredClone(p);
    changed.idempotencyKey = "silent-reparse";
    changed.documents[0]!.extractedText = "different interpretation";
    await expect(
      f.t.mutation(refs.ingest, { ...f.ap, input: changed }),
    ).rejects.toThrow("immutable per revision");
  });
  it("rejects changed idempotency payload and a partial review evidence set", async () => {
    const f = await fixture();
    const p = packet();
    const r = await f.t.mutation(refs.ingest, { ...f.ap, input: p });
    const changed = structuredClone(p);
    changed.documents[0]!.name = "different-name.pdf";
    await expect(
      f.t.mutation(refs.ingest, { ...f.ap, input: changed }),
    ).rejects.toThrow("different input");
    const d = await f.get(r.caseId);
    await expect(
      f.human.mutation(refs.review, {
        scope: f.scope,
        input: { ...f.request(d), evidenceIds: [] },
      }),
    ).rejects.toThrow("all candidate field evidence");
  });
  it("blocks stale self-approval and cross-source review bindings", async () => {
    const f = await fixture();
    const d = await f.reviewed();
    await expect(
      f.human.mutation(refs.approve, {
        scope: f.scope,
        input: {
          ...f.request(d, "wrong-source"),
          sourceBindings: [
            { ...d.candidate!.sources[0]!, sha256: "f".repeat(64) },
          ],
          acceptedCents: 7700,
        },
      }),
    ).rejects.toThrow("every source version");
    await f.t.run(async (ctx) => {
      const row = await ctx.db.query("apCaseRecords").first();
      await ctx.db.patch(row!._id, { createdBy: "human_cfo" });
    });
    await expect(
      f.human.mutation(refs.approve, {
        scope: f.scope,
        input: { ...f.request(d, "self"), acceptedCents: 7700 },
      }),
    ).rejects.toThrow("own obligation");
  });
});
