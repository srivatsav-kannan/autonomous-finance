import { describe, expect, it } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import { api } from "../src/core/kernel-client";
import { answer } from "../src/human/gateway";
import type { MemoryStore } from "../src/memory/store";
import { legacyKernel } from "./helpers/legacyKernel";

// P1-1: what an answer does as the human CFO is fixed by the kernel when the ask is created,
// never by the asking agent's option ids, labels or title.
async function fixture() {
  const k = legacyKernel();
  await k.init();
  const human = await k.seat("human-cfo", "human_cfo", "human");
  const controller = await k.seat("controller", "controller");
  const intent = (over: Record<string, unknown> = {}) => k.h.seed("paymentIntents", {
    runId: k.runId, payee: "vendor-1", amountCents: 10_000, method: "ach", remitTo: { bank: "Test Bank", accountLast4: "1234", memorySha: "v1" },
    billIds: [], dueDate: "2026-01-30", requestedBy: "payments", approvals: [], requiredApprovals: 1, requiresHuman: true,
    status: "pending_approval", idempotencyKey: `pay:${Math.random()}`, createdAt: 0, ...over,
  } as never);
  const ask = (args: Record<string, unknown>) => controller.client.mutation(api.asks.createAsk, {
    ...controller.auth, to: "human_cfo", severity: "decision", title: "Question", body: "evidence", evidence: [], ...args,
  } as never) as Promise<{ ok: true; askId: Id<"asks"> } | { ok: false; code: string; error: string }>;
  const get = async <T extends string>(id: Id<T & ("asks" | "paymentIntents" | "periods")>) => await k.h.ctx.db.get(id as never) as Record<string, unknown>;
  return { k, human, controller, intent, ask, get };
}

const created = (r: { ok: true; askId: Id<"asks"> } | { ok: false; code: string; error: string }) => {
  if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
  return r.askId;
};

describe("ask effects are kernel-derived", () => {
  it("an informational ask whose first option is 'approve' cannot approve an unrelated payment", async () => {
    const f = await fixture();
    const unrelated = await f.intent();
    // The agent picks the id "approve" and smuggles an unrelated intent onto a plain ask.
    const askId = created(await f.ask({ severity: "info", title: "Daily digest", options: [{ id: "approve", label: "Got it" }], paymentIntentId: unrelated }));
    expect(await f.get(askId)).not.toHaveProperty("paymentIntentId");
    expect(await f.get(askId)).not.toHaveProperty("effect");
    expect(await answer(f.human, f.k.runId, askId, "approve")).toMatchObject({ ok: true, effects: [] });
    expect(await f.get(unrelated)).toMatchObject({ status: "pending_approval", approvals: [] });
  });

  it("never infers an effect from a stored legacy paymentIntentId", async () => {
    const f = await fixture();
    const unrelated = await f.intent();
    const askId = await f.k.h.seed("asks", {
      runId: f.k.runId, from: "controller", to: "human_cfo", severity: "info", title: "FYI", body: "x", evidence: [],
      options: [{ id: "approve", label: "OK" }, { id: "reject", label: "Dismiss" }], paymentIntentId: unrelated, status: "open", createdAt: 0,
    });
    expect(await answer(f.human, f.k.runId, askId, "approve")).toMatchObject({ ok: true, effects: [] });
    expect(await f.get(unrelated)).toMatchObject({ status: "pending_approval", approvals: [] });
  });

  it("never parses a close period from the title", async () => {
    const f = await fixture();
    const askId = created(await f.ask({ title: "Co-sign the 2026-01 close", options: [{ id: "sign", label: "Looks good" }] }));
    expect(await answer(f.human, f.k.runId, askId, "sign")).toMatchObject({ ok: true, effects: [] });
    const period = await f.k.h.ctx.db.query("periods").withIndex("by_run_period", (q) => q.eq("runId", f.k.runId).eq("period", "2026-01")).unique();
    expect(period?.closedBy ?? []).toEqual([]);
  });

  it("validates a payment effect: same run, pending approval, and no agent-chosen options", async () => {
    const f = await fixture();
    const foreign = await f.intent({ runId: "other-run" });
    const approved = await f.intent({ status: "approved" });
    const pending = await f.intent();
    expect(await f.ask({ effect: { kind: "payment", paymentIntentId: foreign } })).toMatchObject({ ok: false, code: "invalid_effect" });
    expect(await f.ask({ effect: { kind: "payment", paymentIntentId: approved } })).toMatchObject({ ok: false, code: "invalid_effect" });
    expect(await f.ask({ effect: { kind: "payment", paymentIntentId: pending }, options: [{ id: "approve", label: "Skip" }] })).toMatchObject({ ok: false, code: "invalid_options" });
    expect(f.k.h.all("asks")).toHaveLength(0);
    expect(f.k.h.all("violations").map((v) => v.operation)).toEqual(["asks.createAsk", "asks.createAsk", "asks.createAsk"]);

    const askId = created(await f.ask({ severity: "info", effect: { kind: "payment", paymentIntentId: pending } }));
    expect(await f.get(askId)).toMatchObject({
      severity: "decision",
      options: [{ id: "approve", label: "Approve payment" }, { id: "reject", label: "Reject payment" }],
      effect: { kind: "payment", paymentIntentId: pending, payee: "vendor-1", amountCents: 10_000, remitTo: { bank: "Test Bank", accountLast4: "1234" } },
    });
    expect(await answer(f.human, f.k.runId, askId, "approve")).toMatchObject({ ok: true, effects: ["payment approved"] });
    expect(await f.get(pending)).toMatchObject({ status: "approved", approvals: [{ seatId: "human-cfo" }] });
  });

  it("refuses to approve when the intent no longer matches what the human was shown", async () => {
    const f = await fixture();
    const pending = await f.intent();
    const askId = created(await f.ask({ effect: { kind: "payment", paymentIntentId: pending } }));
    await f.k.h.ctx.db.patch(pending, { remitTo: { bank: "Other Bank", accountLast4: "9999", memorySha: "v2" } });
    await expect(answer(f.human, f.k.runId, askId, "approve")).rejects.toThrow(/changed/);
    expect(await f.get(pending)).toMatchObject({ status: "pending_approval", approvals: [] });
  });

  it("rejecting a payment ask voids only its stored intent", async () => {
    const f = await fixture();
    const target = await f.intent();
    const other = await f.intent();
    const askId = created(await f.ask({ effect: { kind: "payment", paymentIntentId: target } }));
    expect(await answer(f.human, f.k.runId, askId, "reject")).toMatchObject({ ok: true, effects: ["payment voided"] });
    expect(await f.get(target)).toMatchObject({ status: "voided" });
    expect(await f.get(other)).toMatchObject({ status: "pending_approval" });
  });

  it("signs the stored close period, whatever the title says", async () => {
    const f = await fixture();
    expect(await f.ask({ effect: { kind: "close", period: "2026-02" } })).toMatchObject({ ok: false, code: "invalid_effect" });
    const askId = created(await f.ask({ title: "Co-sign the 2025-12 close", effect: { kind: "close", period: "2026-01" } }));
    expect(await f.get(askId)).toMatchObject({ options: [{ id: "sign", label: "Co-sign close" }, { id: "hold", label: "Hold" }], effect: { kind: "close", period: "2026-01" } });
    const r = await answer(f.human, f.k.runId, askId, "sign");
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0]).toMatch(/^close /);
    const period = await f.k.h.ctx.db.query("periods").withIndex("by_run_period", (q) => q.eq("runId", f.k.runId).eq("period", "2026-01")).unique();
    expect(period?.closedBy).toEqual(["human-cfo"]);
  });

  it("binds a merge effect to the proposal's recorded head and paths", async () => {
    const f = await fixture();
    expect(await f.ask({ effect: { kind: "merge", proposalBranch: "proposal/missing" } })).toMatchObject({ ok: false, code: "invalid_effect" });
    await f.k.h.seed("memoryCommits", { runId: f.k.runId, sha: "aaa", branch: "proposal/remit-v1", author: "payments", message: "Change remit", paths: ["vendors/v1.yaml"], trailers: {}, at: 1 });
    await f.k.h.seed("memoryCommits", { runId: "other-run", sha: "zzz", branch: "proposal/remit-v1", author: "payments", message: "Foreign", paths: ["policies/payments.yaml"], trailers: {}, at: 2 });
    const askId = created(await f.ask({ effect: { kind: "merge", proposalBranch: "proposal/remit-v1" } }));
    expect(await f.get(askId)).toMatchObject({
      options: [{ id: "merge", label: "Merge change" }, { id: "reject", label: "Don't merge" }],
      effect: { kind: "merge", proposalBranch: "proposal/remit-v1", proposalId: "remit-v1", headSha: "aaa", paths: ["vendors/v1.yaml"] },
    });
    const merged: string[] = [];
    const store = (head: string, paths: string[]) => () => ({
      git: async () => { throw new Error("not merged"); },
      proposalPaths: async () => ({ base: "base", head, paths, proposer: "payments" }),
      merge: async (o: { id: string }) => { merged.push(o.id); return { sha: "bbbbbbbbbbbb" }; },
    }) as unknown as MemoryStore;
    // The branch moved after the human was shown its paths: refuse rather than merge something else.
    await expect(answer(f.human, f.k.runId, askId, "merge", undefined, store("ccc", ["vendors/v1.yaml", "policies/payments.yaml"]))).rejects.toThrow(/changed/);
    expect(merged).toEqual([]);
    expect(await answer(f.human, f.k.runId, askId, "merge", undefined, store("aaa", ["vendors/v1.yaml"]))).toMatchObject({ ok: true, effects: ["merged bbbbbbbb"] });
    expect(merged).toEqual(["remit-v1"]);
  });

  it("refuses a merge effect for a proposal already merged to main", async () => {
    const f = await fixture();
    await f.k.h.seed("memoryCommits", { runId: f.k.runId, sha: "aaa", branch: "proposal/p1", author: "payments", message: "p", paths: ["vendors/v1.yaml"], trailers: {}, at: 1 });
    await f.k.h.seed("memoryCommits", { runId: f.k.runId, sha: "mmm", branch: "main", author: "controller", message: "Merge proposal p1", paths: ["vendors/v1.yaml"], trailers: { "Proposal-Id": "p1" }, at: 2 });
    expect(await f.ask({ effect: { kind: "merge", proposalBranch: "proposal/p1" } })).toMatchObject({ ok: false, code: "invalid_effect" });
  });
});
