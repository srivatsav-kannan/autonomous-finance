import { afterEach, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { businessFixture, br, binding, syncPrimary, acceptance } from "../../../tests/ap-system/business-fixture";
import { packet } from "../../../tests/ap-system/accounting-fixture";
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
it("CD1 credit note dated before the original invoice is recognized against it", async () => {
  const f = await businessFixture();
  const original = await f.recognize(f.detail, acceptance(f.input));
  const input = packet("CN-EARLY");
  const c = input.candidate!;
  c.kind = "credit_note"; c.invoiceDate = "2026-10-01";
  c.lines[0]!.quantity.decimal = "1"; c.lines[0]!.amountCents = 3850; c.lines[0]!.allocations[0]!.amountCents = 3850; c.subtotalCents = 3850; c.totalCents = 3850;
  input.documents[0]!.kind = "credit_note";
  const returned = input.documents[2]!; const body = "Synthetic return CN-EARLY: receiving-owner accepted returned KALE-24 1 case";
  returned.sourceId = "return-early"; returned.extractedText = body; returned.originalBase64 = Buffer.from(body).toString("base64"); returned.byteLength = Buffer.byteLength(body); returned.sha256 = createHash("sha256").update(body).digest("hex");
  input.purchasingEvidence[1]!.source = binding(returned); input.purchasingEvidence[1]!.lines[0]!.quantity.decimal = "1";
  syncPrimary(input);
  const d = await f.reviewed(input);
  let o = "";
  try {
    const p = await f.t.mutation(br.propose!, { ...f.ap, input: { caseId: d.caseId, expectedRevision: d.revision, snapshotHash: d.snapshotHash, idempotencyKey: "early", policyVersion: f.policy.version, supplierRevision: 1, credit: { originalCaseId: f.detail.caseId, originalApprovalId: original.proposal.proposalId, freightCents: 0, discountCents: 0, lines: [{ creditLineId: "line-1", originalLineId: "line-1", basis: "quantity_return", quantity: "1", netCents: 3850, taxCents: 0, returnEvidence: [binding(input.documents[2]!)] }], reason: "early" } } });
    const r = await f.vote(p); o = `status ${r.status}`;
  } catch (e) { o = (e as Error).message.slice(0, 200); }
  const js = await f.t.run((ctx: any) => ctx.db.query("journalEntries").collect());
  console.log("PROBE CD1", o, js.map((j: any) => `${j.date} ${j.source.kind}`).join(" | "));
});
