import { readCostState, correctedCostShares } from "./costState";
import type { CostCorrection } from "../../../src/ap-system/cost-contracts";
import type { QueryCtx, MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import type { BankScope } from "../../../src/integrations/contracts";
import {
  accrualSchema,
  type Accrual,
  type AccrualApplication,
} from "../../../src/ap-system/close-contracts";
import type { BusinessAcceptance } from "../../../src/ap-system/domain-contracts";
import {
  lineCents,
  quantityMicros,
  sumCents,
} from "../../../src/ap-system/accounting";
import {
  allocateCents,
  proportionalCents,
  quantityString,
} from "../../../src/ap-system/business-policy";
import { CHART } from "../../../src/core/accounts";
import { deny, caseRow } from "./shared";
import { currentSupplier, requireBusinessPolicy } from "./businessAuthority";
import { closeEvidence } from "./closeEvidence";
import { sourceSemanticHash } from "./businessLedger";
import {
  intakeSchema,
  type PurchasingEvidence,
} from "../../../src/ap-system/contracts";
import { appendDemoEntry } from "../demoPost";
import { accountingSeat, assertRowScope } from "../demoAuth";
export async function validateAccrual(
  ctx: QueryCtx,
  scope: BankScope,
  a: Accrual,
) {
  const policy = await requireBusinessPolicy(ctx, scope);
  const supplier = await currentSupplier(ctx, scope, a.supplierId);
  const [source] = await closeEvidence(ctx, scope, [a.source]);
  if (
    !source ||
    !["receipt", "contract", "correction", "other"].includes(source.kind) ||
    !source.extractedText.includes(a.quote) ||
    source.pageStatus.some((p) => p.status !== "complete")
  )
    deny(
      "accrual_source",
      "Received/service accrual requires complete retained evidence and an exact source quote for independent human review",
    );
  if (
    quantityMicros(a.quantity) <= 0n ||
    quantityMicros(a.quantity) > quantityMicros(a.capacityQuantity)
  )
    deny(
      "accrual_quantity",
      "Positive accrued units cannot exceed documented source capacity",
    );
  const amountCents = lineCents(a.quantity, a.unitPriceCents);
  if (
    !amountCents ||
    sumCents(a.allocations.map((x) => x.amountCents)) !== amountCents
  )
    deny(
      "accrual_amount",
      "Accrual units, unit estimate and cost allocation must reconcile exactly",
    );
  for (const x of a.allocations) {
    const account = CHART.find((c) => c.code === x.account);
    if (
      !policy.value.accounts.some(
        (p) => p.account === x.account && p.treatment === x.treatment,
      ) ||
      !account ||
      account.cash ||
      !["asset", "expense"].includes(account.type) ||
      x.treatment === "tax" ||
      (x.treatment === "expense"
        ? account.type !== "expense"
        : account.type !== "asset") ||
      x.department !== null ||
      x.project !== null ||
      x.period !== a.date.slice(0, 7) ||
      (x.store !== null && !policy.value.stores.includes(x.store))
    )
      deny(
        "accrual_coding",
        "Accrual coding requires configured noncash cost accounts, supported dimensions and exact accounting period",
      );
  }
  const cases = await ctx.db
    .query("apCaseRecords")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const sources = cases
    .flatMap((row) => intakeSchema.parse(row.intake).purchasingEvidence)
    .filter((p) => p.source.sha256 === a.source.sha256);
  const evidence: PurchasingEvidence[] = sources.length
    ? sources
    : [
        {
          supplierId: a.supplierId,
          source: a.source,
          kind: source.kind === "contract" ? "contract" : "receipt",
          reference: a.lineId,
          acceptedBy: null,
          acceptedAt: null,
          lines: [
            {
              lineId: a.lineId,
              sku: a.sku,
              quantity: { decimal: a.capacityQuantity, unit: a.unit },
              unitPriceCents: a.unitPriceCents,
              invoiceLineId: a.lineId,
            },
          ],
        },
      ];
  const signatures = await Promise.all(
    evidence.map((p) =>
      sourceSemanticHash({ purchasingEvidence: [p] }, a.source.sha256),
    ),
  );
  if (new Set(signatures).size !== 1)
    deny(
      "accrual_source_conflict",
      "Same original bytes have conflicting parsed purchasing line sets",
    );
  const sourceHash = signatures[0]!;
  const lines = evidence[0]!.lines.filter(
    (l) => l.sku === a.sku && l.quantity.unit === a.unit,
  );
  if (
    evidence[0]!.supplierId !== a.supplierId ||
    lines.length !== 1 ||
    quantityMicros(lines[0]!.quantity.decimal) !==
      quantityMicros(a.capacityQuantity) ||
    (lines[0]!.unitPriceCents !== null &&
      lines[0]!.unitPriceCents !== a.unitPriceCents)
  )
    deny(
      "accrual_source_conflict",
      "Accrual must identify one unchanged documented SKU/unit/capacity; ambiguous physical lines require repair",
    );
  const allPrevious = await ctx.db
    .query("apAccruals")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  if (
    allPrevious.some(
      (r) =>
        r.payload.source.sha256 === a.source.sha256 &&
        r.sourceSemanticHash !== sourceHash,
    )
  )
    deny(
      "accrual_source_conflict",
      "Identical original bytes cannot gain a different semantic capacity by changing parser labels",
    );
  const previous = allPrevious.filter((r) => {
    const old = accrualSchema.parse(r.payload);
    return (
      old.sku === a.sku &&
      old.unit === a.unit &&
      (old.source.sourceId === a.source.sourceId ||
        old.source.sha256 === a.source.sha256)
    );
  });
  const outstanding = previous.reduce(
    (n, r) =>
      n + quantityMicros(r.quantity) - quantityMicros(r.reversedQuantity),
    0n,
  );
  if (
    outstanding + quantityMicros(a.quantity) >
    quantityMicros(a.capacityQuantity)
  )
    deny("accrual_units_used", "Documented received units are already accrued");
  const allInvoiceUses = await ctx.db
    .query("apReceiptConsumptions")
    .withIndex("by_bill", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  if (
    allInvoiceUses.some(
      (r) =>
        r.sourceHash === a.source.sha256 && r.sourceSemanticHash !== sourceHash,
    )
  )
    deny(
      "accrual_source_conflict",
      "Original already recognized with another or unavailable semantic line set",
    );
  const invoiceUses = allInvoiceUses.filter(
    (r) =>
      r.sku === a.sku &&
      r.unit === a.unit &&
      (r.sourceId === a.source.sourceId || r.sourceHash === a.source.sha256) &&
      r.kind !== "return",
  );
  if (
    invoiceUses.reduce((n, r) => n + quantityMicros(r.quantity), 0n) +
      outstanding +
      quantityMicros(a.quantity) >
    quantityMicros(a.capacityQuantity)
  )
    deny(
      "accrual_already_invoiced",
      "Received units already recognized as invoices cannot be accrued again",
    );
  if (a.expectedInvoiceCaseId) {
    const row = await caseRow(ctx, scope, a.expectedInvoiceCaseId);
    if (
      row.billId ||
      row.creditId ||
      (row.intake.candidate?.supplierId &&
        row.intake.candidate.supplierId !== a.supplierId)
    )
      deny(
        "accrual_case_conflict",
        "Accrual disposition must name an unrecognized case for the same supplier",
      );
  }
  return {
    amountCents,
    policy,
    supplierHash: supplier.hash,
    sourceSemanticHash: sourceHash,
  };
}
export async function accrualReversalPlan(
  ctx: QueryCtx,
  scope: BankScope,
  id: string,
  quantity: string,
  correction?: CostCorrection,
  accountingDate?: string,
) {
  const accrualId = ctx.db.normalizeId("apAccruals", id);
  const row = accrualId ? await ctx.db.get(accrualId) : null;
  if (!row) deny("accrual_missing", "Accrual not found");
  assertRowScope(row, scope);
  const count = quantityMicros(quantity),
    used = quantityMicros(row.reversedQuantity),
    total = quantityMicros(row.quantity);
  if (count <= 0n || used + count > total)
    deny("accrual_reversal_excess", "Reversal exceeds remaining accrued units");
  const amountCents =
    proportionalCents(row.amountCents, used + count, total) - row.reversedCents;
  if (!amountCents)
    deny("accrual_reversal_zero", "Reversal must discharge at least one cent");
  const a = accrualSchema.parse(row.payload);
  const prior = await ctx.db
    .query("apAccrualApplications")
    .withIndex("by_accrual", (q) =>
      q.eq("scope.runId", scope.runId).eq("accrualId", row._id),
    )
    .collect();
  const amounts = allocateCents(
    amountCents,
    a.allocations.map(
      (x, i) =>
        x.amountCents -
        prior.reduce(
          (n, p) =>
            n +
            p.allocations.reduce(
              (
                v: number,
                a: { amountCents: number; originalAllocationIndex?: number },
                j: number,
              ) =>
                v +
                ((a.originalAllocationIndex ?? j) === i ? a.amountCents : 0),
              0,
            ),
          0,
        ),
    ),
  );
  let allocations = a.allocations.map((x, i) => ({
    ...x,
    amountCents: amounts[i]!,
    originalAllocationIndex: i,
  }));
  const state = await readCostState(ctx, scope, row.entryId);
  if (state.corrections.length && !correction)
    deny(
      "accrual_classification_changed",
      "Corrected accrual requires explicit current reversal allocations",
    );
  if (correction) {
    const corrected = await correctedCostShares(
      ctx,
      scope,
      state,
      allocations.map((x, i) => ({
        ...x,
        originalLineId: "accrual",
        allocationIndex: i,
        side: "credit" as const,
      })),
      correction,
      accountingDate ?? "",
    );
    allocations = corrected.map((x) => ({
      ...a.allocations[x.allocationIndex]!,
      account: x.account,
      store: x.store,
      treatment: x.treatment as (typeof a.allocations)[number]["treatment"],
      period: x.period,
      amountCents: x.amountCents,
      originalAllocationIndex: x.allocationIndex,
    }));
  }
  return {
    row,
    a,
    amountCents,
    allocations,
    quantity,
    costSnapshotHash: state.snapshotHash,
  };
}
export async function postAccrualReversal(
  ctx: MutationCtx,
  scope: BankScope,
  plan: Awaited<ReturnType<typeof accrualReversalPlan>>,
  date: string,
  key: string,
  links: {
    caseId?: Id<"apCaseRecords">;
    billId?: Id<"demoBills">;
    actionId?: Id<"apCloseActions">;
  },
) {
  if (date < plan.row.date)
    deny(
      "accrual_reversal_date",
      "Reversal cannot precede the original accrual accounting date",
    );
  const posted = await appendDemoEntry(ctx, {
    runId: scope.runId,
    seat: accountingSeat(scope.runId),
    date,
    memo: `Accrual reversal ${plan.row._id}`,
    source: { kind: "ap_accrual_reversal", ref: plan.row._id },
    lines: [
      {
        account: "2010",
        debit: plan.amountCents,
        credit: 0,
        dims: { vendor: plan.row.supplierId },
      },
      ...plan.allocations
        .filter((a) => a.amountCents > 0)
        .map((a) => ({
          account: a.account,
          debit: 0,
          credit: a.amountCents,
          dims: {
            vendor: plan.row.supplierId,
            ...(a.store ? { store: a.store } : {}),
          },
        })),
    ],
    idempotencyKey: key,
  });
  if (!posted.ok) deny(posted.code, posted.error);
  await ctx.db.insert("apAccrualApplications", {
    scope,
    accrualId: plan.row._id,
    ...links,
    quantity: plan.quantity,
    amountCents: plan.amountCents,
    allocations: plan.allocations,
    entryId: posted.entryId,
    date,
    createdAt: Date.now(),
  });
  await ctx.db.patch(plan.row._id, {
    reversedQuantity: quantityString(
      quantityMicros(plan.row.reversedQuantity) + quantityMicros(plan.quantity),
    ),
    reversedCents: plan.row.reversedCents + plan.amountCents,
  });
  return posted.entryId;
}
export async function validateInvoiceAccruals(
  ctx: QueryCtx,
  scope: BankScope,
  row: Doc<"apCaseRecords">,
  acceptance: BusinessAcceptance,
  applications: AccrualApplication[],
  accountingDate: string,
) {
  if (
    new Set(applications.map((a) => a.accrualId)).size !== applications.length
  )
    deny(
      "duplicate_accrual_application",
      "An accrual may only be applied once per invoice approval",
    );
  const active = (
    await ctx.db
      .query("apAccruals")
      .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
      .collect()
  ).filter((a) => a.amountCents > a.reversedCents);
  const input = intakeSchema.parse(row.intake);
  const pools = new Map<
    string,
    {
      source: { sourceId: string; sha256: string };
      sku: string;
      unit: string;
      quantity: bigint;
    }
  >();
  for (const line of acceptance.lines) {
    const candidate = input.candidate!.lines.find(
      (l) => l.lineId === line.lineId,
    )!;
    for (const claim of line.receipts) {
      const key = JSON.stringify([
        claim.source.sha256,
        candidate.sku,
        candidate.quantity.unit,
      ]);
      const prior = pools.get(key);
      pools.set(key, {
        source: claim.source,
        sku: candidate.sku!,
        unit: candidate.quantity.unit,
        quantity: (prior?.quantity ?? 0n) + quantityMicros(claim.quantity),
      });
    }
  }
  const matches = (
    a: Doc<"apAccruals">,
    p: typeof pools extends Map<string, infer T> ? T : never,
  ) => {
    const original = accrualSchema.parse(a.payload);
    return (
      original.sku === p.sku &&
      original.unit === p.unit &&
      (a.sourceId === p.source.sourceId ||
        original.source.sha256 === p.source.sha256)
    );
  };
  for (const accrual of active) {
    const original = accrualSchema.parse(accrual.payload);
    const related = [...pools.values()].filter(
      (p) =>
        p.source.sourceId === accrual.sourceId ||
        p.source.sha256 === original.source.sha256,
    );
    if (
      (accrual.expectedInvoiceCaseId === row._id || related.length) &&
      !related.some((p) => matches(accrual, p))
    )
      deny(
        "accrual_application_mismatch",
        "An existing accrual for this case/original has an unmappable SKU/unit; explicitly resolve it before invoice recognition",
      );
    if (
      related.some((p) => p.source.sha256 === original.source.sha256) &&
      (await sourceSemanticHash(input, original.source.sha256)) !==
        accrual.sourceSemanticHash
    )
      deny(
        "accrual_source_conflict",
        "Same accrued original has a conflicting invoice semantic line set",
      );
  }
  const plans = [];
  const used = new Map<string, bigint>();
  for (const app of applications) {
    const plan = await accrualReversalPlan(
      ctx,
      scope,
      app.accrualId,
      app.quantity,
      app.correction,
      accountingDate,
    );
    const matching = [...pools].filter(([, p]) => matches(plan.row, p));
    if (
      matching.length !== 1 ||
      plan.row.supplierId !== input.candidate?.supplierId ||
      (plan.row.expectedInvoiceCaseId &&
        plan.row.expectedInvoiceCaseId !== row._id)
    )
      deny(
        "accrual_application_mismatch",
        "Accrual must match this invoice's supplier, original SKU/unit receipt and any explicit case binding",
      );
    if (
      plan.a.source.sha256 === matching[0]![1].source.sha256 &&
      (await sourceSemanticHash(input, plan.a.source.sha256)) !==
        plan.row.sourceSemanticHash
    )
      deny(
        "accrual_source_conflict",
        "Invoice interpretation of the accrued original changed; explicitly resolve the accrual before recognition",
      );
    if (accountingDate < plan.row.date)
      deny(
        "accrual_reversal_date",
        "Invoice accounting date cannot reverse an accrual before its original accounting date",
      );
    const key = matching[0]![0];
    used.set(key, (used.get(key) ?? 0n) + quantityMicros(app.quantity));
    plans.push(plan);
  }
  for (const [key, pool] of pools) {
    const balance = active
      .filter((a) => matches(a, pool))
      .reduce(
        (n, a) =>
          n + quantityMicros(a.quantity) - quantityMicros(a.reversedQuantity),
        0n,
      );
    const required = balance < pool.quantity ? balance : pool.quantity;
    if ((used.get(key) ?? 0n) !== required)
      deny(
        "accrual_application_required",
        "Explicit accrual reversals must exactly cover the accepted units already accrued, without exceeding this invoice quantity",
      );
  }
  return plans;
}
