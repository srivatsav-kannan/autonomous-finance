import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { businessFixture } from "./ap-system/business-fixture";
import { fixture } from "./ap-system/accounting-fixture";
import type { Id } from "../convex/_generated/dataModel";
import { PRECEDENT_DEMO_CASES, type PrecedentHistoryInput, type PrecedentOverview } from "../src/ap-system/precedent-contracts";
const mut = (name: string) => makeFunctionReference<"mutation">(`apPrecedents:${name}`);
const view = makeFunctionReference<"query">("apPrecedents:overview");
afterEach(() => vi.unstubAllEnvs());
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function setup() {
  const f = await businessFixture({ onboard: false });
  const seed = await f.t.mutation(mut("seedDemo"), { ...f.ap, idempotencyKey: "demo-v1" });
  const overview = () => f.human.query(view, { scope: f.scope }) as Promise<PrecedentOverview>;
  const review = (patch: Record<string, unknown> = {}) => f.humans.governor!.mutation(mut("reviewRule"), { scope: f.scope, candidateId: seed.candidateId, expectedHash: seed.hash, outcome: "accept", reason: "Reviewed synthetic source, correction and bounded scope independently", ...patch });
  const evaluate = (key: "B" | "C", extra: Record<string, unknown> = {}, suffix = "") => f.human.mutation(mut("evaluate"), { scope: f.scope, idempotencyKey: `${key}-${suffix}`, context: { ...PRECEDENT_DEMO_CASES.find(c => c.key === key)!.context, ...extra } });
  return { ...f, seed, overview, review, evaluate };
}
function historyInput(h: PrecedentOverview["histories"][number], suffix: string, patch: Partial<PrecedentHistoryInput> = {}): PrecedentHistoryInput {
  const { id: _id, hash: _hash, importedAt: _at, importedBy: _by, recordPurpose: _purpose, ...input } = h;
  return { ...structuredClone(input), externalId: `${input.externalId}-${suffix}`, sourceCaseId: `${input.sourceCaseId}-${suffix}`, ...patch };
}
async function financialCounts(f: Pick<Awaited<ReturnType<typeof fixture>>, "t">) {
  return f.t.run(async ctx => ({ cases: (await ctx.db.query("apCaseRecords").collect()).length, bills: (await ctx.db.query("demoBills").collect()).length, journals: (await ctx.db.query("journalEntries").collect()).length, payments: (await ctx.db.query("demoVersions").collect()).length, commands: (await ctx.db.query("demoCommands").collect()).length }));
}
describe("bounded historical correction learning", () => {
  it("persists source A, gates rule approval, recommends held-out B and holds counterexample C without financial effects", async () => {
    const f = await setup(), before = await financialCounts(f);
    const o = await f.overview(), h = o.histories[0]!;
    expect(h.provenance).toBe("synthetic");
    expect(h.sources[0]!.sha256).toBe(sha(h.sources[0]!.text));
    expect(h.originalCoding.accountCode).toBe("1200");
    expect(h.proposedCoding.accountCode).toBe("5000");
    expect(h.finalCoding.accountCode).toBe("5000");
    expect(o.candidates[0]!.support[0]!.sourceCaseId).toBe("synthetic-historical-case-A");
    expect((await f.evaluate("B", {}, "before")).status).toBe("held");
    await expect(f.human.mutation(mut("reviewRule"), { scope: f.scope, candidateId: f.seed.candidateId, expectedHash: f.seed.hash, outcome: "accept", reason: "Not a governor" })).rejects.toThrow(/group/i);
    await expect(f.t.mutation(mut("reviewRule"), { scope: f.scope, candidateId: f.seed.candidateId, expectedHash: f.seed.hash, outcome: "accept", reason: "Agent cannot review" })).rejects.toThrow(/human/i);
    await f.review();
    const b = await f.evaluate("B"), c = await f.evaluate("C");
    expect(b).toMatchObject({ status: "recommendation", coding: { accountCode: "5000" }, requiresHumanReview: true, inferenceMode: "deterministic_demo" });
    expect(b.ruleIds).toEqual([f.seed.candidateId]);
    expect(c).toMatchObject({ status: "held", coding: null, requiresHumanReview: true });
    expect(await financialCounts(f)).toEqual(before);
    expect((await f.overview()).evaluations).toHaveLength(3);
    expect(await f.t.run(ctx => ctx.db.query("apPrecedentReviews").collect())).toHaveLength(1);
  });
  it("replays an exact human rule review without duplicate decisions and rejects altered retries", async () => {
    const f = await setup();
    const first = await f.review();
    expect(await f.review()).toEqual(first);
    expect(await f.t.run(ctx => ctx.db.query("apPrecedentReviews").collect())).toHaveLength(1);
    await expect(f.review({ reason: "Different reason cannot replace a committed decision" })).rejects.toThrow(/already been recorded/);
    await expect(f.review({ outcome: "reject" })).rejects.toThrow(/already been recorded/);
    const stored = (await f.overview()).candidates[0]!;
    expect(stored.status).toBe("approved");
    expect(stored.humanReview?.reason).toBe("Reviewed synthetic source, correction and bounded scope independently");
  });
  it("has no hidden demo policy bootstrap and deduplicates seed retries", async () => {
    const f = await fixture(), before = await financialCounts(f);
    const a = await f.t.mutation(mut("seedDemo"), { ...f.ap, idempotencyKey: "same" });
    expect(await f.t.mutation(mut("seedDemo"), { ...f.ap, idempotencyKey: "same" })).toEqual(a);
    const o = await f.human.query(view, { scope: f.scope }) as PrecedentOverview;
    expect(o.authority.policyReady).toBe(false); expect(o.histories).toHaveLength(1); expect(o.candidates).toHaveLength(1);
    await expect(f.human.mutation(mut("reviewRule"), { scope: f.scope, candidateId: a.candidateId, expectedHash: a.hash, outcome: "accept", reason: "No configured policy" })).rejects.toThrow(/policy/i);
    expect(await financialCounts(f)).toEqual(before);
  });
  it("rejects corrupt source hashes and immutable history replacement", async () => {
    const f = await setup(), h = (await f.overview()).histories[0]!, changed = historyInput(h, "corrupt");
    changed.sources[0]!.text += " tampered";
    await expect(f.t.mutation(mut("importHistory"), { ...f.ap, idempotencyKey: "bad-hash", history: changed })).rejects.toThrow(/hash/i);
    const replacement = historyInput(h, "unused", { externalId: h.externalId, correctionReason: "Changed conclusion" });
    await expect(f.t.mutation(mut("importHistory"), { ...f.ap, idempotencyKey: "replace", history: replacement })).rejects.toThrow(/immutable/i);
    expect((await f.overview()).histories).toHaveLength(1);
  });
  it("refuses expanded scope, retains narrowed effective dates, and never reuses outside scope", async () => {
    const f = await setup(), c = (await f.overview()).candidates[0]!;
    await expect(f.review({ outcome: "narrow", narrowedScope: { ...c.scope, locations: [...c.scope.locations, "other-store"] } })).rejects.toThrow(/narrow/i);
    await f.review({ outcome: "narrow", narrowedScope: { ...c.scope, effectiveUntil: "2026-10-31" } });
    expect((await f.evaluate("B")).status).toBe("recommendation");
    expect((await f.evaluate("B", { effectiveOn: "2026-11-01" }, "late")).status).toBe("held");
    expect((await f.evaluate("B", { location: "other-store" }, "location")).status).toBe("held");
    expect((await f.evaluate("B", { supplierId: "another-supplier" }, "supplier")).status).toBe("held");
  });
  it("detects unselected contradictory history before approval and new contradictions after approval", async () => {
    const f = await setup(), h = (await f.overview()).histories[0]!;
    await f.review();
    const contradiction = historyInput(h, "contradiction", { finalCoding: { ...h.finalCoding, accountCode: "1500" } });
    await f.t.mutation(mut("importHistory"), { ...f.ap, idempotencyKey: "contradiction", history: contradiction });
    expect((await f.evaluate("B")).status).toBe("held");
    const next = await f.t.mutation(mut("proposeRule"), { ...f.ap, idempotencyKey: "cherry-pick", proposal: { historyIds: [h.id], scope: (await f.overview()).candidates[0]!.scope, coding: h.finalCoding, reason: "Attempt to cite only supporting A" } });
    await expect(f.humans.governor!.mutation(mut("reviewRule"), { scope: f.scope, candidateId: next.candidateId, expectedHash: next.hash, outcome: "accept", reason: "Contradiction cannot be ignored" })).rejects.toThrow(/contradiction/i);
  });
  it("holds missing context and rejected candidates, and rejects stale review hashes", async () => {
    const f = await setup();
    await expect(f.review({ expectedHash: "a".repeat(64) })).rejects.toThrow(/exact|hash/i);
    const h = (await f.overview()).histories[0]!;
    await f.t.mutation(mut("importHistory"), { ...f.ap, idempotencyKey: "missing", history: historyInput(h, "missing", { missingContext: ["Work order missing: expense versus capital classification unresolved"] }) });
    await expect(f.review()).rejects.toThrow(/missing context/i);
    await f.review({ outcome: "reject", reason: "Insufficient context" });
    expect((await f.evaluate("B")).status).toBe("held");
    expect((await f.overview()).candidates[0]!.humanReview?.outcome).toBe("reject");
  });
  it("rechecks current policy and human identity instead of treating prior approval as permanent authority", async () => {
    const f = await setup(); await f.review();
    await f.t.run(async ctx => { const p = (await ctx.db.query("apBusinessPolicies").collect()).find(p => p.status === "active")!; await ctx.db.patch(p._id, { hash: "b".repeat(64) }); });
    expect((await f.evaluate("B")).reason).toMatch(/older policy/);
    const g = await setup(); await g.review();
    await g.t.run(async ctx => { const s = (await ctx.db.query("seats").collect()).find(s => s.seatId === "human-governor")!; await ctx.db.patch(s._id, { status: "retired" }); });
    expect((await g.evaluate("B")).status).toBe("held");
  });
  it("enforces independent reviewer seats even when candidate author metadata is a human alias", async () => {
    const f = await setup();
    await f.t.run(ctx => ctx.db.patch(f.seed.candidateId as Id<"apPrecedentCandidates">, { proposedBy: "human-governor" }));
    await expect(f.review()).rejects.toThrow(/independent/i);
  });
});
