import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { businessFixture, acceptance } from "./ap-system/business-fixture";
import { packet, refs } from "./ap-system/accounting-fixture";
import { planAPCase } from "../src/ap-system/agent-policy";
const claim = makeFunctionReference<"mutation">("apCaseAgent:claim");
const advance = makeFunctionReference<"mutation">("apCaseAgent:advance");
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
function missingPacket() {
  const p = packet("GOVERNED-WORK");
  p.documents = p.documents.filter(d => d.kind !== "receipt");
  p.purchasingEvidence = p.purchasingEvidence.filter(d => d.kind !== "receipt");
  p.candidate!.sources = p.candidate!.sources.filter(s => !s.sourceId.startsWith("receipt-"));
  return p;
}
describe("governed work stage ordering", () => {
  it("distinguishes missing receipt, fresh field review and business-plan approval without financial effects", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T15:00:00Z"));
    const f = await businessFixture({ input: missingPacket() });
    const tick = async (key: string) => {
      vi.setSystemTime(Date.now() + 6000); // Existing durable five-second poll observes human updates.
      const lease = await f.t.mutation(claim, { ...f.ap, requestId: key });
      expect(lease.caseId).toBe(f.detail.caseId);
      await f.t.mutation(advance, { ...f.ap, caseId: lease.caseId, generation: lease.generation });
      return f.get(f.detail.caseId);
    };
    const before = await tick("missing");
    expect(before.work!.stage).toBe("missing_evidence");
    expect(before.exceptions.some(e => e.code === "missing_receipt" && e.blocking)).toBe(true);
    const next = packet("GOVERNED-WORK"); next.explicitRevisionOf = before.caseId; next.idempotencyKey = "receiving-arrival"; next.candidate!.revision = 2;
    await f.t.mutation(refs.ingest, { ...f.ap, input: next });
    const arrived = await tick("receipt");
    expect(arrived.work!.stage).toBe("field_review");
    expect(arrived.exceptions.some(e => e.code === "missing_receipt")).toBe(false);
    expect(arrived.exceptions.some(e => e.code === "business_plan_required")).toBe(true);
    await expect(f.propose(arrived, acceptance(next))).rejects.toThrow(/field review/i);
    await f.human.mutation(refs.review, { scope: f.scope, input: f.request(arrived, "current-fields") });
    const reviewed = await tick("fields");
    expect(reviewed.work!.stage).toBe("bill_approval");
    expect(reviewed.states.accounting).toBe("unposted");
    expect(reviewed.payments).toHaveLength(0); expect(reviewed.journals).toHaveLength(0);
    const proposed = await f.propose(reviewed, acceptance(next));
    const pending = await f.get(reviewed.caseId);
    expect(pending.domain!.approvalStatus).toBe("pending");
    expect(planAPCase(pending).stage).toBe("bill_approval");
    expect(pending.states.accounting).toBe("unposted");
    expect(pending.payments).toHaveLength(0); expect(pending.journals).toHaveLength(0);
    expect(proposed.proposalId).toBeTruthy();
  });
  it("does not count a receipt with wrong source hash, supplier, line, SKU, unit or missing acknowledgement", async () => {
    const f = await businessFixture();
    for (const [index, mutate] of [
      (p: ReturnType<typeof packet>) => { p.purchasingEvidence[1]!.source.sha256 = "a".repeat(64); },
      (p: ReturnType<typeof packet>) => { p.purchasingEvidence[1]!.supplierId = "other"; },
      (p: ReturnType<typeof packet>) => { p.purchasingEvidence[1]!.lines[0]!.invoiceLineId = "other"; },
      (p: ReturnType<typeof packet>) => { p.purchasingEvidence[1]!.lines[0]!.sku = "other"; },
      (p: ReturnType<typeof packet>) => { p.purchasingEvidence[1]!.lines[0]!.quantity.unit = "pallet"; },
      (p: ReturnType<typeof packet>) => { p.purchasingEvidence[1]!.acceptedBy = null; },
    ].entries()) {
      const p = packet(`BAD-RECEIPT-${index}`); mutate(p);
      const r = await f.t.mutation(refs.ingest, { ...f.ap, input: p });
      const d = await f.get(r.caseId);
      expect(d.exceptions.some(e => e.code === "missing_receipt"), `variant ${index}`).toBe(true);
      expect(d.links.billId).toBeNull();
    }
  });
});
