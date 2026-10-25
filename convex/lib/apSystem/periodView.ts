import type { QueryCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import type { BankScope } from "../../../src/integrations/contracts";
import {
  statementSchema,
  closeActionSchema,
  type SupplierStatement,
  type PeriodView,
  type CloseBlocker,
} from "../../../src/ap-system/close-contracts";
import { intakeSchema } from "../../../src/ap-system/contracts";
import { quantityString } from "../../../src/ap-system/business-policy";
import { quantityMicros, sumCents } from "../../../src/ap-system/accounting";
import { canonical, sha256Hex } from "../kernel";
import { closeBlockers } from "../../demoEvidence";
import { deny } from "./shared";
import {
  requireBusinessPolicy,
  assertApprovalVotes,
  assertHumanSubject,
  requireGroup,
} from "./businessAuthority";
import { CHART } from "../../../src/core/accounts";
export const endOfPeriod = (period: string) =>
  new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);
const safe = (n: number) => {
  if (!Number.isSafeInteger(n))
    deny(
      "unsafe_period_balance",
      "Period accounting total exceeds safe integer cents",
    );
  return n;
};
export async function periodFacts(
  ctx: QueryCtx,
  scope: BankScope,
  period: string,
) {
  const through = endOfPeriod(period);
  const periodRow = await ctx.db
    .query("periods")
    .withIndex("by_run_period", (q) =>
      q.eq("runId", scope.runId).eq("period", period),
    )
    .unique();
  if (!periodRow) deny("period_missing", "Accounting period is not configured");
  const allJournals = await ctx.db
    .query("journalEntries")
    .withIndex("by_run_period", (q) => q.eq("runId", scope.runId))
    .collect();
  const journals = allJournals.filter((j) => j.date <= through),
    byId = new Map(journals.map((j) => [j._id, j]));
  const bills = await ctx.db
    .query("demoBills")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const credits = await ctx.db
    .query("demoCredits")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const cases = await ctx.db
    .query("apCaseRecords")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const versions = await ctx.db
    .query("demoVersions")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const commands = await ctx.db
    .query("demoCommands")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const transactions = await ctx.db
    .query("demoTransactions")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const direct = await ctx.db
    .query("apCreditApplications")
    .withIndex("by_bill", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const accruals = await ctx.db
    .query("apAccruals")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const reversals = await ctx.db
    .query("apAccrualApplications")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const blockers: CloseBlocker[] = [];
  const hold = (
    code: string,
    reference: string,
    reason: string,
    owner: CloseBlocker["owner"] = "controller",
  ) => blockers.push({ code, reference, reason, owner });
  const ap = (j: Doc<"journalEntries"> | undefined, account = "2000") =>
    j?.lines
      .filter((l) => l.account === account)
      .reduce((n, l) => safe(n + l.credit - l.debit), 0) ?? 0;
  const suppliers = new Map<
    string,
    { supplierId: string; openingCents: number; closingCents: number }
  >();
  const movement = (supplierId: string, amount: number, date: string) => {
    const s = suppliers.get(supplierId) ?? {
      supplierId,
      openingCents: 0,
      closingCents: 0,
    };
    s.closingCents = safe(s.closingCents + amount);
    if (date.slice(0, 7) < period)
      s.openingCents = safe(s.openingCents + amount);
    suppliers.set(supplierId, s);
  };
  const billRows: PeriodView["unpaidBills"] = [];
  for (const bill of bills) {
    const journal = bill.entryId ? byId.get(bill.entryId) : undefined;
    if (!journal) {
      if (bill.invoiceDate <= through && !bill.entryId)
        hold(
          "bill_not_recognized",
          bill._id,
          "Bill lacks a period-end recognition journal",
          "ap_clerk",
        );
      continue;
    }
    if (
      journal.source.kind !== "bill" ||
      journal.source.ref !== bill._id ||
      ap(journal) !== bill.approvedCents
    )
      hold(
        "bill_journal_mismatch",
        bill._id,
        "Bill amount/source differs from original recognition",
      );
    movement(bill.vendor, bill.approvedCents ?? 0, journal.date);
    billRows.push({
      billId: bill._id,
      caseId: cases.find((c) => c.billId === bill._id)?._id ?? null,
      supplierId: bill.vendor,
      reference: bill.invoiceNumber,
      recognizedCents: bill.approvedCents ?? 0,
      appliedCreditCents: 0,
      cashCents: 0,
      outstandingCents: bill.approvedCents ?? 0,
    });
  }
  for (const credit of credits) {
    const j = byId.get(credit.entryId);
    if (!j) continue;
    if (ap(j) !== -credit.amountCents)
      hold(
        "credit_journal_mismatch",
        credit._id,
        "Credit differs from original recognized liability reduction",
      );
    movement(credit.vendor, -credit.amountCents, j.date);
  }
  const movements: PeriodView["movements"] = [];
  for (const b of billRows) {
    const original = bills.find((x) => x._id === b.billId)!;
    const j = byId.get(original.entryId!)!;
    movements.push({
      kind: "bill",
      id: b.billId,
      reference: b.reference,
      date: j.date,
      amountCents: b.recognizedCents,
      supplierId: b.supplierId,
    });
  }
  for (const c of credits) {
    const j = byId.get(c.entryId);
    if (j)
      movements.push({
        kind: "credit",
        id: c._id,
        reference: c.reference,
        date: j.date,
        amountCents: -c.amountCents,
        supplierId: c.vendor,
      });
  }
  const payments = new Map<
    string,
    { amountCents: number; date: string; supplierId: string }
  >();
  const appliedCredits = new Map<string, number>();
  for (const tx of transactions) {
    const journal = tx.entryId ? byId.get(tx.entryId) : undefined;
    if (!journal || !["debit", "return"].includes(tx.transaction.purpose))
      continue;
    const command = commands.find((c) => c._id === tx.commandRowId),
      version = command
        ? versions.find((v) => v._id === command.versionId)
        : undefined;
    if (!version || tx.state !== "posted" || !command) {
      hold(
        "unmatched_bank_journal",
        tx._id,
        "AP cash journal has no matched immutable payment",
        "treasury",
      );
      continue;
    }
    const returning = tx.transaction.purpose === "return",
      amount = Math.abs(tx.transaction.amountCents);
    if (
      amount !== version.snapshot.amountCents ||
      ap(journal) !== (returning ? amount : -amount)
    )
      hold(
        "bank_journal_mismatch",
        tx._id,
        "Bank cash amount differs from exact AP settlement/return journal",
        "treasury",
      );
    let remaining = version.snapshot.credits.reduce(
      (n, c) => n + c.amountCents,
      0,
    );
    let supplier: string | null = null;
    for (const item of version.snapshot.bills) {
      const credit = Math.min(remaining, item.amountCents);
      remaining -= credit;
      const row = billRows.find((b) => b.billId === item.billId);
      if (!row) {
        hold(
          "payment_bill_missing",
          item.billId,
          "Payment precedes its recognized obligation",
          "treasury",
        );
        continue;
      }
      supplier = row.supplierId;
      const cash = item.amountCents - credit;
      row.cashCents += returning ? -cash : cash;
      if (!returning) row.appliedCreditCents += credit;
      movement(row.supplierId, returning ? cash : -cash, journal.date);
    }
    if (supplier)
      movements.push({
        kind: returning ? "return" : "payment",
        id: returning ? tx._id : version._id,
        reference: tx.transaction.id,
        date: journal.date,
        amountCents: returning ? amount : -amount,
        supplierId: supplier,
      });
    if (!returning) {
      for (const c of version.snapshot.credits)
        appliedCredits.set(
          c.creditId,
          (appliedCredits.get(c.creditId) ?? 0) + c.amountCents,
        );
      if (supplier)
        payments.set(version._id, {
          amountCents: -amount,
          date: journal.date,
          supplierId: supplier,
        });
    }
  }
  for (const a of direct.filter(
    (a) => new Date(a.at).toISOString().slice(0, 10) <= through,
  )) {
    const row = billRows.find((b) => b.billId === a.billId);
    if (row) row.appliedCreditCents += a.amountCents;
    else
      hold(
        "credit_application_period",
        a._id,
        "Applied credit precedes its recognized bill",
      );
    appliedCredits.set(
      a.creditId,
      (appliedCredits.get(a.creditId) ?? 0) + a.amountCents,
    );
  }
  for (const b of billRows) {
    b.outstandingCents = safe(
      b.recognizedCents - b.cashCents - b.appliedCreditCents,
    );
    if (b.outstandingCents < 0)
      hold(
        "bill_overdischarged",
        b.billId,
        "Historical cash/credit allocations exceed the recognized payable",
      );
  }
  const unusedCredits = credits
    .filter((c) => byId.has(c.entryId))
    .reduce(
      (n, c) => safe(n + c.amountCents - (appliedCredits.get(c._id) ?? 0)),
      0,
    );
  const apSubledgerCents = safe(
    billRows.reduce((n, b) => n + b.outstandingCents, 0) - unusedCredits,
  );
  const apGLCents = safe(journals.reduce((n, j) => n + ap(j), 0));
  if (apGLCents !== apSubledgerCents)
    hold(
      "ap_gl_difference",
      "2000",
      `AP subledger ${apSubledgerCents} differs from GL ${apGLCents}; opening balances and all earlier periods are included`,
    );
  const accruedRows = accruals
    .filter((a) => byId.has(a.entryId))
    .map((a) => {
      const reversedCents = reversals
        .filter((r) => r.accrualId === a._id && byId.has(r.entryId))
        .reduce((n, r) => n + r.amountCents, 0);
      if (ap(byId.get(a.entryId), "2010") !== a.amountCents)
        hold(
          "accrual_journal_mismatch",
          a._id,
          "Accrued liability differs from its original entry",
        );
      return {
        accrualId: a._id,
        supplierId: a.supplierId,
        sku: a.payload.sku,
        unit: a.payload.unit,
        quantity: a.quantity,
        reversedQuantity: quantityString(
          reversals
            .filter((r) => r.accrualId === a._id && byId.has(r.entryId))
            .reduce((n, r) => n + quantityMicros(r.quantity), 0n),
        ),
        outstandingQuantity: quantityString(
          quantityMicros(a.quantity) -
            reversals
              .filter((r) => r.accrualId === a._id && byId.has(r.entryId))
              .reduce((n, r) => n + quantityMicros(r.quantity), 0n),
        ),
        source: a.payload.source,
        sourceLineId: a.sourceLineId,
        date: a.date,
        amountCents: a.amountCents,
        reversedCents,
        outstandingCents: a.amountCents - reversedCents,
        entryId: a.entryId,
        expectedInvoiceCaseId: a.expectedInvoiceCaseId ?? null,
      };
    });
  const accruedSubledgerCents = safe(
      accruedRows.reduce((n, a) => n + a.outstandingCents, 0),
    ),
    accruedGLCents = safe(journals.reduce((n, j) => n + ap(j, "2010"), 0));
  if (accruedGLCents !== accruedSubledgerCents)
    hold(
      "accrual_gl_difference",
      "2010",
      "Accrual subledger differs from accrued-liability GL including previous periods",
    );
  for (const r of reversals.filter((r) => byId.has(r.entryId)))
    if (ap(byId.get(r.entryId), "2010") !== -r.amountCents)
      hold(
        "accrual_reversal_mismatch",
        r._id,
        "Accrual reversal journal mismatch",
      );
  const sourceCases = cases.filter((c) =>
    c.intake.candidate?.invoiceDate
      ? c.intake.candidate.invoiceDate <= through
      : new Date(c.createdAt).toISOString().slice(0, 10) <= through,
  );
  for (const row of sourceCases) {
    const input = intakeSchema.parse(row.intake);
    const covered = accruedRows.some(
      (a) => a.expectedInvoiceCaseId === row._id && a.outstandingCents > 0,
    );
    if (
      !row.billId &&
      !row.creditId &&
      row.businessStatus !== "rejected" &&
      !covered
    )
      hold(
        "source_disposition_required",
        `case:${row._id}`,
        "Received invoice/failed extraction has no recognized bill, accrual or reviewed disposition",
        "ap_clerk",
      );
    const recognizedInPeriod =
      (row.billId && billRows.some((b) => b.billId === row.billId)) ||
      (row.creditId &&
        credits.some((c) => c._id === row.creditId && byId.has(c.entryId)));
    if (
      recognizedInPeriod &&
      (row.businessStatus !== "approved" || row.documentStatus !== "reviewed")
    )
      hold(
        "changed_recognition_source",
        `case:${row._id}`,
        "Recognized case has changed/unreviewed source evidence",
        "ap_clerk",
      );
    if (
      row.billId &&
      recognizedInPeriod &&
      input.candidate &&
      input.candidate.totalCents > (row.acceptedCents ?? 0)
    )
      hold(
        "disputed_portion",
        `case:${row._id}:disputed`,
        "Unaccepted invoice portion requires explicit period-end accrual or supported non-obligation/timing disposition",
        "purchasing_owner",
      );
  }
  const uses = await ctx.db
    .query("apReceiptConsumptions")
    .withIndex("by_bill", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const receiving = new Map<
    string,
    {
      sourceId: string;
      hash: string;
      sku: string;
      unit: string;
      quantity: string;
    }
  >();
  for (const row of sourceCases.filter(
    (c) => c.intake.candidate?.kind !== "credit_note",
  ))
    for (const p of row.intake.purchasingEvidence ?? [])
      if (["receipt", "service_acceptance"].includes(p.kind))
        for (const l of p.lines) {
          const key = JSON.stringify([p.source.sha256, l.sku, l.quantity.unit]);
          const old = receiving.get(key);
          if (
            old &&
            quantityMicros(old.quantity) !== quantityMicros(l.quantity.decimal)
          )
            hold(
              "received_source_conflict",
              `receipt:${key}`,
              "Same original has conflicting received capacity",
              "purchasing_owner",
            );
          receiving.set(key, {
            sourceId: p.source.sourceId,
            hash: p.source.sha256,
            sku: l.sku,
            unit: l.quantity.unit,
            quantity: l.quantity.decimal,
          });
        }
  // A standalone original has the same unit coverage invariant as a parsed case.
  // Its first approved accrual establishes reviewed capacity, not full discharge.
  const standaloneSources = await ctx.db
    .query("apCaseSources")
    .withIndex("by_source", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  for (const source of standaloneSources.filter(
    (s) =>
      s.document.kind === "receipt" &&
      new Date(s._creationTime).toISOString().slice(0, 10) <= through,
  )) {
    const knownCase = sourceCases.some((c) =>
      (c.intake.documents ?? []).some(
        (d: { sha256: string }) => d.sha256 === source.sha256,
      ),
    );
    if (knownCase) continue;
    const originals = accruals.filter(
      (a) =>
        byId.has(a.entryId) &&
        (a.sourceId === source.sourceId ||
          a.payload.source.sha256 === source.sha256),
    );
    if (!originals.length) {
      hold(
        "received_not_invoiced",
        `source:${source.sha256}`,
        "Standalone receipt evidence requires a source-supported accrual or explicit disposition",
        "purchasing_owner",
      );
      continue;
    }
    for (const a of originals) {
      const key = JSON.stringify([
        a.payload.source.sha256,
        a.payload.sku,
        a.payload.unit,
      ]);
      const old = receiving.get(key);
      if (
        old &&
        quantityMicros(old.quantity) !==
          quantityMicros(a.payload.capacityQuantity)
      )
        hold(
          "received_source_conflict",
          `receipt:${key}`,
          "Same original has conflicting received capacity",
          "purchasing_owner",
        );
      receiving.set(key, {
        sourceId: a.sourceId,
        hash: a.payload.source.sha256,
        sku: a.payload.sku,
        unit: a.payload.unit,
        quantity: a.payload.capacityQuantity,
      });
    }
  }
  for (const [key, r] of receiving) {
    const invoiced = uses
      .filter(
        (u) =>
          u.kind !== "return" &&
          u.sku === r.sku &&
          u.unit === r.unit &&
          (u.sourceId === r.sourceId || u.sourceHash === r.hash) &&
          billRows.some((b) => b.billId === u.billId),
      )
      .reduce((n, u) => n + quantityMicros(u.quantity), 0n);
    const accrued = accruals
      .filter(
        (a) =>
          byId.has(a.entryId) &&
          a.payload.sku === r.sku &&
          a.payload.unit === r.unit &&
          (a.sourceId === r.sourceId || a.payload.source.sha256 === r.hash),
      )
      .reduce(
        (n, a) =>
          n +
          quantityMicros(a.quantity) -
          reversals
            .filter((x) => x.accrualId === a._id && byId.has(x.entryId))
            .reduce((n, x) => n + quantityMicros(x.quantity), 0n),
        0n,
      );
    if (invoiced + accrued < quantityMicros(r.quantity))
      hold(
        "received_not_invoiced",
        `receipt:${key}`,
        "Received units remain outside invoice/accrual recognition",
        "purchasing_owner",
      );
    if (invoiced + accrued > quantityMicros(r.quantity))
      hold(
        "received_overrecognized",
        `receipt:${key}`,
        "Received units exceed retained source capacity",
        "controller",
      );
  }
  const bankBlockers = (await closeBlockers(ctx, scope)).filter((b) => {
    if (b.kind === "bill") return false;
    if (b.kind === "payment") {
      const c = commands.find((c) => c.command.commandId === b.id);
      const v = versions.find((v) => v._id === c?.versionId);
      if (
        c?.firstAttemptAt === undefined &&
        v?.snapshot.schedule &&
        v.snapshot.schedule.executionDate > through
      )
        return false;
    }
    if (b.kind === "transaction") {
      const tx = transactions.find((t) => t.transaction.id === b.id);
      if (
        tx?.transaction.postedAt &&
        tx.transaction.postedAt.slice(0, 10) > through
      )
        return false;
    }
    return true;
  });
  for (const b of bankBlockers)
    hold("bank_reconciliation", b.id, b.reason, "treasury");
  const previousPeriods = (
    await ctx.db
      .query("periods")
      .withIndex("by_run_period", (q) => q.eq("runId", scope.runId))
      .collect()
  ).filter((p) => p.period < period && p.status !== "closed");
  for (const p of previousPeriods)
    hold(
      "prior_period_open",
      p.period,
      "Close previous configured periods before carrying forward balances",
    );
  const openingJournals = journals.filter((j) => j.period < period),
    cashAccounts = CHART.filter((c) => c.cash).map((c) => c.code);
  const opening = {
    apCents: safe(openingJournals.reduce((n, j) => n + ap(j), 0)),
    accruedCents: safe(openingJournals.reduce((n, j) => n + ap(j, "2010"), 0)),
    cashBalances: cashAccounts.map((account) => ({
      account,
      balanceCents: safe(
        openingJournals
          .flatMap((j) => j.lines)
          .filter((l) => l.account === account)
          .reduce((n, l) => n + l.debit - l.credit, 0),
      ),
    })),
  };
  const factsHash = await sha256Hex(
    canonical({
      scope,
      period,
      journals: journals.map((j) => ({
        id: j._id,
        hash: j.hash,
        status: j.status,
        lines: j.lines,
      })),
      bills: billRows,
      credits: credits
        .filter((c) => byId.has(c.entryId))
        .map((c) => ({
          id: c._id,
          vendor: c.vendor,
          amountCents: c.amountCents,
          entryId: c.entryId,
          date: c.date,
        })),
      accruals: accruedRows,
      cases: sourceCases.map((c) => ({
        id: c._id,
        snapshot: c.snapshotHash,
        document: c.documentStatus,
        business:
          accruedRows.some(
            (a) => a.expectedInvoiceCaseId === c._id && a.outstandingCents > 0,
          ) && !billRows.some((b) => b.billId === c.billId)
            ? "accrued"
            : c.businessStatus,
      })),
      bankBlockers,
      opening,
      receiving: [...receiving],
      standaloneSources: standaloneSources
        .filter(
          (s) =>
            s.document.kind === "receipt" &&
            new Date(s._creationTime).toISOString().slice(0, 10) <= through,
        )
        .map((s) => ({
          sourceId: s.sourceId,
          revision: s.revision,
          hash: s.sha256,
        })),
      blockers,
    }),
  );
  return {
    through,
    periodRow,
    journals,
    bills,
    credits,
    cases,
    versions,
    payments,
    movements,
    suppliers: [...suppliers.values()].sort((a, b) =>
      a.supplierId.localeCompare(b.supplierId),
    ),
    billRows,
    accruedRows,
    opening,
    apGLCents,
    apSubledgerCents,
    accruedGLCents,
    accruedSubledgerCents,
    blockers,
    factsHash,
  };
}
export function compareStatement(
  statement: SupplierStatement,
  facts: Awaited<ReturnType<typeof periodFacts>>,
) {
  const discrepancies: {
    discrepancyId: string;
    amountCents: number;
    reason: string;
  }[] = [];
  const add = (id: string, amount: number, reason: string) =>
    discrepancies.push({ discrepancyId: id, amountCents: amount, reason });
  const vendor = facts.suppliers.find(
    (s) => s.supplierId === statement.supplierId,
  );
  const opening = vendor?.openingCents ?? 0,
    closing = vendor?.closingCents ?? 0;
  if (statement.openingCents !== opening)
    add(
      "opening",
      statement.openingCents - opening,
      "Supplier opening balance differs from reconciled prior-period AP",
    );
  if (
    statement.openingCents +
      statement.lines.reduce((n, l) => safe(n + l.amountCents), 0) !==
    statement.closingCents
  )
    add(
      "arithmetic",
      0,
      "Statement opening plus signed movements does not equal closing",
    );
  const seen = new Set<string>();
  for (const line of statement.lines) {
    const match = line.match;
    if (line.date.slice(0, 7) !== statement.period)
      add(
        `date:${line.lineId}`,
        line.amountCents,
        "Statement line outside selected period",
      );
    const key = match.kind === "unmatched" ? null : `${match.kind}:${match.id}`;
    if (key && seen.has(key))
      add(
        `duplicate:${line.lineId}`,
        line.amountCents,
        "One economic record appears twice on statement",
      );
    if (key) seen.add(key);
    const movement =
      match.kind === "unmatched"
        ? undefined
        : facts.movements.find(
            (m) =>
              m.kind === match.kind &&
              m.id === match.id &&
              m.supplierId === statement.supplierId,
          );
    const normalize = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      !movement ||
      normalize(movement.reference) !== normalize(line.reference)
    )
      add(
        `unmatched:${line.lineId}`,
        line.amountCents,
        "Supplier statement line lacks a matching scoped bill/credit/verified payment or return reference",
      );
    else {
      if (movement.amountCents !== line.amountCents)
        add(
          `amount:${line.lineId}`,
          line.amountCents - movement.amountCents,
          "Supplier line differs from recognized/settled amount",
        );
      if (movement.date !== line.date)
        add(
          `timing:${line.lineId}`,
          line.amountCents,
          "Supplier transaction date differs from the original accounting date",
        );
    }
  }
  for (const movement of facts.movements.filter(
    (m) =>
      m.supplierId === statement.supplierId &&
      m.date.slice(0, 7) === statement.period,
  ))
    if (!seen.has(`${movement.kind}:${movement.id}`))
      add(
        `missing:${movement.kind}:${movement.id}`,
        movement.amountCents,
        "A recognized or verified period transaction is absent from the supplier statement",
      );
  if (statement.closingCents !== closing)
    add(
      "closing",
      statement.closingCents - closing,
      "Supplier closing balance differs from AP subledger; a reviewed dispute/timing explanation is required",
    );
  return discrepancies;
}
export async function readPeriodView(
  ctx: QueryCtx,
  scope: BankScope,
  period: string,
): Promise<PeriodView> {
  const facts = await periodFacts(ctx, scope, period);
  const actions = await ctx.db
    .query("apCloseActions")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const statements = await ctx.db
    .query("apSupplierStatements")
    .withIndex("by_period", (q) =>
      q.eq("scope.runId", scope.runId).eq("period", period),
    )
    .collect();
  const policy = await requireBusinessPolicy(ctx, scope);
  const validActions = [];
  for (const action of actions.filter(
    (a) =>
      a.status === "approved" &&
      a.kind === "disposition" &&
      a.policyHash === policy.hash,
  )) {
    try {
      await assertApprovalVotes(ctx, scope, policy.value, action);
      validActions.push(action);
    } catch {
      /* Stale human authority leaves the owned source hold in place. */
    }
  }
  const approvedDispositions = validActions
    .filter((a) => a.status === "approved" && a.kind === "disposition")
    .map((a) => closeActionSchema.parse(a.payload))
    .filter(
      (a) =>
        a.kind === "disposition" &&
        a.period === period &&
        a.snapshotHash === facts.factsHash,
    );
  const blockers = facts.blockers.filter(
    (b) =>
      ![
        "source_disposition_required",
        "disputed_portion",
        "received_not_invoiced",
      ].includes(b.code) ||
      !approvedDispositions.some(
        (a) => a.kind === "disposition" && a.reference === b.reference,
      ),
  );
  for (const action of actions.filter(
    (a) =>
      a.status === "proposed" &&
      a.kind === "accrual" &&
      a.payload.accrual.date <= facts.through,
  ))
    blockers.push({
      code: "pending_accrual",
      reference: action._id,
      reason: "Proposed received-cost accrual still needs a human decision",
      owner: "controller",
    });
  const projection: PeriodView["statements"] = [];
  for (const s of statements) {
    let current =
      s.status === "reviewed" &&
      s.reviewSnapshotHash === facts.factsHash &&
      s.reviewPolicyHash === policy.hash;
    try {
      if (!s.reviewedBy) throw Error("review required");
      const seat = await assertHumanSubject(ctx, scope, s.reviewedBy);
      requireGroup(
        policy.value,
        policy.value.varianceApprovalGroup,
        s.reviewedBy,
      );
      if (seat.seatId !== s.reviewedSeatId || seat.seatId === s.proposedBy)
        current = false;
    } catch {
      current = false;
    }
    projection.push({
      statementId: s._id,
      hash: s.hash,
      status:
        s.status === "superseded"
          ? "superseded"
          : current
            ? "reviewed"
            : "review_required",
      supplierId: s.supplierId,
      discrepancies: compareStatement(statementSchema.parse(s.payload), facts),
    });
  }

  for (const supplier of facts.suppliers)
    if (
      !projection.some(
        (s) => s.supplierId === supplier.supplierId && s.status === "reviewed",
      )
    )
      blockers.push({
        code: "supplier_statement_review",
        reference: supplier.supplierId,
        reason:
          "Period supplier statement and any differences need current human review",
        owner: "controller",
      });
  const snapshotHash = await sha256Hex(
    canonical({
      facts: facts.factsHash,
      policyHash: policy.hash,
      currentReviews: projection.map((s) => ({
        id: s.statementId,
        status: s.status,
      })),
      statements: statements.map((s) => ({
        id: s._id,
        hash: s.hash,
        status: s.status,
        review: s.review,
        reviewSnapshotHash: s.reviewSnapshotHash,
      })),
      dispositions: approvedDispositions,
      pendingAccruals: actions
        .filter((a) => a.status === "proposed" && a.kind === "accrual")
        .map((a) => a._id),
    }),
  );
  if (
    facts.periodRow.status === "closed" &&
    facts.periodRow.closeSnapshotHash !== snapshotHash
  )
    blockers.push({
      code: "closed_snapshot_changed",
      reference: period,
      reason:
        "New journal, source or authority evidence differs from the retained close; reopen and review before a new close",
      owner: "controller",
    });
  return {
    period,
    status: facts.periodRow.status,
    snapshotHash,
    reconciliationHash: facts.factsHash,
    ready: blockers.length === 0,
    blockers,
    opening: facts.opening,
    reconciliation: {
      apGLCents: facts.apGLCents,
      apSubledgerCents: facts.apSubledgerCents,
      differenceCents: facts.apGLCents - facts.apSubledgerCents,
      accruedGLCents: facts.accruedGLCents,
      accruedSubledgerCents: facts.accruedSubledgerCents,
    },
    suppliers: facts.suppliers,
    movements: facts.movements.filter((m) => m.date.slice(0, 7) === period),
    unpaidBills: facts.billRows.filter((b) => b.outstandingCents > 0),
    statements: projection,
    accruals: facts.accruedRows,
    history: actions
      .filter(
        (a) =>
          a.status === "approved" &&
          ["close", "reopen", "adjustment", "disposition"].includes(a.kind),
      )
      .filter(
        (a) =>
          a.payload.period === period || a.payload.date?.slice(0, 7) === period,
      )
      .map((a) => ({
        actionId: a._id,
        kind: a.kind,
        at: a.completedAt!,
        actor: a.approvedBy!,
        reason: a.payload.reason,
      })),
  };
}
