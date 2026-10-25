import { createHash } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import type { ContactChangeProposal } from "../../src/ap-system/supplier-contact-contracts";
import { api } from "../../convex/_generated/api";
import { currentSupplier } from "../../convex/lib/apSystem/businessAuthority";
import { PAYMENT_EXECUTOR_VERSION } from "../../src/payments/contracts";
import { packet, refs } from "./accounting-fixture";
import {
  businessFixture,
  binding,
  policy,
  subject,
  cr,
  acceptance,
} from "./business-fixture";
const ref = (name: string) =>
  makeFunctionReference<"mutation">(`apSupplierContacts:${name}`);
const view = makeFunctionReference<"query">("apSupplierContacts:view");
afterEach(() => vi.unstubAllEnvs());
async function setup(options: { escalation?: boolean; origin?: boolean } = {}) {
  const p = policy();
  p.groups.find((g) => g.groupId === "verify")!.members.push(subject("second"));
  if (options.escalation !== false)
    p.supplierContactEscalationGroup = "escalation";
  const input = packet(),
    directory = structuredClone(input.documents[1]!);
  const body =
    "Executed vendor agreement, Golden State Produce, independently retained phone +14155550999";
  Object.assign(directory, {
    sourceId: "contact-directory",
    name: "contact-directory.txt",
    kind: "contract",
    deliveryId: "contact-directory",
    mimeType: "text/plain",
    originalBase64: Buffer.from(body).toString("base64"),
    extractedText: body,
    byteLength: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  input.documents.push(directory);
  const f = await businessFixture({ policy: p, input });
  const source = [binding(directory)];
  const registered = await f.humans.second!.mutation(
    cr.registerTrustedContact!,
    {
      scope: f.scope,
      idempotencyKey: "replacement-source",
      supplierId: f.supplier.supplierId,
      phone: "+14155550999",
      evidence: source,
      mode: "simulated",
      ...(options.origin !== false
        ? {
            origin: {
              kind: "executed_agreement",
              acquiredAt: Date.now(),
              description:
                "Independent original agreement, synthetic test; no phone call performed",
            },
          }
        : {}),
    },
  );
  const proposal: ContactChangeProposal = {
    supplierId: f.supplier.supplierId,
    expectedRevision: 1,
    oldContactId: f.supplier.contactId,
    newContactId: registered.contactId,
    resolution: "replace",
    oldChannel: {
      status: "available",
      evidence: f.proof,
      reason: "Previously held channel available for independent verification",
    },
    reason: "Documented contact succession; destination remains unchanged",
  };
  const propose = (value = proposal, key = "replace") =>
    f.t.mutation(ref("propose"), {
      ...f.controller,
      idempotencyKey: key,
      proposal: value,
    });
  async function review(
    change: { changeId: string; hash: string },
    kind = "verify",
    name = kind === "verify" ? "verifier" : "escalation",
    patch: Record<string, unknown> = {},
  ) {
    const row = await f.t.run((ctx) =>
      ctx.db.get(change.changeId as Id<"apSupplierContactChanges">),
    );
    const method =
      kind === "escalate" ||
      (row!.proposal.oldChannel.status === "unavailable" &&
        row!.proposal.resolution !== "retain_current")
        ? "independent_reestablishment"
        : "old_channel_confirmation";
    return f.humans[name]!.mutation(ref(kind), {
      scope: f.scope,
      changeId: change.changeId,
      expectedHash: change.hash,
      attestation: {
        method,
        performedAt: row!.createdAt,
        evidence: source,
        mode: "simulated",
        reason:
          "Synthetic recorded review; software did not call or message anyone",
        ...patch,
      },
    });
  }
  const decide = (
    change: { changeId: string; hash: string },
    outcome = "approved",
    name = "governor",
  ) =>
    f.humans[name]!.mutation(ref("decide"), {
      scope: f.scope,
      input: {
        changeId: change.changeId,
        expectedHash: change.hash,
        outcome,
        reason: "Exact source and separate recorded reviewers checked",
      },
    });
  return {
    ...f,
    source,
    registered,
    proposal,
    proposeChange: propose,
    reviewChange: review,
    decideChange: decide,
  };
}
async function retire(f: Awaited<ReturnType<typeof setup>>, name: string) {
  await f.t.run(async (ctx) => {
    const seat = await ctx.db
      .query("seats")
      .withIndex("by_run_seat", (q) =>
        q.eq("runId", f.scope.runId).eq("seatId", `human-${name}`),
      )
      .unique();
    await ctx.db.patch(seat!._id, { status: "retired" });
  });
}
async function replace(
  f: Awaited<ReturnType<typeof setup>>,
  unavailable = false,
) {
  const c = await f.proposeChange({
    ...f.proposal,
    oldChannel: {
      ...f.proposal.oldChannel,
      status: unavailable ? "unavailable" : "available",
    },
  });
  await f.reviewChange(c);
  if (unavailable) await f.reviewChange(c, "escalate");
  await f.decideChange(c);
  return c;
}
describe("E03 governed trusted contact replacement", () => {
  it("replaces contact only, requires a fresh supplier callback/approval, and preserves immutable source and supplier history", async () => {
    const f = await setup(),
      original = await f.t.run((ctx) =>
        currentSupplier(ctx, f.scope, f.supplier.supplierId),
      );
    const c = await f.proposeChange();
    await expect(
      f.t.run((ctx) => currentSupplier(ctx, f.scope, f.supplier.supplierId)),
    ).rejects.toThrow(/supplier_contact_review_pending/);
    await f.reviewChange(c);
    await f.decideChange(c);
    await expect(
      f.t.run((ctx) => currentSupplier(ctx, f.scope, f.supplier.supplierId)),
    ).rejects.toThrow(/supplier_contact_recertification_required/);
    expect(await f.t.run((ctx) => ctx.db.get(original._id))).toEqual(
      originalWithNoValue(original),
    );
    await f.onboard(
      { ...f.supplier, contactId: f.registered.contactId, expectedRevision: 1 },
      "recertify",
    );
    const now = await f.t.run((ctx) =>
      currentSupplier(ctx, f.scope, f.supplier.supplierId),
    );
    expect(now.value).toMatchObject({
      contactId: f.registered.contactId,
      externalAccountId: original.value.externalAccountId,
      currency: original.value.currency,
    });
    const result = await f.humans.governor!.query(view, { scope: f.scope });
    expect(result.changes).toEqual([
      expect.objectContaining({
        changeId: c.changeId,
        status: "approved",
        verification: expect.objectContaining({ seatId: "human-verifier" }),
        decision: expect.objectContaining({ seatId: "human-governor" }),
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /originalBase64|originalRef|token-/,
    );
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(0);
  });
  it("cannot replace a contact through the legacy supplier proposal", async () => {
    const f = await setup();
    await expect(
      f.onboard(
        {
          ...f.supplier,
          expectedRevision: 1,
          contactId: f.registered.contactId,
        },
        "bypass",
      ),
    ).rejects.toThrow(/trusted_contact_change/);
  });
  it("requires source provenance and source-bound phone before a replacement", async () => {
    const f = await setup({ origin: false });
    await expect(f.proposeChange()).rejects.toThrow(/contact_origin_required/);
    await expect(
      f.humans.second!.mutation(cr.registerTrustedContact!, {
        scope: f.scope,
        idempotencyKey: "unsupported-phone",
        supplierId: f.supplier.supplierId,
        phone: "+14155550888",
        evidence: f.source,
        mode: "simulated",
        origin: {
          kind: "independent_registry",
          acquiredAt: Date.now(),
          description: "Record",
        },
      }),
    ).rejects.toThrow(/contact_phone_evidence_required/);
  });
  it("rejects an invoice phone source even when the original bytes are renamed as a contract", async () => {
    const f = await setup(),
      input = packet("invoice-alias"),
      alias = structuredClone(input.documents[0]!);
    alias.sourceId = "renamed-original";
    alias.name = "directory.txt";
    alias.kind = "contract";
    alias.deliveryId = "renamed-delivery";
    input.documents.push(alias);
    await f.t.mutation(refs.ingest, { ...f.ap, input });
    await expect(
      f.humans.second!.mutation(cr.registerTrustedContact!, {
        scope: f.scope,
        idempotencyKey: "invoice-phone",
        supplierId: f.supplier.supplierId,
        phone: "+14155550999",
        evidence: [binding(alias)],
        mode: "simulated",
        origin: {
          kind: "executed_agreement",
          acquiredAt: Date.now(),
          description: "Claimed directory",
        },
      }),
    ).rejects.toThrow(/independent_contact_required/);
  });
  it("requires an explicit escalation policy and an independent escalation review when old channel is unavailable", async () => {
    const f = await setup({ escalation: false });
    await expect(
      f.proposeChange({
        ...f.proposal,
        oldChannel: { ...f.proposal.oldChannel, status: "unavailable" },
      }),
    ).rejects.toThrow(/contact_escalation_policy_required/);
    const g = await setup(),
      c = await g.proposeChange({
        ...g.proposal,
        oldChannel: { ...g.proposal.oldChannel, status: "unavailable" },
      });
    await g.reviewChange(c);
    await expect(g.decideChange(c)).rejects.toThrow(/contact_reviews_required/);
    await g.reviewChange(c, "escalate");
    await g.decideChange(c);
    expect(
      (await g.humans.governor!.query(view, { scope: g.scope })).changes[0]
        .escalation,
    ).toMatchObject({
      subject: subject("escalation"),
      method: "independent_reestablishment",
    });
  });
  it("requires independent reestablishment when replacement declares the old channel unavailable", async () => {
    const f = await setup();
    const c = await f.proposeChange({
      ...f.proposal,
      oldChannel: { ...f.proposal.oldChannel, status: "unavailable" },
    });
    await expect(
      f.reviewChange(c, "verify", "verifier", {
        method: "old_channel_confirmation",
      }),
    ).rejects.toThrow(/independent_reestablishment_required/);
    await f.reviewChange(c);
    await f.reviewChange(c, "escalate");
    await f.decideChange(c);
  });
  it("requires old-channel confirmation for available contacts and explicit restoration", async () => {
    const f = await setup(),
      c = await f.proposeChange();
    await expect(
      f.reviewChange(c, "verify", "verifier", {
        method: "independent_reestablishment",
      }),
    ).rejects.toThrow(/old_channel_confirmation_required/);
  });
  it("rejects review and final approval by the source recorder, including a subject alias of the same seat", async () => {
    const f = await setup(),
      c = await f.proposeChange();
    await expect(f.reviewChange(c, "verify", "second")).rejects.toThrow(
      /contact_segregation/,
    );
    await f.t.run(async (ctx) => {
      const config = (await ctx.db.query("demoConfigs").collect())[0]!;
      await ctx.db.patch(config._id, {
        humanSubjects: config.humanSubjects.map((h) =>
          h.subject === subject("verifier")
            ? { ...h, seatId: "human-second" }
            : h,
        ),
      });
    });
    await expect(f.reviewChange(c)).rejects.toThrow(/contact_segregation/);
  });
  it.each(["second", "verifier", "escalation"])(
    "rechecks retained %s before activation",
    async (name) => {
      const f = await setup(),
        c = await f.proposeChange({
          ...f.proposal,
          oldChannel: { ...f.proposal.oldChannel, status: "unavailable" },
        });
      await f.reviewChange(c);
      await f.reviewChange(c, "escalate");
      await retire(f, name);
      await expect(f.decideChange(c)).rejects.toThrow(/inactive_approver/);
    },
  );
  it.each(["second", "verifier", "escalation", "governor"])(
    "rechecks retained %s after replacement and supplier recertification",
    async (name) => {
      const f = await setup();
      await replace(f, true);
      await f.onboard(
        {
          ...f.supplier,
          contactId: f.registered.contactId,
          expectedRevision: 1,
        },
        "recertify",
      );
      await retire(f, name);
      await expect(
        f.t.run((ctx) => currentSupplier(ctx, f.scope, f.supplier.supplierId)),
      ).rejects.toThrow(/inactive_approver/);
    },
  );
  it("rejects stale policy-bound reviews and preserves a superseding repair path", async () => {
    const f = await setup(),
      c = await f.proposeChange();
    await f.reviewChange(c);
    const next = { ...f.policy, version: "policy-next" };
    const p = await f.t.mutation(cr.proposePolicy!, {
      ...f.controller,
      idempotencyKey: "next",
      policy: next,
    });
    const row = await f.t.run((ctx) =>
      ctx.db.get(p.policyId as Id<"apBusinessPolicies">),
    );
    await f.humans.governor!.mutation(cr.activatePolicy!, {
      scope: f.scope,
      policyId: p.policyId,
      expectedHash: row!.hash,
      reason: "Review policy",
    });
    await expect(f.decideChange(c)).rejects.toThrow(/contact_change_stale/);
    const replacement = await f.proposeChange(
      { ...f.proposal, supersedesChangeId: c.changeId },
      "new-policy",
    );
    await f.reviewChange(replacement);
    await f.decideChange(replacement);
  });
  it("keeps rejection held until an explicitly reviewed restoration, retaining both proposal histories", async () => {
    const f = await setup(),
      c = await f.proposeChange();
    await f.decideChange(c, "rejected");
    await expect(
      f.t.run((ctx) => currentSupplier(ctx, f.scope, f.supplier.supplierId)),
    ).rejects.toThrow(/supplier_contact_review_pending/);
    const restore = await f.proposeChange(
      {
        ...f.proposal,
        newContactId: f.supplier.contactId,
        resolution: "retain_current",
        supersedesChangeId: c.changeId,
      },
      "restore",
    );
    await f.reviewChange(restore);
    await f.decideChange(restore);
    expect(
      (
        await f.t.run((ctx) =>
          currentSupplier(ctx, f.scope, f.supplier.supplierId),
        )
      ).revision,
    ).toBe(1);
    const rows = (await f.humans.governor!.query(view, { scope: f.scope }))
      .changes;
    expect(rows.map((r: any) => [r.status, r.decision.outcome])).toEqual([
      ["superseded", "rejected"],
      ["approved", "approved"],
    ]);
  });
  it("returns exact replays, rejects changed payloads, and serializes competing proposals", async () => {
    const f = await setup();
    const [a, b] = await Promise.all([f.proposeChange(), f.proposeChange()]);
    expect(a).toEqual(b);
    await expect(
      f.proposeChange({ ...f.proposal, reason: "Different" }),
    ).rejects.toThrow(/idempotency_conflict/);
    await expect(f.proposeChange(f.proposal, "competing")).rejects.toThrow(
      /contact_change_conflict/,
    );
    await f.reviewChange(a);
    await f.reviewChange(a);
    await expect(
      f.reviewChange(a, "verify", "verifier", { reason: "Changed" }),
    ).rejects.toThrow(/contact_review_immutable/);
    const result = await f.decideChange(a);
    expect(await f.decideChange(a)).toEqual(result);
    await expect(f.decideChange(a, "rejected")).rejects.toThrow(
      /contact_decision_immutable/,
    );
    expect(
      await f.t.run((ctx) =>
        ctx.db.query("apSupplierContactChanges").collect(),
      ),
    ).toHaveLength(1);
  });
  it("holds new dispatch without agent cancellation; a human decision cancels the unsent operation", async () => {
    const f = await setup(),
      b = await f.recognize(f.detail, acceptance(f.input, "1"));
    const payment = await f.t.mutation(api.demoPayments.requestPayment, {
      scope: f.scope,
      seatId: "payments",
      token: "token-payments",
      requestKey: "contact-payment",
      billIds: [b.billId],
      credits: [],
    });
    const command = await f.humans.finance!.mutation(
      api.demoPayments.approveAndQueue,
      { scope: f.scope, ...payment },
    );
    const before = await f.t.run((ctx) => ctx.db.get(command.commandId)),
      c = await f.proposeChange();
    expect(await f.t.run((ctx) => ctx.db.get(command.commandId))).toEqual(
      before,
    );
    const attempt = f.t.mutation(api.demoPayments.claim, {
      scope: f.scope,
      token: "test-dispatch",
      paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
      workerId: "contact-test",
      leaseToken: "contact-unsent-lease",
    });
    await expect(attempt).resolves.toBeNull();
    expect(await f.t.run((ctx) => ctx.db.get(command.commandId))).toMatchObject(
      {
        execution: "exception",
        attemptCount: 0,
        lastError: expect.stringContaining("supplier_contact_review_pending"),
      },
    );
    expect(await f.t.run((ctx) => ctx.db.get(payment.versionId))).toMatchObject(
      { status: "queued", reservations: "reserved" },
    );
    await f.reviewChange(c);
    await f.decideChange(c);
    expect(await f.t.run((ctx) => ctx.db.get(payment.versionId))).toMatchObject(
      { status: "cancelled", reservations: "released" },
    );
    expect(await f.t.run((ctx) => ctx.db.get(command.commandId))).toMatchObject(
      { execution: "cancelled", attemptCount: 0 },
    );
  });
  it("preserves possibly sent command, destination, key and reservations across human replacement", async () => {
    const f = await setup(),
      b = await f.recognize();
    const payment = await f.t.mutation(api.demoPayments.requestPayment, {
      scope: f.scope,
      seatId: "payments",
      token: "token-payments",
      requestKey: "contact-possible-send",
      billIds: [b.billId],
      credits: [],
    });
    const command = await f.humans.finance!.mutation(
      api.demoPayments.approveAndQueue,
      { scope: f.scope, ...payment },
    );
    await f.t.mutation(api.demoPayments.claim, {
      scope: f.scope,
      token: "test-dispatch",
      paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
      workerId: "contact-test",
      leaseToken: "contact-possible-lease",
    });
    const before = await f.t.run((ctx) => ctx.db.get(command.commandId));
    await replace(f, true);
    expect(await f.t.run((ctx) => ctx.db.get(command.commandId))).toEqual(
      before,
    );
    expect(await f.t.run((ctx) => ctx.db.get(payment.versionId))).toMatchObject(
      {
        status: "queued",
        reservations: "reserved",
        requestKey: "contact-possible-send",
      },
    );
  });
  it("revalidates replacement roles after a policy group change without rewriting the prior decision", async () => {
    const f = await setup();
    const c = await replace(f);
    await f.onboard(
      { ...f.supplier, contactId: f.registered.contactId, expectedRevision: 1 },
      "recertify",
    );
    const next = {
      ...f.policy,
      version: "policy-removal",
      groups: f.policy.groups.map((g) =>
        g.groupId === "verify" ? { ...g, members: [subject("verifier")] } : g,
      ),
    };
    const p = await f.t.mutation(cr.proposePolicy!, {
      ...f.controller,
      idempotencyKey: "group-change",
      policy: next,
    });
    const row = await f.t.run((ctx) =>
      ctx.db.get(p.policyId as Id<"apBusinessPolicies">),
    );
    await f.humans.governor!.mutation(cr.activatePolicy!, {
      scope: f.scope,
      policyId: p.policyId,
      expectedHash: row!.hash,
      reason: "Change verification membership",
    });
    await expect(
      f.t.run((ctx) => currentSupplier(ctx, f.scope, f.supplier.supplierId)),
    ).rejects.toThrow(/approval_group_required/);
    expect(
      (await f.humans.governor!.query(view, { scope: f.scope })).changes.find(
        (x: any) => x.changeId === c.changeId,
      ).status,
    ).toBe("approved");
  });
  it("blocks a supplier proposal verified before the contact change from activating after replacement", async () => {
    const f = await setup();
    const draft = await f.t.mutation(cr.proposeSupplier!, {
      ...f.ap,
      idempotencyKey: "old-contact-bank",
      proposal: {
        ...f.supplier,
        expectedRevision: 1,
        externalAccountId: "new-bank",
      },
    });
    const row = await f.t.run((ctx) =>
      ctx.db.get(draft.revisionId as Id<"apSupplierRevisions">),
    );
    await f.humans.verifier!.mutation(cr.verifySupplier!, {
      scope: f.scope,
      revisionId: draft.revisionId,
      verification: {
        contactId: f.supplier.contactId,
        method: "callback_previously_held_contact",
        result: "confirmed",
        performedAt: row!.createdAt,
        evidence: f.proof,
        mode: "simulated",
        reason: "Synthetic test",
      },
    });
    await replace(f);
    await expect(
      f.humans.governor!.mutation(cr.approveSupplier!, {
        scope: f.scope,
        revisionId: draft.revisionId,
        expectedHash: row!.hash,
        reason: "Old contact cannot authorize this",
      }),
    ).rejects.toThrow(/trusted_contact_change/);
  });
  it("rechecks distinct verifier and final approver seats even if subject aliases differ", async () => {
    const f = await setup(),
      c = await f.proposeChange();
    await f.reviewChange(c);
    await f.t.run(async (ctx) => {
      const config = (await ctx.db.query("demoConfigs").collect())[0]!;
      await ctx.db.patch(config._id, {
        humanSubjects: config.humanSubjects.map((h) =>
          h.subject === subject("governor")
            ? { ...h, seatId: "human-verifier" }
            : h,
        ),
      });
    });
    await expect(f.decideChange(c)).rejects.toThrow(/contact_segregation/);
  });
  it("rejects stale hashes and future claimed reviews", async () => {
    const f = await setup(),
      c = await f.proposeChange();
    await expect(
      f.reviewChange({ ...c, hash: "0".repeat(64) }),
    ).rejects.toThrow(/contact_change_hash/);
    await expect(
      f.reviewChange(c, "verify", "verifier", {
        performedAt: Date.now() + 1000000,
      }),
    ).rejects.toThrow(/contact_review_time/);
  });
  it("preserves possible-send recovery after replacement with the original operation", async () => {
    const f = await setup(),
      b = await f.recognize();
    const payment = await f.t.mutation(api.demoPayments.requestPayment, {
      scope: f.scope,
      seatId: "payments",
      token: "token-payments",
      requestKey: "recover-contact",
      billIds: [b.billId],
      credits: [],
    });
    await f.humans.finance!.mutation(api.demoPayments.approveAndQueue, {
      scope: f.scope,
      ...payment,
    });
    const first = await f.t.mutation(api.demoPayments.claim, {
      scope: f.scope,
      token: "test-dispatch",
      paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
      workerId: "contact-test",
      leaseToken: "contact-first-attempt",
    });
    await f.t.mutation(api.demoPayments.fail, {
      scope: f.scope,
      token: "test-dispatch",
      paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
      commandId: first!.commandId,
      generation: first!.generation,
      leaseToken: first!.leaseToken,
      errorClass: "transport",
      error: "Response lost",
    });
    await replace(f);
    await f.t.run((ctx) =>
      ctx.db.patch(first!.commandId, { nextAttemptAt: 0 }),
    );
    const retry = await f.t.mutation(api.demoPayments.claim, {
      scope: f.scope,
      token: "test-dispatch",
      paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
      workerId: "contact-test",
      leaseToken: "contact-recovery-attempt",
    });
    expect(retry).toMatchObject({
      action: "reconcile",
      command: first!.command,
    });
  });
  it("requires case recertification against the new supplier revision without creating a second bill or recognition", async () => {
    const f = await setup(),
      before = await f.recognize();
    await replace(f);
    await f.onboard(
      { ...f.supplier, contactId: f.registered.contactId, expectedRevision: 1 },
      "recertify",
    );
    const args = {
      scope: f.scope,
      seatId: "payments",
      token: "token-payments",
      requestKey: "post-contact-payment",
      billIds: [before.billId],
      credits: [],
    };
    await expect(
      f.t.mutation(api.demoPayments.requestPayment, args),
    ).rejects.toThrow(/stale_supplier/);
    const recert = await f.propose(
      await f.get(f.detail.caseId),
      acceptance(f.input),
      "recertify-case",
      2,
    );
    await f.vote(recert);
    const approved = await f.vote(recert, "finance");
    expect(approved.billId).toBe(before.billId);
    await f.t.mutation(api.demoPayments.requestPayment, args);
    expect(
      await f.t.run((ctx) => ctx.db.query("demoBills").collect()),
    ).toHaveLength(1);
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(1);
  });
  it("rejects a contact mutation request containing a bank destination or an unprivileged proposer", async () => {
    const f = await setup();
    await expect(
      f.proposeChange({
        ...f.proposal,
        externalAccountId: "smuggled-bank",
      } as ContactChangeProposal),
    ).rejects.toThrow();
    await expect(
      f.t.mutation(ref("propose"), {
        ...f.ap,
        idempotencyKey: "wrong-role",
        proposal: f.proposal,
      }),
    ).rejects.toThrow();
  });
  it("requires authenticated scoped humans for the safe review projection", async () => {
    const f = await setup();
    await expect(f.t.query(view, { scope: f.scope })).rejects.toThrow();
  });
});
function originalWithNoValue<T extends { value: unknown }>(row: T) {
  const { value, ...stored } = row;
  return stored;
}
