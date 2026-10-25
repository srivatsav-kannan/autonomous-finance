import { createHash } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import type { APIntake } from "../src/ap-system/contracts";
import type { CaseGuidance } from "../src/ap-system/case-guidance";
import { businessFixture, binding, syncPrimary } from "./ap-system/business-fixture";
import { packet, refs } from "./ap-system/accounting-fixture";

const evaluate = makeFunctionReference<"mutation">("apCaseGuidance:evaluate");
const current = makeFunctionReference<"query">("apCaseGuidance:current");
const seed = makeFunctionReference<"mutation">("apPrecedents:seedDemo");
const review = makeFunctionReference<"mutation">("apPrecedents:reviewRule");
const disable = makeFunctionReference<"mutation">("apPrecedents:disableRule");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
afterEach(() => vi.unstubAllEnvs());

type Options = { category?: string; location?: string; date?: string; description?: string; omitCategory?: boolean; omitLocation?: boolean; extra?: string };
/** Backend policy fixture only: source bytes are text, not proof of a PDF parser/browser run. */
function guidancePacket(number: string, options: Options = {}): APIntake {
  const input = packet(number), c = input.candidate!;
  c.supplierId = "hyphenate-demo-cleaning";
  c.extractedSupplierName = "Synthetic CleanCo";
  c.invoiceDate = options.date ?? "2026-10-25";
  c.lines[0]!.description = options.description ?? "Routine store cleaning";
  c.lines[0]!.allocations = [];
  syncPrimary(input);
  const doc = input.documents[0]!;
  const labels = [
    "SYNTHETIC BACKEND POLICY TEST — not a real invoice or PDF parser test",
    `Supplier ID: ${c.supplierId}`,
    ...(options.omitCategory ? [] : [`Service category: ${options.category ?? "routine_cleaning"}`]),
    ...(options.omitLocation ? [] : [`Location: ${options.location ?? "sf-hayes-valley"}`]),
    `Invoice date: ${c.invoiceDate}`,
    `Currency: ${c.currency}`,
    `Total cents: ${c.totalCents}`,
    options.extra ?? "",
  ].join("\n");
  const text = `${doc.extractedText}\n${labels}`;
  doc.extractedText = text;
  doc.originalBase64 = Buffer.from(text).toString("base64");
  doc.byteLength = Buffer.byteLength(text);
  doc.sha256 = sha(text);
  input.documents = [doc];
  input.purchasingEvidence = [];
  c.sources = [binding(doc)];
  c.evidence.forEach(e => e.source = binding(doc));
  input.extraction.evidence = c.evidence;
  return input;
}
async function setup(approved = true) {
  const f = await businessFixture({ onboard: false });
  const rule = await f.t.mutation(seed, { ...f.ap, idempotencyKey: "guidance-test-rule" });
  if (approved) await f.humans.governor!.mutation(review, {
    scope: f.scope, candidateId: rule.candidateId, expectedHash: rule.hash,
    outcome: "accept", reason: "Independent review of bounded synthetic rule for backend regression",
  });
  async function ingest(input: APIntake) {
    const result = await f.t.mutation(refs.ingest, { ...f.ap, input });
    return f.get(result.caseId);
  }
  const run = (detail: Awaited<ReturnType<typeof ingest>>) => f.human.mutation(evaluate, {
    scope: f.scope, caseId: detail.caseId, expectedRevision: detail.revision, snapshotHash: detail.snapshotHash,
  }) as Promise<CaseGuidance>;
  const read = (caseId: string) => f.human.query(current, { scope: f.scope, caseId }) as Promise<CaseGuidance | null>;
  const counts = () => f.t.run(async ctx => ({
    cases: (await ctx.db.query("apCaseRecords").collect()).length,
    bills: (await ctx.db.query("demoBills").collect()).length,
    journals: (await ctx.db.query("journalEntries").collect()).length,
    payments: (await ctx.db.query("demoVersions").collect()).length,
    commands: (await ctx.db.query("demoCommands").collect()).length,
  }));
  return { ...f, rule, ingest, run, read, counts };
}

describe("case-bound coding guidance from retained source evidence", () => {
  it("persists B with exact case/source/rule bindings, remains advisory and deduplicates retries", async () => {
    const f = await setup(), input = guidancePacket("GUIDANCE-B");
    const before = await f.counts(), b = await f.ingest(input), result = await f.run(b);
    expect(result).toMatchObject({ caseId: b.caseId, caseRevision: 1, snapshotHash: b.snapshotHash,
      status: "recommendation", coding: { accountCode: "5000" }, requiresHumanReview: true });
    expect(result.sourceBindings).toEqual(b.currentSourceBindings);
    expect(result.rules[0]).toMatchObject({ id: f.rule.candidateId, hash: f.rule.hash, version: "1", status: "approved" });
    expect(result.rules[0]!.histories).toEqual(expect.arrayContaining([expect.objectContaining({ sourceCaseId: "synthetic-historical-case-A", provenance: "synthetic" })]));
    expect(await f.read(b.caseId)).toEqual(result);
    expect(await f.run(b)).toEqual(result);
    expect((await f.ingest({ ...input, idempotencyKey: "same-obligation-new-upload" })).caseId).toBe(b.caseId);
    expect(await f.counts()).toEqual({ ...before, cases: before.cases + 1 });
    expect((await f.get(b.caseId)).candidate!.lines[0]!.allocations).toEqual([]);
  });

  it("holds C with matching supplier/location and states the category mismatch, owner and next step", async () => {
    const f = await setup(), before = await f.counts();
    const c = await f.ingest(guidancePacket("GUIDANCE-C", { category: "capital_renovation", description: "Capital renovation and remodeling" }));
    const result = await f.run(c);
    expect(result).toMatchObject({ status: "held", coding: null, owner: "field-reviewer", requiresHumanReview: true });
    expect(result.reason).toMatch(/category: capital_renovation differs from approved routine_cleaning/);
    expect(result.nextAction).toMatch(/original|evidence/i);
    expect(await f.read(c.caseId)).toEqual(result);
    expect(await f.run(c)).toEqual(result);
    expect((await f.get(c.caseId)).candidate!.lines[0]!.allocations).toEqual([]);
    expect(await f.counts()).toEqual({ ...before, cases: before.cases + 1 });
  });

  it.each([
    ["missing category", { omitCategory: true }, /category: missing/],
    ["ambiguous category", { extra: "Service category: capital_renovation" }, /category: ambiguous/],
    ["unsupported category", { category: "unknown_service" }, /absent or unresolved/],
    ["conflicting description", { description: "Capital renovation of the entire store" }, /contradicts renovation/],
    ["source description contradicts candidate", { extra: "Description: Capital renovation of the entire store" }, /contradict/i],
    ["missing location", { omitLocation: true }, /location: missing/],
    ["ambiguous location", { extra: "Location: sf-mission" }, /location: ambiguous/],
    ["other location", { location: "sf-mission" }, /location: sf-mission outside/],
    ["outside effective dates", { date: "2027-01-01" }, /date: 2027-01-01 outside/],
  ] as const)("holds %s instead of guessing applicability", async (name, options, reason) => {
    const f = await setup(), d = await f.ingest(guidancePacket(`NEG-${name}`, options));
    const result = await f.run(d);
    expect(result).toMatchObject({ status: "held", coding: null });
    expect(result.reason).toMatch(reason);
  });

  it.each(["unresolved", "conflicting"] as const)("holds %s field evidence even when source labels match", async status => {
    const f = await setup(), input = guidancePacket(`EVIDENCE-${status}`);
    input.candidate!.evidence.find(e => e.fieldPath === "invoiceDate")!.contentStatus = status;
    const d = await f.ingest(input), result = await f.run(d);
    expect(result).toMatchObject({ status: "held", coding: null });
    expect(result.reason).toMatch(/Relevant field evidence is unresolved or conflicting/);
  });

  it("holds incomplete original pages even when available labels match", async () => {
    const f = await setup(), input = guidancePacket("INCOMPLETE-PAGES");
    input.candidate = null;
    input.extraction.status = "incomplete";
    input.extraction.reasons = ["Second page unavailable"];
    input.documents[0]!.pageCount = 2;
    input.documents[0]!.pageStatus.push({ page: 2, status: "missing", reason: "Second page unavailable" });
    const d = await f.ingest(input), result = await f.run(d);
    expect(result).toMatchObject({ status: "held", coding: null });
    expect(result.reason).toMatch(/incomplete pages/);
  });

  it("rejects client-provided category overrides and candidate facts that contradict the source", async () => {
    const f = await setup(), c = await f.ingest(guidancePacket("SPOOF-C", { category: "capital_renovation", description: "Store renovation" }));
    await expect(f.human.mutation(evaluate, { scope: f.scope, caseId: c.caseId, expectedRevision: c.revision,
      snapshotHash: c.snapshotHash, context: { category: "routine_cleaning" } })).rejects.toThrow();
    for (const field of ["supplierId", "invoiceDate"] as const) {
      const changed = guidancePacket(`SPOOF-${field}`);
      changed.candidate![field] = field === "supplierId" ? "a-different-supplier" : "2026-11-01";
      const d = await f.ingest(changed), result = await f.run(d);
      expect(result).toMatchObject({ status: "held", coding: null });
      expect(result.reason).toMatch(/Candidate contradicts retained/);
    }
  });

  it("invalidates a positive proposal on material revision and will not replay its old binding", async () => {
    const f = await setup(), b = await f.ingest(guidancePacket("REVISE-B"));
    const prior = await f.run(b);
    expect(prior.status).toBe("recommendation");
    const changed = guidancePacket("REVISE-B", { category: "capital_renovation", description: "Capital renovation" });
    changed.idempotencyKey = "revised-B-to-renovation";
    changed.explicitRevisionOf = b.caseId;
    changed.candidate!.revision = 2;
    changed.documents[0]!.revision = 2;
    changed.documents[0]!.deliveryId += "-revision-2";
    changed.documents[0]!.replaces = b.currentSourceBindings[0]!;
    changed.candidate!.sources = changed.documents.map(binding);
    changed.candidate!.evidence.forEach(e => e.source = binding(changed.documents[0]!));
    const revised = await f.ingest(changed);
    await expect(f.run(b)).rejects.toThrow(/current case revision|stale/i);
    const result = await f.run(revised);
    expect(result).toMatchObject({ caseRevision: 2, status: "held", coding: null });
    expect(result.id).not.toBe(prior.id);
    expect(result.snapshotHash).not.toBe(prior.snapshotHash);
    expect(await f.read(revised.caseId)).toEqual(result);
  });

  it("does not use pending/rejected rules and invalidates saved results after a rule or policy change", async () => {
    const f = await setup(false), b = await f.ingest(guidancePacket("RULE-LIFECYCLE"));
    expect((await f.run(b)).status).toBe("held");
    await f.humans.governor!.mutation(review, { scope: f.scope, candidateId: f.rule.candidateId,
      expectedHash: f.rule.hash, outcome: "accept", reason: "Independent bounded test approval" });
    expect(await f.read(b.caseId)).toBeNull();
    expect((await f.run(b)).status).toBe("recommendation");
    await f.t.run(ctx => ctx.db.patch(f.rule.candidateId as Id<"apPrecedentCandidates">, { status: "rejected" }));
    expect(await f.read(b.caseId)).toBeNull();
    expect((await f.run(b)).status).toBe("held");

    const g = await setup(), d = await g.ingest(guidancePacket("POLICY-LIFECYCLE"));
    expect((await g.run(d)).status).toBe("recommendation");
    await g.t.run(async ctx => { const p = (await ctx.db.query("apBusinessPolicies").collect()).find(p => p.status === "active")!; await ctx.db.patch(p._id, { hash: "b".repeat(64) }); });
    expect(await g.read(d.caseId)).toBeNull();
    expect((await g.run(d)).reason).toMatch(/older policy/);
  });

  it("requires current governor authority to disable a rule and makes a saved recommendation stale", async () => {
    const f = await setup(), b = await f.ingest(guidancePacket("DISABLE-RULE"));
    expect((await f.run(b)).status).toBe("recommendation");
    const args = { scope: f.scope, candidateId: f.rule.candidateId, expectedHash: f.rule.hash,
      reason: "Withdraw synthetic cleaning guidance pending evidence review" };
    await expect(f.human.mutation(disable, args)).rejects.toThrow(/group/i);
    await expect(f.humans.governor!.mutation(disable, { ...args, expectedHash: "0".repeat(64) })).rejects.toThrow(/hash|exact|stale/i);
    await f.humans.governor!.mutation(disable, args);
    expect(await f.read(b.caseId)).toBeNull();
    expect((await f.run(b))).toMatchObject({ status: "held", coding: null });
    const row = await f.t.run(ctx => ctx.db.get(f.rule.candidateId as Id<"apPrecedentCandidates">));
    expect(row!.status).toBe("disabled");
  });

  it("invalidates persisted guidance when the original human reviewer loses authority", async () => {
    const f = await setup(), b = await f.ingest(guidancePacket("REVIEWER-RETIRED"));
    expect((await f.run(b)).status).toBe("recommendation");
    await f.t.run(async ctx => {
      const seat = (await ctx.db.query("seats").collect()).find(s => s.seatId === "human-governor")!;
      await ctx.db.patch(seat._id, { status: "retired" });
    });
    expect(await f.read(b.caseId)).toBeNull();
    const held = await f.run(b);
    expect(held).toMatchObject({ status: "held", coding: null });
    expect(held.reason).toMatch(/authority|reviewer/i);
  });

});
