import { CHART } from "../../core/accounts";
import { journalDimensions } from "./dimensions";
import { readdir } from "node:fs/promises";
import {
  closeExportRequestSchema,
  type CloseAccountingExport,
  type CloseExportRequest,
} from "../close-contracts";
import type { BankScope } from "../../integrations/contracts";
import type { Mappings, Operation, Plan } from "./types";
import { hash, canonical, QboError, safeError } from "./private-store";
import { validateMappings } from "./plans";
import { SyncJournal } from "./sync";
/** Server injection must call authenticated apClose:accountingExport and attach request-bound scope. */
export type CloseExportEnvelope = {
  authorizedSubject: string;
  exportedAt: number;
  scope: BankScope;
  accounting: CloseAccountingExport;
};
export type CloseExportLoader = (
  request: CloseExportRequest,
) => Promise<CloseExportEnvelope>;
export type CloseSyncHold = {
  state: "held";
  owner: "controller";
  code: string;
  reason: string;
  realmId: string;
  exportId: string;
  request: CloseExportRequest;
  createdAt: number;
};
export const closeIdentity = (scope: BankScope, exportId: string) =>
  `CloseJournal:${scope.organizationId}:${scope.runId}:${exportId}`;
function validateExport(e: CloseExportEnvelope, request: CloseExportRequest) {
  closeExportRequestSchema.parse(request);
  const c = e.accounting;
  if (
    !e.authorizedSubject ||
    c.version !== "ap-close-accounting-v1" ||
    ![
      "accrual",
      "accrual_reversal",
      "cost_reclassification",
      "tax_reclassification",
    ].includes(c.kind) ||
    (request.actionId && c.actionId !== request.actionId) ||
    (request.accrualApplicationId &&
      c.accrualApplicationId !== request.accrualApplicationId) ||
    !c.approval.id ||
    !/^[a-f0-9]{64}$/.test(c.approval.hash) ||
    !/^[a-f0-9]{64}$/.test(c.approval.policyHash) ||
    !c.approval.votes.length ||
    !Number.isSafeInteger(c.approval.approvedAt) ||
    !/^[a-f0-9]{64}$/.test(c.journal.hash) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(c.journal.date) ||
    c.exportId !== `${c.kind}:${c.journal.id}`
  )
    throw new QboError("approved_close_export_required");
  return c;
}
export function closePlan(
  e: CloseExportEnvelope,
  request: CloseExportRequest,
  m: Mappings,
  original: Operation | null,
): Plan {
  const c = validateExport(e, request);
  validateMappings(m, m.realmId);
  if (
    !Number.isSafeInteger(c.amountCents) ||
    c.amountCents <= 0 ||
    c.amountCents > 999999999999 ||
    !c.journal.lines.length
  )
    throw new QboError("invalid_close_amount");
  let debit = 0n,
    credit = 0n;
  const lines = c.journal.lines.map((l) => {
    if (
      !Number.isSafeInteger(l.debit) ||
      !Number.isSafeInteger(l.credit) ||
      l.debit < 0 ||
      l.credit < 0 ||
      Number(l.debit > 0) + Number(l.credit > 0) !== 1 ||
      ["1000", "2000"].includes(l.account)
    )
      throw new QboError("unsupported_close_journal");
    if (c.kind === "tax_reclassification") {
      const local = CHART.find((a) => a.code === l.account);
      if (!local || local.cash || !["asset", "expense"].includes(local.type))
        throw new QboError("unsupported_tax_reclassification_account");
    }
    debit += BigInt(l.debit);
    credit += BigInt(l.credit);
    const account = m.accounts[l.account],
      vendor = l.supplierId ? m.vendors[l.supplierId] : null,
      cls = l.store ? m.classes?.[l.store] : null;
    if (!account) throw new QboError("close_account_mapping_required");
    if (c.kind === "tax_reclassification") {
      const local = CHART.find((a) => a.code === l.account)!;
      const allowed =
        local.type === "expense"
          ? ["Expense", "Cost of Goods Sold", "Other Expense"]
          : ["Other Current Asset", "Fixed Asset", "Other Asset"];
      if (!allowed.includes(account.type))
        throw new QboError("tax_account_mapping_conflict");
    }
    if (l.supplierId && !vendor)
      throw new QboError("close_vendor_mapping_required");
    if (l.store && !cls) throw new QboError("close_class_mapping_required");
    if (l.account === "2010" && account.type !== "Other Current Liability")
      throw new QboError("accrual_liability_mapping_conflict");
    return {
      Amount: (l.debit || l.credit) / 100,
      DetailType: "JournalEntryLineDetail",
      JournalEntryLineDetail: {
        PostingType: l.debit ? "Debit" : "Credit",
        AccountRef: { value: account.id },
        ...(vendor
          ? { Entity: { Type: "Vendor", EntityRef: { value: vendor.id } } }
          : {}),
        ...journalDimensions(l, m),
      },
    };
  });
  if (debit !== credit || debit !== BigInt(c.amountCents))
    throw new QboError("close_journal_unbalanced");
  if (c.journal.lines.some((l) => l.supplierId !== c.supplierId))
    throw new QboError("close_supplier_binding_conflict");
  if (c.kind === "tax_reclassification") {
    if (
      !c.actionId ||
      c.approval.kind !== "close" ||
      c.approval.id !== c.actionId ||
      !c.originalEntryId ||
      !c.billId ||
      !c.caseId ||
      !c.supplierId ||
      c.accrualId ||
      c.accrualApplicationId ||
      c.journal.source.kind !== "ap_tax_adjustment" ||
      c.journal.source.ref !== c.originalEntryId ||
      original?.entity !== "Bill" ||
      original.links.billId !== c.billId ||
      original.links.caseId !== c.caseId ||
      original.identity !==
        `Bill:${e.scope.organizationId}:${e.scope.runId}:${c.billId}` ||
      canonical(original.payload.VendorRef) !==
        canonical({ value: m.vendors[c.supplierId]?.id }) ||
      canonical(original.payload.CurrencyRef) !== canonical({ value: "USD" }) ||
      original.payloadHash !==
        hash({
          version: original.version,
          realmId: original.realmId,
          minorVersion: original.minorVersion,
          entity: original.entity,
          identity: original.identity,
          links: original.links,
          mappingHash: original.mappingHash,
          payload: original.payload,
        })
    )
      throw new QboError("tax_original_binding_conflict");
    // Exact balanced movements preserve dimensions; neither aggregate netting nor cross-location transfer is allowed.
    for (let i = 0; i < c.journal.lines.length; i += 2) {
      const to = c.journal.lines[i]!,
        from = c.journal.lines[i + 1];
      const coords = (l: typeof to) => ({
        store: l.store,
        department: l.department ?? null,
        project: l.project ?? null,
        supplierId: l.supplierId,
      });
      if (
        !from ||
        !to.debit ||
        !from.credit ||
        to.debit !== from.credit ||
        to.account === from.account ||
        canonical(coords(to)) !== canonical(coords(from))
      )
        throw new QboError("tax_movement_binding_conflict");
    }
  }
  if (
    c.kind === "cost_reclassification" &&
    (!c.originalEntryId ||
      c.journal.source.kind !== "ap_cost_adjustment" ||
      c.journal.source.ref !== c.originalEntryId)
  )
    throw new QboError("close_original_binding_conflict");
  if (
    c.kind === "cost_reclassification" &&
    c.journal.lines.some((l) => l.account === "2010")
  )
    throw new QboError("unsupported_close_journal");
  if (
    c.kind === "accrual" &&
    (c.originalEntryId ||
      c.journal.source.kind !== "ap_accrual" ||
      c.journal.lines.filter(
        (l) => l.account === "2010" && l.credit === c.amountCents,
      ).length !== 1)
  )
    throw new QboError("accrual_binding_conflict");
  if (
    c.kind === "accrual_reversal" &&
    (!c.originalEntryId ||
      c.journal.source.kind !== "ap_accrual_reversal" ||
      c.journal.lines.filter(
        (l) => l.account === "2010" && l.debit === c.amountCents,
      ).length !== 1)
  )
    throw new QboError("accrual_binding_conflict");
  if (
    c.originalEntryId &&
    (!original ||
      original.state !== "succeeded" ||
      !original.externalId ||
      original.realmId !== m.realmId ||
      original.mappingHash !== hash(m) ||
      !(
        (original.entity === "Bill" &&
          original.links.recognitionJournalId === c.originalEntryId) ||
        (original.entity === "JournalEntry" &&
          original.links.closeJournalId === c.originalEntryId)
      ))
  )
    throw new QboError("external_original_close_journal_required");
  if (
    c.kind === "accrual_reversal" &&
    (original?.entity !== "JournalEntry" ||
      original.links.closeExportId !== `accrual:${c.originalEntryId}`)
  )
    throw new QboError("external_original_accrual_required");
  const identity = closeIdentity(e.scope, c.exportId);
  return {
    version: "ap-qbo-operation-v1",
    realmId: m.realmId,
    minorVersion: 75,
    entity: "JournalEntry",
    identity,
    mappingHash: hash(m),
    links: {
      caseId: c.caseId,
      billId: c.billId,
      recognitionJournalId: c.journal.id,
      paymentVersionId: null,
      commandId: null,
      bankTransactionId: null,
      settlementJournalId: null,
      creditId: null,
      closeExportId: c.exportId,
      closeJournalId: c.journal.id,
      closeActionId: c.actionId,
      accrualApplicationId: c.accrualApplicationId,
      originalJournalId: c.originalEntryId,
      ...(c.kind === "tax_reclassification"
        ? {
            closeApprovalHash: c.approval.hash,
            closeSubmittingSubject: e.authorizedSubject,
            closeJournalHash: c.journal.hash,
            closeAuthorityHash: hash({
              approval: c.approval,
              journal: c.journal,
              originalEntryId: c.originalEntryId,
              caseId: c.caseId,
              billId: c.billId,
            }),
          }
        : {}),
    },
    payload: {
      CurrencyRef: { value: "USD" },
      TxnDate: c.journal.date,
      DocNumber: `AP${hash(identity).slice(0, 18)}`,
      PrivateNote: `ap-sync:${hash(identity)}; approved ${c.approval.kind} ${c.approval.id}; journal ${c.journal.id};${original ? ` original ${original.entity} ${original.externalId}` : ""}`,
      Line: lines,
    },
  };
}
/** Independent approved close journals, including accruals that have no case or Bill. */
export class QuickBooksCloseDispatcher {
  constructor(
    readonly load: CloseExportLoader,
    readonly mappings: Mappings,
    readonly journal: SyncJournal,
  ) {}
  private async resolve(e: CloseExportEnvelope, request: CloseExportRequest) {
    const c = validateExport(e, request);
    let original: Operation | null = null;
    if (c.originalEntryId) {
      const files = (await readdir(this.journal.store.root)).filter((n) =>
        /^operation-[a-f0-9]{64}\.json$/.test(n),
      );
      if (files.length > 1000)
        throw new QboError("original_close_reconciliation_incomplete");
      const matches: Operation[] = [];
      for (const file of files) {
        const op = await this.journal.store.read<Operation>(file);
        if (
          op &&
          op.realmId === this.mappings.realmId &&
          ((op.entity === "Bill" &&
            op.links.recognitionJournalId === c.originalEntryId) ||
            (op.entity === "JournalEntry" &&
              op.links.closeJournalId === c.originalEntryId))
        )
          matches.push(op);
      }
      if (matches.length !== 1)
        throw new QboError("external_original_close_journal_required");
      original = matches[0]!;
    }
    return { plan: closePlan(e, request, this.mappings, original), original };
  }
  async run(
    request: CloseExportRequest,
    mode: "dry-run" | "submit" = "dry-run",
    approval?: { expectedPlanHash: string },
  ) {
    closeExportRequestSchema.parse(request);
    validateMappings(this.mappings, this.journal.client.oauth.config.realmId);
    const e = await this.load(request);
    validateExport(e, request);
    let resolved: Awaited<ReturnType<QuickBooksCloseDispatcher["resolve"]>>;
    try {
      resolved = await this.resolve(e, request);
    } catch (error) {
      const hold: CloseSyncHold = {
        state: "held",
        owner: "controller",
        code: safeError(error),
        reason:
          "Approved close journal requires exact mappings and original external history",
        realmId: this.mappings.realmId,
        exportId: e.accounting.exportId,
        request,
        createdAt: Date.now(),
      };
      if (mode === "submit")
        await this.journal.store.write(
          `close-hold-${hash({ realmId: hold.realmId, exportId: hold.exportId, code: hold.code })}.json`,
          hold,
        );
      return { mode, hold };
    }
    const { plan, original } = resolved;
    if (approval && approval.expectedPlanHash !== hash(plan))
      throw new QboError("preview_changed_before_write");
    if (mode === "dry-run") return { mode, plan };
    const fresh = (v: CloseExportEnvelope) => {
      if (
        !v.authorizedSubject ||
        Date.now() - v.exportedAt > 30000 ||
        v.exportedAt > Date.now() + 5000
      )
        throw new QboError("fresh_authenticated_export_required");
      if (v.scope.provider !== "increase" || v.scope.environment !== "sandbox")
        throw new QboError("increase_sandbox_export_required");
    };
    fresh(e);
    return {
      mode,
      operation: await this.journal.execute(
        plan,
        this.mappings,
        async () => {
          if (original) await this.journal.client.verify(original);
          const next = await this.load(request);
          fresh(next);
          if (next.authorizedSubject !== e.authorizedSubject)
            throw new QboError("submission_identity_changed");
          if (
            canonical((await this.resolve(next, request)).plan) !==
            canonical(plan)
          )
            throw new QboError("approval_changed_before_write");
        },
        {
          subject: e.authorizedSubject,
          planHash: hash(plan),
          decidedAt: Date.now(),
        },
      ),
    };
  }
}
