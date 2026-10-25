import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import type { BankScope } from "../../../src/integrations/contracts";
import {
  intakeSchema,
  decisionSchema,
  type APIntake,
  type SourceBinding,
} from "../../../src/ap-system/contracts";
import {
  physicalMappingProposalSchema,
  type PhysicalMappingProposal,
  type PhysicalLine,
} from "../../../src/ap-system/physical-line-contracts";
import type { Consumption } from "../../../src/ap-system/business-policy";
import { quantityMicros } from "../../../src/ap-system/accounting";
import { canonical, sha256Hex } from "../kernel";
import { assertRowScope } from "../demoAuth";
import { caseRow, deny } from "./shared";
import {
  assertHumanSubject,
  requireBusinessPolicy,
  requireGroup,
} from "./businessAuthority";
const sourceKey = (s: SourceBinding) => canonical(s);
const itemKey = (l: {
  sku: string;
  unit: string;
  unitPriceCents: number | null;
}) => canonical([l.sku, l.unit, l.unitPriceCents]);
export async function physicalCatalog(
  ctx: QueryCtx,
  scope: BankScope,
  hash: string,
) {
  const row = await ctx.db
    .query("apPhysicalSources")
    .withIndex("by_hash", (q) =>
      q.eq("scope.runId", scope.runId).eq("sourceHash", hash),
    )
    .unique();
  if (row) assertRowScope(row, scope);
  return row;
}
export function parsedPhysicalSource(input: APIntake, source: SourceBinding) {
  const doc = input.documents.find(
    (d) =>
      sourceKey({
        sourceId: d.sourceId,
        revision: d.revision,
        sha256: d.sha256,
      }) === sourceKey(source),
  );
  const matches = input.purchasingEvidence.filter(
    (p) => sourceKey(p.source) === sourceKey(source),
  );
  if (
    !doc ||
    matches.length !== 1 ||
    doc.pageStatus.some((p) => p.status !== "complete")
  )
    deny(
      "physical_source_required",
      "One complete exact original and purchasing line set must support the mapping",
    );
  const p = matches[0]!;
  const expected = p.kind === "service_acceptance" ? "receipt" : p.kind;
  if (
    doc.kind !== expected &&
    !(
      input.candidate?.kind === "credit_note" &&
      p.kind === "receipt" &&
      doc.kind === "correction"
    )
  )
    deny(
      "physical_source_kind",
      "The retained original kind must match its purchasing/receiving purpose",
    );
  if (input.candidate?.supplierId !== p.supplierId)
    deny(
      "physical_source_supplier",
      "The reviewed candidate and purchasing original must bind the same supplier",
    );
  if (
    !p.supplierId ||
    new Set(p.lines.map((l) => l.lineId)).size !== p.lines.length ||
    !p.lines.length
  )
    deny(
      "physical_source_ambiguous",
      "Parser line labels must be distinct within one supplier original",
    );
  const purpose =
    input.candidate?.kind === "credit_note" && p.kind === "receipt"
      ? "return"
      : p.kind;
  return {
    doc,
    p,
    purpose,
    lines: p.lines
      .map((l) => ({
        parserLineId: l.lineId,
        invoiceLineId: l.invoiceLineId,
        sku: l.sku,
        unit: l.quantity.unit,
        quantity: l.quantity.decimal,
        unitPriceCents: l.unitPriceCents,
      }))
      .sort((a, b) => a.parserLineId.localeCompare(b.parserLineId)),
  };
}
export async function physicalParsedHash(
  input: APIntake,
  source: SourceBinding,
) {
  const p = parsedPhysicalSource(input, source);
  return sha256Hex(
    canonical({
      source,
      purpose: p.purpose,
      supplierId: p.p.supplierId,
      lines: p.lines,
    }),
  );
}
export async function validatePhysicalProposal(
  ctx: QueryCtx,
  scope: BankScope,
  proposal: PhysicalMappingProposal,
) {
  const row = await caseRow(ctx, scope, proposal.caseId),
    policy = await requireBusinessPolicy(ctx, scope);
  if (!policy.value.receiptIdentityApprovalGroup)
    deny(
      "physical_policy_required",
      "Explicitly configure the human receipt identity approval group",
    );
  if (
    row.currentRevision !== proposal.expectedRevision ||
    row.snapshotHash !== proposal.snapshotHash ||
    row.documentStatus !== "reviewed" ||
    !row.fieldReviewId
  )
    deny(
      "physical_review_stale",
      "Mapping requires the current field-reviewed case and exact revision/snapshot",
    );
  const decisions = await ctx.db
    .query("apCaseDecisions")
    .withIndex("by_case", (q) =>
      q.eq("scope.runId", scope.runId).eq("caseId", row._id),
    )
    .collect();
  if (
    !decisions.some((d) => {
      const value = decisionSchema.parse(d.decision);
      return (
        value.decisionId === row.fieldReviewId &&
        value.kind === "field_review" &&
        value.outcome === "approved" &&
        value.candidateRevision === row.currentRevision &&
        value.snapshotHash === row.snapshotHash
      );
    })
  )
    deny(
      "physical_review_stale",
      "The case's retained human field review is not current",
    );
  const input = intakeSchema.parse(row.intake),
    parsed = parsedPhysicalSource(input, proposal.source);
  const known = await physicalCatalog(ctx, scope, proposal.source.sha256);
  if (proposal.catalogId) {
    if (
      !known ||
      known._id !== proposal.catalogId ||
      known.supplierId !== parsed.p.supplierId ||
      known.purpose !== parsed.purpose
    )
      deny(
        "physical_catalog_mismatch",
        "Use the existing immutable catalog for this exact original, supplier and purpose",
      );
  } else if (known)
    deny(
      "physical_catalog_exists",
      "This original already has a catalog; new parser labels cannot create another capacity",
    );
  if (!known) {
    const prior = await ctx.db
      .query("apReceiptConsumptions")
      .withIndex("by_bill", (q) => q.eq("scope.runId", scope.runId))
      .collect();
    const accruals = await ctx.db
      .query("apAccruals")
      .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
      .collect();
    if (
      prior.some(
        (p) =>
          p.sourceHash === proposal.source.sha256 ||
          p.sourceId === proposal.source.sourceId,
      ) ||
      accruals.some(
        (a) =>
          a.payload.source.sha256 === proposal.source.sha256 ||
          a.sourceId === proposal.source.sourceId,
      )
    )
      deny(
        "physical_legacy_usage",
        "Already used originals cannot receive a guessed allocation to new physical identities; preserve their original capacity hold",
      );
  }
  const physical: PhysicalLine[] = known
    ? known.payload.physicalLines
    : proposal.physicalLines!;
  if (new Set(physical.map((l) => l.physicalLineId)).size !== physical.length)
    deny("physical_line_duplicate", "Physical line identities must be unique");
  for (const [i, l] of physical.entries()) {
    const loc = l.locator;
    const unitPattern = l.unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quantities = [
      ...loc.quote.matchAll(
        new RegExp(
          `(?:^|[^a-zA-Z0-9_.])([0-9]+(?:\\.[0-9]{1,6})?)\\s+${unitPattern}(?=$|[^a-zA-Z0-9_])`,
          "g",
        ),
      ),
    ];
    if (
      !quantities.some(
        (match) => quantityMicros(match[1]!) === quantityMicros(l.capacity),
      )
    )
      deny(
        "physical_locator_quantity",
        "The physical source span must explicitly state this line's exact quantity and unit",
      );
    if (
      quantityMicros(l.capacity) <= 0n ||
      loc.page > parsed.doc.pageCount ||
      loc.end <= loc.start ||
      parsed.doc.extractedText.slice(loc.start, loc.end) !== loc.quote ||
      !loc.quote.includes(l.sku) ||
      !loc.quote.includes(l.unit)
    )
      deny(
        "physical_locator_invalid",
        "Every physical line needs a positive capacity and an exact original text span identifying SKU and unit for human review",
      );
    if (
      physical
        .slice(0, i)
        .some(
          (other) =>
            loc.start < other.locator.end && other.locator.start < loc.end,
        )
    )
      deny(
        "physical_locator_overlap",
        "Two physical lines cannot reuse overlapping original text evidence",
      );
  }
  const perParser = new Map<string, bigint>(),
    perPhysical = new Map<string, bigint>(),
    seen = new Set<string>();
  for (const link of proposal.links) {
    const l = parsed.lines.find((l) => l.parserLineId === link.parserLineId),
      p = physical.find((p) => p.physicalLineId === link.physicalLineId),
      n = quantityMicros(link.quantity),
      key = canonical([link.parserLineId, link.physicalLineId]);
    if (!l || !p || n <= 0n || itemKey(l) !== itemKey(p) || seen.has(key))
      deny(
        "physical_mapping_invalid",
        "Mappings must uniquely conserve matching SKU, unit, price and positive quantities",
      );
    seen.add(key);
    perParser.set(l.parserLineId, (perParser.get(l.parserLineId) ?? 0n) + n);
    perPhysical.set(
      p.physicalLineId,
      (perPhysical.get(p.physicalLineId) ?? 0n) + n,
    );
  }
  if (
    parsed.lines.some(
      (l) => perParser.get(l.parserLineId) !== quantityMicros(l.quantity),
    ) ||
    physical.some(
      (l) => perPhysical.get(l.physicalLineId) !== quantityMicros(l.capacity),
    )
  )
    deny(
      "physical_capacity_mismatch",
      "Every parsed and physical line must reconcile exactly; splitting or merging cannot create capacity",
    );
  return {
    row,
    input,
    policy,
    parsed,
    physical,
    known,
    parsedHash: await physicalParsedHash(input, proposal.source),
  };
}
export async function approvedPhysicalReview(
  ctx: QueryCtx,
  scope: BankScope,
  reviewId: string,
) {
  const id = ctx.db.normalizeId("apPhysicalLineReviews", reviewId),
    review = id ? await ctx.db.get(id) : null;
  if (
    !review ||
    review.status !== "approved" ||
    !review.catalogId ||
    !review.decision
  )
    deny(
      "physical_review_required",
      "A positive independent physical identity review is required",
    );
  assertRowScope(review, scope);
  const policy = await requireBusinessPolicy(ctx, scope),
    group = policy.value.receiptIdentityApprovalGroup;
  if (!group)
    deny(
      "physical_policy_required",
      "The receipt identity reviewer group is not configured",
    );
  requireGroup(policy.value, group, review.decision.subject);
  const human = await assertHumanSubject(ctx, scope, review.decision.subject);
  if (
    human.seatId !== review.decision.seatId ||
    human.seatId === review.proposedBy
  )
    deny(
      "physical_reviewer_changed",
      "Mapping approval must retain its independent active human seat",
    );
  const catalog = await ctx.db.get(review.catalogId);
  if (!catalog)
    deny(
      "physical_catalog_missing",
      "The immutable physical catalog is missing",
    );
  assertRowScope(catalog, scope);
  return {
    review,
    catalog,
    proposal: physicalMappingProposalSchema.parse(review.proposal),
  };
}
export type ResolvedPhysicalClaim = {
  catalog: Doc<"apPhysicalSources">;
  reviewId: Id<"apPhysicalLineReviews">;
  physicalLine: PhysicalLine;
  quantity: string;
};
export async function resolvePhysicalClaim(
  ctx: QueryCtx,
  scope: BankScope,
  caseId: Id<"apCaseRecords">,
  input: APIntake,
  claim: Consumption,
): Promise<ResolvedPhysicalClaim[] | null> {
  const known = await physicalCatalog(ctx, scope, claim.source.sha256);
  if (!claim.identity) {
    if (known)
      deny(
        "physical_review_required",
        "This original has a physical catalog; every claim must use an explicit positively reviewed mapping",
      );
    return null;
  }
  const { review, catalog, proposal } = await approvedPhysicalReview(
    ctx,
    scope,
    claim.identity.reviewId,
  );
  const row = await caseRow(ctx, scope, caseId);
  if (
    catalog._id !== known?._id ||
    review.caseId !== caseId ||
    proposal.expectedRevision !== row.currentRevision ||
    proposal.snapshotHash !== row.snapshotHash ||
    sourceKey(proposal.source) !== sourceKey(claim.source) ||
    review.parsedHash !== (await physicalParsedHash(input, claim.source))
  )
    deny(
      "physical_review_stale",
      "Mapping must bind this current case, source revision and complete parsed line set",
    );
  if (
    catalog.supplierId !== input.candidate?.supplierId ||
    catalog.purpose !== claim.kind
  )
    deny(
      "physical_purpose_mismatch",
      "Physical capacity cannot change supplier or economic purpose",
    );
  const result: ResolvedPhysicalClaim[] = [],
    seen = new Set<string>();
  let total = 0n;
  for (const allocation of claim.identity.allocations) {
    const physicalLine: PhysicalLine | undefined =
      catalog.payload.physicalLines.find(
        (l: PhysicalLine) => l.physicalLineId === allocation.physicalLineId,
      );
    const link = proposal.links.find(
        (l) =>
          l.parserLineId === claim.lineId &&
          l.physicalLineId === allocation.physicalLineId,
      ),
      n = quantityMicros(allocation.quantity);
    if (
      !physicalLine ||
      !link ||
      seen.has(allocation.physicalLineId) ||
      n <= 0n ||
      n > quantityMicros(link.quantity) ||
      physicalLine.sku !== claim.sku ||
      physicalLine.unit !== claim.unit
    )
      deny(
        "physical_claim_invalid",
        "Explicit claim allocation must fit each reviewed parser-to-physical link",
      );
    seen.add(allocation.physicalLineId);
    total += n;
    result.push({
      catalog,
      reviewId: review._id,
      physicalLine,
      quantity: allocation.quantity,
    });
  }
  if (total !== quantityMicros(claim.quantity))
    deny(
      "physical_claim_sum",
      "Physical quantities must exactly equal the requested claim; partial merged lines are never inferred",
    );
  return result;
}
