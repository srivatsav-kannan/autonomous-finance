// The unequal repeated-SKU original is from the unchanged independent V9 probes.
import { createHash } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import type { APIntake, SourceDocument } from "../../src/ap-system/contracts";
import type { PhysicalLine } from "../../src/ap-system/physical-line-contracts";
import type { CloseAction, PeriodView } from "../../src/ap-system/close-contracts";
import { businessFixture, policy, subject, binding, syncPrimary } from "./business-fixture";
import { packet } from "./accounting-fixture";

const physicalRef = (name: string) => makeFunctionReference<"mutation">(`apPhysicalLines:${name}`);
const closeRef = (name: string) => makeFunctionReference<"mutation">(`apClose:${name}`);
const periodView = makeFunctionReference<"query">("apClose:view");
export const originalLines = [
  "North receiving KALE-24 0.5 case accepted",
  "South receiving KALE-24 1.5 case accepted",
];
const physical: PhysicalLine[] = originalLines.map((quote, i) => ({
  physicalLineId: i ? "south" : "north", sku: "KALE-24", unit: "case",
  capacity: i ? "1.5" : "0.5", unitPriceCents: null,
  locator: {
    page: 1, start: i ? originalLines[0]!.length + 1 : 0,
    end: (i ? originalLines[0]!.length + 1 : 0) + quote.length, quote,
  },
}));
function setOriginal(doc: SourceDocument, body: string) {
  Object.assign(doc, {
    extractedText: body, originalBase64: Buffer.from(body).toString("base64"),
    byteLength: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"),
  });
}
export function physicalPacket(number: string) {
  const input = packet(number), doc = input.documents[2]!, receipt = input.purchasingEvidence[1]!;
  setOriginal(doc, originalLines.join("\n"));
  receipt.source = binding(doc);
  receipt.lines = physical.map(line => ({
    ...receipt.lines[0]!, lineId: `${number}-${line.physicalLineId}`,
    quantity: { decimal: line.capacity, unit: line.unit },
  }));
  return syncPrimary(input);
}
export async function physicalFixture(input: APIntake) {
  const p = policy();
  p.groups.push({ groupId: "identity-review", members: [subject("second")] });
  p.receiptIdentityApprovalGroup = "identity-review";
  const f = await businessFixture({ policy: p, input });
  let sequence = 0;
  const mapping = () => f.t.mutation(physicalRef("propose"), {
    ...f.controller, idempotencyKey: `mapping-${++sequence}`,
    proposal: {
      caseId: f.detail.caseId, expectedRevision: f.detail.revision,
      snapshotHash: f.detail.snapshotHash, source: input.purchasingEvidence[1]!.source,
      physicalLines: physical,
      links: input.purchasingEvidence[1]!.lines.map((line, i) => ({
        parserLineId: line.lineId, physicalLineId: physical[i]!.physicalLineId,
        quantity: physical[i]!.capacity,
      })),
      reason: "Compare both distinct receiving lines against their original spans",
    },
  });
  const approveMapping = (m: { reviewId: string; hash: string }) => f.humans.second!.mutation(physicalRef("decide"), {
    scope: f.scope, input: {
      reviewId: m.reviewId, expectedHash: m.hash, outcome: "approved",
      reason: "Independently reviewed the original and conserved each quantity",
    },
  });
  const view = () => f.humans.finance!.query(periodView, { scope: f.scope, period: "2026-10" }) as Promise<PeriodView>;
  async function approveClose(action: CloseAction) {
    const proposal = await f.t.mutation(closeRef("propose"), {
      ...f.controller, input: { idempotencyKey: `close-${++sequence}`, action },
    });
    let result: any;
    for (const step of proposal.route) {
      const who = step.groupId === "govern" ? "governor" : step.groupId === "owner" ? "owner" : "finance";
      result = await f.humans[who]!.mutation(closeRef("vote"), {
        scope: f.scope, input: {
          actionId: proposal.actionId, actionHash: proposal.actionHash,
          idempotencyKey: `vote-${++sequence}`, outcome: "approved",
          reason: "Independent review of the exact source, accounting and date",
        },
      });
    }
    return { proposal, result };
  }
  async function retain(text: string) {
    const doc = structuredClone(input.documents[0]!);
    Object.assign(doc, {
      sourceId: `retained-${++sequence}`, deliveryId: `retained-delivery-${sequence}`,
      name: `retained-${sequence}.txt`, kind: "other", mimeType: "text/plain",
    });
    setOriginal(doc, text);
    return f.t.mutation(closeRef("retainEvidence"), { ...f.controller, source: doc });
  }
  const snapshot = () => f.t.run(async ctx => ({
    catalogs: await ctx.db.query("apPhysicalSources").collect(),
    mappings: await ctx.db.query("apPhysicalLineReviews").collect(),
    uses: await ctx.db.query("apReceiptConsumptions").collect(),
    accruals: await ctx.db.query("apAccruals").collect(),
    applications: await ctx.db.query("apAccrualApplications").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
    bills: await ctx.db.query("demoBills").collect(),
    credits: await ctx.db.query("demoCredits").collect(),
  }));
  return { ...f, mapping, approveMapping, view, approveClose, retain, snapshot };
}
