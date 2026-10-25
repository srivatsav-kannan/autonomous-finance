import type { QueryCtx } from "../../_generated/server";
import type { BankScope } from "../../../src/integrations/contracts";
import {
  domainRequestSchema,
  creditPlanSchema,
} from "../../../src/ap-system/domain-contracts";
import {
  taxAdjustmentSchema,
  taxPositionKey,
  type TaxAdjustment,
  type TaxShare,
  type TaxState,
  type TaxReversal,
} from "../../../src/ap-system/tax-adjustment-contracts";
import {
  citedDocument,
  taxProportion,
} from "../../../src/ap-system/tax-policy";
import {
  dimensionPolicyProblem,
  sameCoordinates,
} from "../../../src/ap-system/gl-dimensions";
import { CHART } from "../../../src/core/accounts";
import { canonical, sha256Hex } from "../kernel";
import { assertRowScope } from "../demoAuth";
import { deny } from "./shared";
import {
  checkedJournal,
  readCostState,
  correctedCostShares,
} from "./costState";
import { currentSupplier, requireBusinessPolicy } from "./businessAuthority";
import { closeEvidence } from "./closeEvidence";
const dimensions = (a: {
  store: string | null;
  department?: string | null;
  project?: string | null;
}) => ({
  store: a.store,
  department: a.department ?? null,
  project: a.project ?? null,
});
const exactSum = (values: number[]) => {
  const n = values.reduce((n, v) => n + BigInt(v), 0n);
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER))
    deny("tax_capacity", "Tax balance exceeds exact cents");
  return Number(n);
};
function add(buckets: TaxShare[], share: TaxShare, sign = 1) {
  const key = taxPositionKey(share),
    row = buckets.find((b) => taxPositionKey(b) === key);
  const amount = (row?.amountCents ?? 0) + sign * share.amountCents;
  if (!Number.isSafeInteger(amount) || amount < 0)
    deny("tax_capacity", "Tax allocation exceeds its exact remaining bucket");
  if (row) row.amountCents = amount;
  else if (amount) buckets.push({ ...share, amountCents: amount });
}
function applyMovements(buckets: TaxShare[], action: TaxAdjustment) {
  const original = new Map(
    buckets.map((b) => [taxPositionKey(b), b.amountCents]),
  );
  const used = new Map<string, number>();
  const snapshot = () =>
    canonical(
      buckets
        .filter((b) => b.amountCents > 0)
        .slice()
        .sort((a, b) => taxPositionKey(a).localeCompare(taxPositionKey(b))),
    );
  const before = snapshot();
  for (const m of action.movements) {
    const key = taxPositionKey(m.from),
      amount = (used.get(key) ?? 0) + m.from.amountCents;
    if (!Number.isSafeInteger(amount) || amount > (original.get(key) ?? 0))
      deny(
        "tax_capacity",
        "A correction cannot consume the same existing tax cents twice or reuse its intermediate destination",
      );
    used.set(key, amount);
    if (m.from.account === m.toAccount && m.from.treatment === m.toTreatment)
      deny(
        "tax_movement",
        "Tax movement must change a declared account or treatment",
      );
    add(buckets, m.from, -1);
    add(buckets, { ...m.from, account: m.toAccount, treatment: m.toTreatment });
  }
  if (before === snapshot())
    deny(
      "tax_movement",
      "Tax correction must change the supported remaining allocation",
    );
}
function fillAttribution(
  state: Pick<TaxState, "lines" | "buckets">,
  shares: TaxShare[],
) {
  const seen = new Set<string>();
  for (const a of shares) {
    if (
      a.treatment === "tax" ||
      seen.has(taxPositionKey(a)) ||
      !state.lines.some((l) => l.originalLineId === a.originalLineId)
    )
      deny(
        "tax_attribution",
        "Initial cost-tax attribution must use distinct nonrecoverable original shares",
      );
    seen.add(taxPositionKey(a));
    add(state.buckets, a);
  }
  for (const line of state.lines) {
    if (
      exactSum(
        shares
          .filter((a) => a.originalLineId === line.originalLineId)
          .map((a) => a.amountCents),
      ) !== line.unattributedCostCents
    )
      deny(
        "tax_attribution",
        "Explicit initial attribution must cover every remaining nonrecoverable tax cent",
      );
    line.unattributedCostCents = 0;
  }
}
/** Economic events remain facts after a human retires; new actions revalidate current authority. */
export async function readTaxState(
  ctx: QueryCtx,
  scope: BankScope,
  originalEntryId: string,
): Promise<TaxState> {
  const cost = await readCostState(ctx, scope, originalEntryId);
  if (!cost.billId || !cost.supplierId)
    deny(
      "tax_original",
      "Tax adjustment requires an original recognized supplier bill",
    );
  const original = await checkedJournal(ctx, scope, originalEntryId);
  const proposals = (
    await ctx.db
      .query("apApprovalProposals")
      .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
      .collect()
  )
    .filter((p) => p.status === "approved" && p.entryId === original._id)
    .sort((a, b) => a.createdAt - b.createdAt);
  const approval = proposals[0];
  if (!approval)
    deny("tax_original", "Original immutable business approval is unavailable");
  assertRowScope(approval, scope);
  const request = domainRequestSchema.parse(approval.request),
    acceptance = request.acceptance;
  if (!acceptance)
    deny(
      "tax_original",
      "Original approval has no accepted invoice allocation",
    );
  const approvalHash = await sha256Hex(
    canonical({
      request: approval.request,
      policyHash: approval.policyHash,
      supplierHash: approval.supplierHash,
      amountCents: approval.amountCents,
      route: approval.route,
    }),
  );
  if (approvalHash !== approval.hash)
    deny("tax_original", "Original business approval changed");
  const creditRows = await ctx.db
    .query("apCreditLinks")
    .withIndex("by_original", (q) =>
      q.eq("scope.runId", scope.runId).eq("originalBillId", cost.billId as any),
    )
    .collect();
  for (const row of creditRows) assertRowScope(row, scope);
  const credits = await Promise.all(
    creditRows.map(async (row) => ({
      row,
      plan: creditPlanSchema.parse(row.plan),
      entry: await checkedJournal(ctx, scope, row.entryId),
    })),
  );
  const actionRows = (
    await ctx.db
      .query("apCloseActions")
      .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
      .collect()
  ).filter(
    (a) =>
      a.status === "approved" &&
      a.kind === "tax_adjustment" &&
      a.payload.originalEntryId === original._id,
  );
  for (const row of actionRows) assertRowScope(row, scope);
  const actions = await Promise.all(
    actionRows.map(async (row) => ({
      row,
      action: taxAdjustmentSchema.parse(row.payload),
      entry: await checkedJournal(ctx, scope, row.entryId!),
    })),
  );
  actions.sort((a, b) => a.entry.sequence - b.entry.sequence);
  const before = credits.filter(
    (c) => !actions.length || c.entry.sequence < actions[0]!.entry.sequence,
  );
  const buckets: TaxShare[] = [],
    lines: TaxState["lines"] = [];
  for (const line of acceptance.lines.filter((l) => l.tax)) {
    const usedTax = exactSum(
      before
        .flatMap((c) => c.plan.lines)
        .filter((l) => l.originalLineId === line.lineId)
        .map((l) => l.taxCents),
    );
    const remainingTaxCents = line.taxCents - usedTax;
    if (remainingTaxCents < 0)
      deny("tax_capacity", "Historical credit exceeds accepted tax");
    line.allocations.forEach((a, allocationIndex) => {
      if (a.treatment !== "tax") return;
      const used = exactSum(
        before
          .flatMap((c) => c.row.allocations)
          .filter(
            (x: any) =>
              x.originalLineId === line.lineId &&
              x.allocationIndex === allocationIndex,
          )
          .map((x: any) => x.amountCents),
      );
      if (used > a.amountCents)
        deny(
          "tax_capacity",
          "Historical credit exceeds original tax allocation",
        );
      if (a.amountCents - used)
        buckets.push({
          originalLineId: line.lineId,
          allocationIndex,
          account: a.account,
          treatment: "tax",
          ...dimensions(a),
          amountCents: a.amountCents - used,
        });
    });
    const recovery = exactSum(
      buckets
        .filter((b) => b.originalLineId === line.lineId)
        .map((b) => b.amountCents),
    );
    if (recovery > remainingTaxCents)
      deny("tax_capacity", "Remaining recovery exceeds remaining tax");
    lines.push({
      originalLineId: line.lineId,
      taxCode: line.taxCode,
      jurisdiction: line.tax!.jurisdiction,
      priceBasis: line.tax!.priceBasis,
      remainingTaxCents,
      creditBasisTaxCents: remainingTaxCents,
      creditBasisRecoverableCents: recovery,
      creditedTaxCents: 0,
      creditedRecoverableCents: 0,
      unattributedCostCents: remainingTaxCents - recovery,
    });
  }
  if (!lines.length)
    deny(
      "tax_original",
      "Original invoice has no supported recoverable-tax claim",
    );
  if (actions.length) {
    fillAttribution(
      { buckets, lines },
      actions[0]!.action.initialAttribution ?? [],
    );
    const timeline = [
      ...actions.map((a) => ({ ...a, kind: "action" as const })),
      ...credits
        .filter((c) => c.entry.sequence > actions[0]!.entry.sequence)
        .map((c) => ({ ...c, kind: "credit" as const })),
    ].sort((a, b) => a.entry.sequence - b.entry.sequence);
    for (const event of timeline) {
      if (event.kind === "action") {
        if (
          event !== timeline[0] &&
          event.action.initialAttribution !== undefined
        )
          deny(
            "tax_attribution_history",
            "Initial tax attribution cannot be replaced",
          );
        applyMovements(buckets, event.action);
        for (const line of lines) {
          const target = event.action.targets.find(
            (t) => t.originalLineId === line.originalLineId,
          );
          if (
            !target ||
            target.recoverableCents !==
              exactSum(
                buckets
                  .filter(
                    (b) =>
                      b.originalLineId === line.originalLineId &&
                      b.treatment === "tax",
                  )
                  .map((b) => b.amountCents),
              )
          )
            deny(
              "tax_target_history",
              "Posted tax adjustment lost its approved target",
            );
          line.creditBasisTaxCents = line.remainingTaxCents;
          line.creditBasisRecoverableCents = target.recoverableCents;
          line.creditedTaxCents = 0;
          line.creditedRecoverableCents = 0;
        }
      } else {
        const reversal = event.plan.taxReversal;
        if (!reversal)
          deny(
            "tax_reversal_history",
            "Credit after a tax adjustment requires its immutable tax reversal plan",
          );
        validateReversalAmounts(lines, reversal, event.plan.lines);
        const posted = event.row.allocations
          .filter((a: any) => a.component === "tax")
          .map((a: any) => ({
            originalLineId: a.originalLineId,
            allocationIndex: a.allocationIndex,
            account: a.account,
            treatment: a.treatment,
            ...dimensions(a),
            amountCents: a.amountCents,
          }));
        if (canonical(posted) !== canonical(reversal.allocations))
          deny(
            "tax_reversal_history",
            "Posted credit differs from its exact tax reversal allocations",
          );
        for (const a of reversal.allocations) add(buckets, a, -1);
        for (const item of event.plan.lines) {
          const line = lines.find(
            (l) => l.originalLineId === item.originalLineId,
          );
          if (line) {
            line.remainingTaxCents -= item.taxCents;
            line.creditedTaxCents += item.taxCents;
            line.creditedRecoverableCents += exactSum(
              reversal.allocations
                .filter(
                  (a) =>
                    a.originalLineId === line.originalLineId &&
                    a.treatment === "tax",
                )
                .map((a) => a.amountCents),
            );
          }
        }
      }
    }
  }
  for (const line of lines)
    if (
      exactSum(
        buckets
          .filter((b) => b.originalLineId === line.originalLineId)
          .map((b) => b.amountCents),
      ) +
        line.unattributedCostCents !==
      line.remainingTaxCents
    )
      deny(
        "tax_capacity",
        "Tax history does not conserve original remaining tax",
      );
  const result = {
    originalEntryId: original._id,
    originalApprovalId: approval._id,
    billId: cost.billId,
    supplierId: cost.supplierId,
    costSnapshotHash: cost.snapshotHash,
    latestDate: cost.latestDate,
    adjusted: !!actions.length,
    lines,
    buckets: buckets
      .filter((b) => b.amountCents)
      .sort((a, b) => taxPositionKey(a).localeCompare(taxPositionKey(b))),
    events: actions.map((a) => ({
      actionId: a.row._id,
      entryId: a.entry._id,
      date: a.entry.date,
    })),
  };
  return { ...result, snapshotHash: await sha256Hex(canonical(result)) };
}
function validateReversalAmounts(
  lines: TaxState["lines"],
  reversal: TaxReversal,
  items: { originalLineId: string; taxCents: number }[],
) {
  const seen = new Set<string>();
  for (const a of reversal.allocations) {
    if (
      seen.has(taxPositionKey(a)) ||
      !items.some((l) => l.originalLineId === a.originalLineId) ||
      !lines.some((l) => l.originalLineId === a.originalLineId)
    )
      deny(
        "tax_reversal",
        "Tax reversal must use unique exact credited line buckets",
      );
    seen.add(taxPositionKey(a));
  }
  for (const item of items) {
    const expected = lines.some((l) => l.originalLineId === item.originalLineId)
      ? item.taxCents
      : 0;
    if (
      exactSum(
        reversal.allocations
          .filter((a) => a.originalLineId === item.originalLineId)
          .map((a) => a.amountCents),
      ) !== expected
    )
      deny(
        "tax_reversal",
        "Every credited tax cent needs explicit current tax-bucket allocation",
      );
  }
}
export function validateTaxReversal(
  state: TaxState,
  reversal: TaxReversal | undefined,
  items: { originalLineId: string; taxCents: number }[],
) {
  if (!state.adjusted) {
    if (reversal)
      deny(
        "tax_reversal",
        "A current tax adjustment is required for an explicit adjusted-tax reversal",
      );
    return;
  }
  if (!reversal || reversal.snapshotHash !== state.snapshotHash)
    deny(
      "stale_tax_snapshot",
      "Credit must bind the current adjusted tax balance",
    );
  validateReversalAmounts(state.lines, reversal, items);
  for (const item of items) {
    const line = state.lines.find(
      (l) => l.originalLineId === item.originalLineId,
    );
    if (!line) continue;
    const expected = line.creditBasisTaxCents
      ? taxProportion(
          line.creditBasisRecoverableCents,
          line.creditedTaxCents + item.taxCents,
          line.creditBasisTaxCents,
        ) - line.creditedRecoverableCents
      : 0;
    const actual = exactSum(
      reversal.allocations
        .filter(
          (a) =>
            a.originalLineId === item.originalLineId && a.treatment === "tax",
        )
        .map((a) => a.amountCents),
    );
    if (actual !== expected)
      deny(
        "tax_reversal_proportion",
        "Explicit reversal must conserve the current remaining recovery proportion and rounding",
      );
  }
  const copy = structuredClone(state.buckets);
  for (const a of reversal.allocations) add(copy, a, -1);
}
export async function evaluateTaxAdjustment(
  ctx: QueryCtx,
  scope: BankScope,
  action: TaxAdjustment,
) {
  const state = await readTaxState(ctx, scope, action.originalEntryId),
    cost = await readCostState(ctx, scope, action.originalEntryId),
    policy = await requireBusinessPolicy(ctx, scope);
  if (
    state.originalApprovalId !== action.originalApprovalId ||
    state.snapshotHash !== action.taxSnapshotHash ||
    cost.snapshotHash !== action.costSnapshotHash
  )
    deny(
      "stale_tax_snapshot",
      "Tax adjustment must bind original approval and exact current cost/tax snapshots",
    );
  const supplier = await currentSupplier(ctx, scope, state.supplierId);
  if (action.date < state.latestDate)
    deny(
      "tax_adjustment_date",
      "Tax correction cannot predate included accounting events",
    );
  const period = await ctx.db
    .query("periods")
    .withIndex("by_run_period", (q) =>
      q.eq("runId", scope.runId).eq("period", action.date.slice(0, 7)),
    )
    .unique();
  if (!period || period.status !== "open")
    deny(
      "tax_period_closed",
      "Tax adjustment needs an explicitly open accounting period",
    );
  // readTaxState has validated this original approval and its immutable request.
  // A renamed or reclassified copy of that invoice is still invoice self-evidence.
  const originalApprovalId = ctx.db.normalizeId("apApprovalProposals", state.originalApprovalId);
  const originalApproval = originalApprovalId ? await ctx.db.get(originalApprovalId) : null;
  if (!originalApproval) deny("tax_original", "Original business approval is unavailable");
  assertRowScope(originalApproval, scope);
  const originalRequest = domainRequestSchema.parse(originalApproval.request);
  const originalInvoiceHashes = new Set(
    (originalRequest.acceptance?.lines ?? []).flatMap(line =>
      line.tax ? Object.values(line.tax.facts).filter(fact => fact !== undefined).map(fact => fact.source.sha256) : []),
  );
  const evidence = await closeEvidence(
    ctx,
    scope,
    action.eligibilityEvidence.map((e) => e.source),
  );
  if (
    action.eligibilityEvidence.some((e) => {
      const doc = citedDocument(e, evidence);
      return !doc || !["other", "contract", "correction"].includes(doc.kind) || originalInvoiceHashes.has(doc.sha256);
    })
  )
    deny(
      "tax_eligibility_evidence",
      "Eligibility correction needs exact independently retained evidence, never invoice self-assertion",
    );
  const buckets = structuredClone(state.buckets),
    lines = structuredClone(state.lines);
  if (state.adjusted && action.initialAttribution !== undefined)
    deny("tax_attribution", "Initial reviewed attribution is immutable");
  if (!state.adjusted) {
    const shares = action.initialAttribution ?? [];
    fillAttribution({ buckets, lines }, shares);
    if (shares.length) {
      const originals = [
        ...new Set(
          shares.map((a) => `${a.originalLineId}:${a.allocationIndex}`),
        ),
      ].map((key) => {
        const items = shares.filter(
            (a) => `${a.originalLineId}:${a.allocationIndex}` === key,
          ),
          first = items[0]!,
          original = cost.originalShares.find(
            (s) =>
              s.originalLineId === first.originalLineId &&
              s.allocationIndex === first.allocationIndex,
          );
        if (
          !original ||
          original.treatment === "tax" ||
          original.side !== "credit"
        )
          deny(
            "tax_attribution",
            "Cost-tax attribution must retain an original non-tax debit lineage",
          );
        const amountCents = exactSum(items.map((a) => a.amountCents));
        if (amountCents > original.remainingCents)
          deny(
            "tax_attribution",
            "Tax attribution exceeds original remaining allocation lineage",
          );
        return { ...original, amountCents };
      });
      await correctedCostShares(
        ctx,
        scope,
        cost,
        originals,
        {
          snapshotHash: cost.snapshotHash,
          allocations: shares.map((a) => ({
            ...a,
            treatment: a.treatment as
              "expense" | "inventory" | "fixed_asset" | "prepayment",
            side: "credit" as const,
          })),
          evidence: action.eligibilityEvidence.map((e) => e.source),
          reason: action.reason,
        },
        action.date,
      );
    }
  }
  const groupIds: string[] = [];
  if (
    new Set(action.targets.map((t) => t.originalLineId)).size !==
      action.targets.length ||
    action.targets.length !== lines.length
  )
    deny(
      "tax_target",
      "Every original tax line needs one explicit remaining recovery target",
    );
  for (const line of lines) {
    const rule = policy.value.taxCodes.find(
        (t) => t.code === line.taxCode && t.mode === "recoverable",
      )?.recovery,
      target = action.targets.find(
        (t) => t.originalLineId === line.originalLineId,
      );
    if (
      !rule ||
      !rule.adjustments ||
      !target ||
      rule.jurisdiction !== line.jurisdiction ||
      !rule.priceBases.includes(line.priceBasis) ||
      action.date < rule.effectiveFrom ||
      action.date > rule.effectiveThrough ||
      target.recoverableCents !==
        taxProportion(line.remainingTaxCents, rule.recoverableBps, 10000)
    )
      deny(
        "tax_target",
        "Remaining tax recovery target must equal the current explicit effective policy",
      );
    if (!groupIds.includes(rule.approvalGroupId))
      groupIds.push(rule.approvalGroupId);
  }
  for (const m of action.movements) {
    const line = lines.find((l) => l.originalLineId === m.from.originalLineId),
      rule = policy.value.taxCodes.find(
        (t) => t.code === line?.taxCode,
      )?.recovery;
    for (const a of [
      m.from,
      { ...m.from, account: m.toAccount, treatment: m.toTreatment },
    ]) {
      const chart = CHART.find((c) => c.code === a.account);
      if (
        !chart ||
        chart.cash ||
        !["expense", "asset"].includes(chart.type) ||
        !policy.value.accounts.some(
          (p) => p.account === a.account && p.treatment === a.treatment,
        ) ||
        dimensionPolicyProblem(a, policy.value) ||
        (a.store !== null && !policy.value.stores.includes(a.store)) ||
        (a.treatment === "expense"
          ? chart.type !== "expense"
          : chart.type !== "asset")
      )
        deny(
          "tax_account",
          "Tax adjustments require exact supported noncash cost/receivable accounts and dimensions",
        );
    }
    if (m.toTreatment === "tax" && m.toAccount !== rule?.receivableAccount)
      deny(
        "tax_account",
        "Recovery destination must be the current explicitly configured receivable",
      );
  }
  applyMovements(buckets, action);
  for (const line of lines)
    if (
      action.targets.find((t) => t.originalLineId === line.originalLineId)!
        .recoverableCents !==
      exactSum(
        buckets
          .filter(
            (b) =>
              b.originalLineId === line.originalLineId && b.treatment === "tax",
          )
          .map((b) => b.amountCents),
      )
    )
      deny(
        "tax_target",
        "Exact movement allocations do not achieve the approved recovery target",
      );
  const positions = cost.positions.map((p) => ({ ...p }));
  for (const m of action.movements) {
    const from = positions.find(
      (p) => p.account === m.from.account && sameCoordinates(p, m.from),
    );
    if (!from || from.balanceCents < m.from.amountCents)
      deny(
        "tax_capacity",
        "Tax correction exceeds remaining posted cost position",
      );
    from.balanceCents -= m.from.amountCents;
    const to = positions.find(
      (p) => p.account === m.toAccount && sameCoordinates(p, m.from),
    );
    if (to) to.balanceCents += m.from.amountCents;
    else
      positions.push({
        account: m.toAccount,
        ...dimensions(m.from),
        balanceCents: m.from.amountCents,
      });
  }
  return {
    state,
    buckets,
    groupIds,
    amountCents: exactSum(action.movements.map((m) => m.from.amountCents)),
    supplierHash: supplier.hash,
  };
}

export async function optionalTaxState(
  ctx: QueryCtx,
  scope: BankScope,
  originalEntryId: string,
) {
  const proposals = await ctx.db
    .query("apApprovalProposals")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  if (
    !proposals.some(
      (p) =>
        p.status === "approved" &&
        p.entryId === originalEntryId &&
        domainRequestSchema
          .parse(p.request)
          .acceptance?.lines.some((l) => l.tax),
    )
  )
    return null;
  return readTaxState(ctx, scope, originalEntryId);
}
