import { makeFunctionReference } from "convex/server";
import type { CreditPlan, ApprovalStep } from "../../src/ap-system/domain-contracts";
import type { TaxClaim } from "../../src/ap-system/tax-contracts";
import { packet } from "./accounting-fixture";
import { acceptance, binding, br, businessFixture, policy, subject, syncPrimary } from "./business-fixture";
import { cite, setText, syntheticTaxRule, taxEvidenceFixture } from "./tax-fixture";

export async function taxBusinessFixture(options: { recoveryBps?: number; stated?: boolean; basis?: "exclusive" | "inclusive"; settlementDepartment?: boolean } = {}) {
  const basis = options.basis ?? "exclusive";
  const input = packet("TAX-INVOICE");
  const c = input.candidate!;
  c.lines[0]!.taxCents = 770; c.taxCents = 770; c.totalCents = 8470;
  c.lines[0]!.allocations[0]!.amountCents = 8470;
  syncPrimary(input);
  const source = taxEvidenceFixture(basis);
  const doc = input.documents[0]!;
  setText(doc, `${doc.extractedText}\n${source.documents[0]!.extractedText}`);
  c.evidence.forEach(e => { e.source = binding(doc); });
  input.documents.push(source.documents.at(-1)!);
  c.sources = input.documents.map(binding);
  const claim: TaxClaim = structuredClone(source.claim);
  for (const [key, value] of Object.entries(claim.facts)) {
    (claim.facts as any)[key] = { ...value, ...cite(doc, value.rawValue) };
  }
  if (options.stated) { claim.calculation = "stated_amount"; claim.rateBps = null; delete claim.facts.rate; }
  const p = policy(); p.version = "synthetic-tax-policy-v1";
  p.groups.push({ groupId: "tax-review", members: [subject("second")] });
  p.accounts.push({ account: "1180", treatment: "tax" });
  const recovery = { ...syntheticTaxRule(), recoverableBps: options.recoveryBps ?? 10000 };
  p.taxCodes = [{ code: "NONE", mode: "none" }, { code: "COST", mode: "nonrecoverable" }, { code: "TEST", mode: "recoverable", recovery }];
  if (options.settlementDepartment) p.dimensions = { version: "ap-gl-dimensions-v1", scope: "cost_and_settlement", departments: ["operations"], projects: [], settlementDepartment: "homogeneous_approved_department" };
  const f = await businessFixture({ input, policy: p });
  const a = acceptance(input);
  claim.recoverableCents = Math.round(770 * recovery.recoverableBps / 10000);
  a.lines[0]!.taxCode = "TEST"; a.lines[0]!.tax = claim;
  const allocation = a.lines[0]!.allocations[0]!;
  a.lines[0]!.allocations = [
    { ...allocation, amountCents: 8470 - claim.recoverableCents },
    { ...allocation, account: "1180", treatment: "tax", amountCents: claim.recoverableCents },
  ];
  if (options.settlementDepartment) a.lines[0]!.allocations.forEach(allocation => { allocation.department = "operations"; });
  async function approve(prop: { proposalId: string; proposalHash: string; route: ApprovalStep[] }) {
    let result: any;
    for (const step of prop.route) result = await f.vote(prop, step.groupId === "tax-review" ? "second" : step.groupId === "owner" ? "owner" : "finance");
    return result;
  }
  async function credit(originalApprovalId: string, number: string, net: number, tax: number, basis: CreditPlan["lines"][number]["basis"] = "quantity_return") {
    const next = packet(number), candidate = next.candidate!, line = candidate.lines[0]!;
    candidate.kind = "credit_note"; next.documents[0]!.kind = "credit_note";
    line.quantity.decimal = basis === "quantity_return" ? "1" : "0";
    line.unitPriceCents = basis === "quantity_return" ? net : 0;
    line.amountCents = net; line.taxCents = tax; line.allocations[0]!.amountCents = net + tax;
    candidate.subtotalCents = net; candidate.taxCents = tax; candidate.totalCents = net + tax;
    setText(next.documents[2]!, `Return ${number}: received KALE-24 1 case by receiving-owner on 2026-10-19`);
    next.purchasingEvidence[1]!.source = binding(next.documents[2]!);
    next.purchasingEvidence[1]!.lines[0]!.quantity.decimal = "1";
    syncPrimary(next);
    const detail = await f.reviewed(next);
    const plan: CreditPlan = { originalCaseId: f.detail.caseId, originalApprovalId, freightCents: 0, discountCents: 0,
      lines: [{ creditLineId: "line-1", originalLineId: "line-1", basis, quantity: basis === "quantity_return" ? "1" : "0", netCents: net, taxCents: tax, returnEvidence: basis === "quantity_return" ? [binding(next.documents[2]!)] : [] }], reason: "Explicit linked supplier credit from original amounts" };
    const propose = () => f.t.mutation(br.propose!, { ...f.ap, input: { caseId: detail.caseId, expectedRevision: detail.revision, snapshotHash: detail.snapshotHash, idempotencyKey: number, policyVersion: p.version, supplierRevision: 1, credit: plan } });
    return { detail, plan, propose };
  }
  const state = () => f.t.run(async ctx => ({ journals: await ctx.db.query("journalEntries").collect(), bills: await ctx.db.query("demoBills").collect(), credits: await ctx.db.query("apCreditLinks").collect(), commands: await ctx.db.query("demoCommands").collect() }));
  const close = makeFunctionReference<"mutation">("apClose:propose");
  return { ...f, a, approve, credit, state, close };
}
