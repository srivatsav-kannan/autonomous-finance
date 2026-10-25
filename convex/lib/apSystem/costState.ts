import { domainRequestSchema } from "../../../src/ap-system/domain-contracts";
import { accrualSchema } from "../../../src/ap-system/close-contracts";
import type { QueryCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import type { BankScope } from "../../../src/integrations/contracts";
import type {
  CostState,
  CostCorrection,
} from "../../../src/ap-system/cost-contracts";
import { CHART } from "../../../src/core/accounts";
import { canonical, sha256Hex } from "../kernel";
import { deny } from "./shared";
import { requireBusinessPolicy } from "./businessAuthority";
import { closeEvidence } from "./closeEvidence";

const costKey = (a: { account: string; store: string | null }) =>
  canonical([a.account, a.store]);
async function checkedJournal(ctx: QueryCtx, scope: BankScope, id: string) {
  const normalized = ctx.db.normalizeId("journalEntries", id);
  const entry = normalized ? await ctx.db.get(normalized) : null;
  if (!entry || entry.runId !== scope.runId || entry.status !== "posted")
    deny("cost_journal_unavailable", "Exact posted cost journal is required");
  const hash = await sha256Hex(
    entry.prevHash +
      canonical({
        sequence: entry.sequence,
        date: entry.date,
        memo: entry.memo,
        source: entry.source,
        lines: entry.lines,
        postedBy: entry.postedBy,
        decisionPath: entry.decisionPath,
        memorySha: entry.memorySha,
      }),
  );
  if (entry.hash !== hash)
    deny(
      "cost_journal_changed",
      "Cost journal differs from its immutable hash",
    );
  return entry;
}
/** Current economic cost, reconstructed from immutable append-only journals.
 * Approval retirement does not undo a posted fact; every new action has its own current approval. */
export async function readCostState(
  ctx: QueryCtx,
  scope: BankScope,
  originalEntryId: string,
): Promise<CostState> {
  const original = await checkedJournal(ctx, scope, originalEntryId);
  if (
    ["ap_cost_adjustment", "ap_accrual_reversal", "vendor_credit"].includes(
      original.source.kind,
    )
  )
    deny(
      "cost_original_required",
      "Use the original invoice/accrual journal, not a correction or reversal journal",
    );
  const originalCosts = original.lines.filter((l) => {
    const a = CHART.find((a) => a.code === l.account);
    return a && !a.cash && ["asset", "expense"].includes(a.type);
  });
  if (
    !originalCosts.length ||
    originalCosts.some((l) =>
      Object.keys(l.dims ?? {}).some((k) => !["vendor", "store"].includes(k)),
    )
  )
    deny(
      "adjustment_dimension_hold",
      "Original cost requires supported supplier/store dimensions",
    );
  const suppliers = new Set(originalCosts.map((l) => l.dims?.vendor ?? null));
  if (suppliers.size !== 1)
    deny(
      "adjustment_dimension_hold",
      "Original cost has ambiguous supplier identity",
    );
  const supplierId = [...suppliers][0]!;
  const bill = (
    await ctx.db
      .query("demoBills")
      .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
      .collect()
  ).find((b) => b.entryId === original._id);
  const accrual = (
    await ctx.db
      .query("apAccruals")
      .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
      .collect()
  ).find((a) => a.entryId === original._id);
  const actions = (
    await ctx.db
      .query("apCloseActions")
      .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
      .collect()
  ).filter(
    (a) =>
      a.status === "approved" &&
      a.kind === "adjustment" &&
      a.payload.originalEntryId === original._id,
  );
  const originalShares: CostState["originalShares"] = [];
  const events: { entry: Doc<"journalEntries">; id: string; hash: string }[] =
    [];
  const corrections: CostState["corrections"] = [];
  for (const action of actions) {
    if (!action.entryId)
      deny(
        "cost_correction_unposted",
        "Approved correction lacks its posted journal",
      );
    const a = action.payload,
      entry = await checkedJournal(ctx, scope, action.entryId);
    const expected = [
      { account: a.toAccount, debit: a.amountCents, credit: 0 },
      { account: a.fromAccount, debit: 0, credit: a.amountCents },
    ];
    if (
      entry.source.kind !== "ap_cost_adjustment" ||
      entry.source.ref !== original._id ||
      entry.date !== a.date ||
      canonical(
        entry.lines.map((l) => ({
          account: l.account,
          debit: l.debit,
          credit: l.credit,
        })),
      ) !== canonical(expected) ||
      entry.lines.some(
        (l) =>
          (l.dims?.vendor ?? null) !== supplierId ||
          (l.dims?.store ?? null) !== a.store ||
          Object.keys(l.dims ?? {}).some(
            (k) => !["vendor", "store"].includes(k),
          ),
      )
    )
      deny(
        "cost_correction_mismatch",
        "Correction journal does not match its immutable approved action",
      );
    const actionHash = await sha256Hex(
      canonical({
        action: a,
        policyHash: action.policyHash,
        contextHash: action.contextHash,
        amountCents: action.amountCents,
        route: action.route,
      }),
    );
    if (actionHash !== action.hash)
      deny("cost_correction_mismatch", "Correction approval changed");
    corrections.push({
      actionId: action._id,
      entryId: entry._id,
      date: entry.date,
      fromAccount: a.fromAccount,
      toAccount: a.toAccount,
      store: a.store,
      amountCents: a.amountCents,
    });
    events.push({ entry, id: action._id, hash: action.hash });
  }
  if (bill) {
    const approvals = (
      await ctx.db
        .query("apApprovalProposals")
        .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
        .collect()
    )
      .filter((p) => p.status === "approved" && p.entryId === bill.entryId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const accepted = approvals[0]
      ? domainRequestSchema.parse(approvals[0].request).acceptance
      : null;
    if (accepted) {
      const add = (
        originalLineId: string,
        allocations: typeof accepted.freightAllocations,
        side: "debit" | "credit",
      ) =>
        allocations.forEach((a, allocationIndex) =>
          originalShares.push({
            ...a,
            originalLineId,
            allocationIndex,
            side,
            remainingCents: a.amountCents,
          }),
        );
      for (const line of accepted.lines)
        add(line.lineId, line.allocations, "credit");
      add("freight", accepted.freightAllocations, "credit");
      add("discount", accepted.discountAllocations, "debit");
    }
    const credits = await ctx.db
      .query("apCreditLinks")
      .withIndex("by_original", (q) =>
        q.eq("scope.runId", scope.runId).eq("originalBillId", bill._id),
      )
      .collect();
    for (const credit of credits) {
      for (const a of credit.allocations) {
        const share = originalShares.find(
          (s) =>
            s.originalLineId === a.originalLineId &&
            s.allocationIndex === a.allocationIndex,
        );
        if (!share)
          deny(
            "cost_original_share",
            "Linked credit lost its original allocation identity",
          );
        share.remainingCents -= a.amountCents;
      }

      const entry = await checkedJournal(ctx, scope, credit.entryId);
      const expected = credit.allocations.map((a: any) => ({
        account: a.account,
        debit: a.side === "debit" ? a.amountCents : 0,
        credit: a.side === "credit" ? a.amountCents : 0,
        store: a.store,
        supplierId,
      }));
      expected.push({
        account: "2000",
        debit: credit.amountCents,
        credit: 0,
        store: null,
        supplierId,
      });
      if (
        entry.source.kind !== "vendor_credit" ||
        canonical(
          entry.lines.map((l) => ({
            account: l.account,
            debit: l.debit,
            credit: l.credit,
            store: l.dims?.store ?? null,
            supplierId: l.dims?.vendor ?? null,
          })),
        ) !== canonical(expected)
      )
        deny(
          "cost_credit_mismatch",
          "Original linked credit allocations differ from posted journal",
        );
      events.push({
        entry,
        id: credit._id,
        hash: await sha256Hex(canonical(credit.allocations)),
      });
    }
  }
  if (accrual) {
    accrualSchema
      .parse(accrual.payload)
      .allocations.forEach((a, allocationIndex) =>
        originalShares.push({
          ...a,
          originalLineId: "accrual",
          allocationIndex,
          side: "credit",
          remainingCents: a.amountCents,
        }),
      );

    const applications = await ctx.db
      .query("apAccrualApplications")
      .withIndex("by_accrual", (q) =>
        q.eq("scope.runId", scope.runId).eq("accrualId", accrual._id),
      )
      .collect();
    for (const app of applications) {
      app.allocations.forEach(
        (
          a: { amountCents: number; originalAllocationIndex?: number },
          i: number,
        ) => {
          const share = originalShares[a.originalAllocationIndex ?? i];
          if (!share)
            deny(
              "cost_original_share",
              "Accrual application lost its original allocation identity",
            );
          share.remainingCents -= a.amountCents;
        },
      );

      const entry = await checkedJournal(ctx, scope, app.entryId);
      const expected = [
        {
          account: "2010",
          debit: app.amountCents,
          credit: 0,
          store: null,
          supplierId,
        },
        ...app.allocations
          .filter((a: any) => a.amountCents > 0)
          .map((a: any) => ({
            account: a.account,
            debit: 0,
            credit: a.amountCents,
            store: a.store,
            supplierId,
          })),
      ];
      if (
        entry.source.kind !== "ap_accrual_reversal" ||
        entry.source.ref !== accrual._id ||
        canonical(
          entry.lines.map((l) => ({
            account: l.account,
            debit: l.debit,
            credit: l.credit,
            store: l.dims?.store ?? null,
            supplierId: l.dims?.vendor ?? null,
          })),
        ) !== canonical(expected)
      )
        deny(
          "cost_reversal_mismatch",
          "Accrual reversal differs from its original application allocations",
        );
      events.push({
        entry,
        id: app._id,
        hash: await sha256Hex(canonical(app.allocations)),
      });
    }
  }
  if (
    originalShares.some(
      (s) => !Number.isSafeInteger(s.remainingCents) || s.remainingCents < 0,
    )
  )
    deny(
      "cost_original_share",
      "Prior credits or accrual applications exceed original allocation capacity",
    );
  for (const { entry } of events)
    if (
      entry.lines.some((l) =>
        Object.keys(l.dims ?? {}).some((k) => !["vendor", "store"].includes(k)),
      )
    )
      deny(
        "adjustment_dimension_hold",
        "Cost history has unsupported dimensions",
      );
  events.sort((a, b) => a.entry.sequence - b.entry.sequence);
  const positions = new Map<string, CostState["positions"][number]>();
  const add = (entry: Doc<"journalEntries">) => {
    for (const l of entry.lines) {
      const chart = CHART.find((a) => a.code === l.account);
      if (!chart || chart.cash || !["asset", "expense"].includes(chart.type))
        continue;
      const p = {
        account: l.account,
        store: l.dims?.store ?? null,
        balanceCents: 0,
      };
      const k = costKey(p),
        old = positions.get(k);
      p.balanceCents = (old?.balanceCents ?? 0) + l.debit - l.credit;
      if (!Number.isSafeInteger(p.balanceCents))
        deny("cost_overflow", "Cost capacity exceeds exact cents");
      positions.set(k, p);
    }
  };
  add(original);
  for (const e of events) add(e.entry);
  const result = {
    originalEntryId: original._id,
    originalShares,
    billId: bill?._id ?? null,
    accrualId: accrual?._id ?? null,
    supplierId,
    latestDate: [original.date, ...events.map((e) => e.entry.date)]
      .sort()
      .at(-1)!,
    positions: [...positions.values()].sort((a, b) =>
      costKey(a).localeCompare(costKey(b)),
    ),
    corrections: corrections.sort((a, b) =>
      a.actionId.localeCompare(b.actionId),
    ),
  };
  return {
    ...result,
    snapshotHash: await sha256Hex(
      canonical({
        originalHash: original.hash,
        events: events.map((e) => ({
          id: e.id,
          hash: e.hash,
          journalHash: e.entry.hash,
        })),
        ...result,
      }),
    ),
  };
}
export type OriginalCostShare = {
  originalLineId: string;
  allocationIndex: number;
  account: string;
  store: string | null;
  treatment: string;
  period: string;
  side: "credit" | "debit";
  amountCents: number;
};
/** Validate replacement shares before their exact immutable posting. */
export async function correctedCostShares(
  ctx: QueryCtx,
  scope: BankScope,
  state: CostState,
  originals: OriginalCostShare[],
  correction: CostCorrection,
  date: string,
): Promise<OriginalCostShare[]> {
  if (state.snapshotHash !== correction.snapshotHash)
    deny(
      "stale_cost_snapshot",
      "Cost changed after the explicit correction plan was prepared",
    );
  if (date < state.latestDate)
    deny(
      "cost_correction_date",
      "A corrected allocation cannot predate an included correction or consumption",
    );
  await closeEvidence(ctx, scope, correction.evidence);
  const policy = await requireBusinessPolicy(ctx, scope);
  const groupKey = (a: { originalLineId: string; allocationIndex: number }) =>
    canonical([a.originalLineId, a.allocationIndex]);
  const groups = new Map(
    originals.filter((a) => a.amountCents > 0).map((a) => [groupKey(a), a]),
  );
  if (groups.size !== originals.filter((a) => a.amountCents > 0).length)
    deny("cost_original_share", "Original allocation identity is ambiguous");
  const actual = new Map<string, number>();
  const output: OriginalCostShare[] = [];
  const unique = new Set<string>();
  for (const a of correction.allocations) {
    const original = groups.get(groupKey(a));
    if (!original || a.side !== original.side || a.store !== original.store)
      deny(
        "cost_original_share",
        "Corrected allocation must preserve original line, allocation share, signed side and store",
      );
    const key = canonical([groupKey(a), a.account, a.store, a.side]);
    if (unique.has(key))
      deny(
        "cost_duplicate_allocation",
        "Combine duplicate correction allocations explicitly",
      );
    unique.add(key);
    const chart = CHART.find((c) => c.code === a.account);
    if (
      !chart ||
      chart.cash ||
      !["asset", "expense"].includes(chart.type) ||
      (a.store !== null && !policy.value.stores.includes(a.store)) ||
      !policy.value.accounts.some(
        (p) => p.account === a.account && p.treatment === a.treatment,
      ) ||
      (a.treatment === "expense"
        ? chart.type !== "expense"
        : chart.type !== "asset")
    )
      deny(
        "cost_correction_account",
        "Corrected cost account/treatment must be explicitly configured and noncash",
      );
    const reachable = new Set([original.account]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of state.corrections)
        if (
          edge.store === a.store &&
          reachable.has(edge.fromAccount) &&
          !reachable.has(edge.toAccount)
        ) {
          reachable.add(edge.toAccount);
          changed = true;
        }
    }
    if (!reachable.has(a.account))
      deny(
        "cost_correction_path",
        "Replacement account lacks an approved reclassification path from this original allocation",
      );
    actual.set(groupKey(a), (actual.get(groupKey(a)) ?? 0) + a.amountCents);
    output.push({ ...a, period: date.slice(0, 7) });
  }
  if ([...groups].some(([key, a]) => actual.get(key) !== a.amountCents))
    deny(
      "cost_original_share",
      "Every original remaining cent share must be allocated exactly once",
    );
  const consumed = new Map<string, number>();
  for (const a of output)
    consumed.set(
      costKey(a),
      (consumed.get(costKey(a)) ?? 0) +
        (a.side === "credit" ? a.amountCents : -a.amountCents),
    );
  for (const [key, amount] of consumed) {
    const available =
      state.positions.find((a) => costKey(a) === key)?.balanceCents ?? 0;
    if (
      (amount > 0 && available < amount) ||
      (amount < 0 && available > amount)
    )
      deny(
        "cost_capacity_exceeded",
        "Signed correction allocation exceeds current remaining corrected cost capacity",
      );
  }
  return output;
}
