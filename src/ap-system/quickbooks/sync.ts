import { readdir } from "node:fs/promises";
import {
  returnPlan,
  returnIdentity,
  allocatedPaymentPlan,
  assertRestoredOperation,
} from "./correction-plans";
import {
  PrivateStore,
  QboError,
  hash,
  canonical,
  safeError,
} from "./private-store";
import { QboClient } from "./client";
import {
  assertExport,
  billPlan,
  paymentPlan,
  creditPlan,
  applicationPlan,
  validateMappings,
} from "./plans";
import type {
  ExportLoader,
  ExportRequest,
  Mappings,
  Operation,
  Plan,
  AccountingExport,
  AccountingHold,
  SyncHold,
  AppliedCredit,
  SubmissionAuthorization,
  CorrectionVerification,
} from "./types";
export class SyncJournal {
  constructor(
    readonly store: PrivateStore,
    readonly client: QboClient,
  ) {}
  key(plan: Pick<Plan, "realmId" | "identity">) {
    return `operation-${hash({ realmId: plan.realmId, identity: plan.identity })}.json`;
  }
  async get(plan: Pick<Plan, "realmId" | "identity">) {
    return this.store.read<Operation>(this.key(plan));
  }
  async recordHold(
    request: ExportRequest,
    reason: AccountingHold,
  ): Promise<SyncHold> {
    const realmId = this.client.oauth.config.realmId;
    const key = `hold-${hash({ realmId, request, code: reason.code })}.json`;
    return this.store.lock(key, async () => {
      const old = await this.store.read<SyncHold>(key);
      const hold: SyncHold = {
        ...reason,
        state: "held",
        realmId,
        caseId: request.caseId,
        request,
        createdAt: old?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      await this.store.write(key, hold);
      return hold;
    });
  }
  async execute(
    plan: Plan,
    mappings: Mappings,
    beforeWrite?: () => Promise<void>,
    authorization?: SubmissionAuthorization,
  ) {
    if (
      plan.realmId !== this.client.oauth.config.realmId ||
      plan.minorVersion !== 75 ||
      hash(mappings) !== plan.mappingHash
    )
      throw new QboError("operation_configuration_mismatch");
    const key = this.key(plan);
    // Serialize dependency balance checks and writes for this realm, including distinct applications.
    return this.store.lock(`realm-submit-${plan.realmId}`, () =>
      this.store.lock(key, async () => {
        const old = await this.get(plan);
        const payloadHash = hash(plan);
        const requestId = `ap-${hash({ realm: plan.realmId, identity: plan.identity }).slice(0, 44)}`;
        if (
          old &&
          (old.payloadHash !== payloadHash ||
            old.requestId !== requestId ||
            hash({
              version: old.version,
              realmId: old.realmId,
              minorVersion: old.minorVersion,
              entity: old.entity,
              identity: old.identity,
              links: old.links,
              mappingHash: old.mappingHash,
              payload: old.payload,
            }) !== payloadHash)
        )
          throw new QboError("immutable_operation_conflict");
        let op: Operation = old ?? {
          ...plan,
          requestId,
          payloadHash,
          state: "prepared",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          attempts: 0,
          externalId: null,
          syncToken: null,
          lastError: null,
          responseHash: null,
        };
        const save = async () => {
          op.updatedAt = Date.now();
          await this.store.write(key, op);
        };
        const accept = async (value: Record<string, any>) => {
          if (
            typeof value.Id !== "string" ||
            !/^\d{1,32}$/.test(value.Id) ||
            typeof value.SyncToken !== "string" ||
            !/^\d+$/.test(value.SyncToken)
          )
            throw new QboError("external_identity_missing", true);
          op = {
            ...op,
            state: "succeeded",
            externalId: value.Id,
            syncToken: value.SyncToken,
            responseHash: hash(value),
            lastError: null,
          };
          await save();
          return op;
        };
        let sentNow = false;
        if (!old) await save();
        if (op.state === "conflict" || op.state === "rejected")
          throw new QboError("operation_requires_review");
        try {
          if (op.state === "succeeded") {
            await this.client.verify(op);
            return op;
          }
          if (op.state === "unknown" || op.state === "sending") {
            const found = await this.client.find(op);
            if (found) return await accept(found);
            op.state = "unknown";
            op.lastError = "unknown_not_found_no_repost";
            await save();
            return op;
          }
          await this.client.verifyMappings(mappings);
          const existing = await this.client.find(op);
          if (existing) return await accept(existing);
          await beforeWrite?.();
          if (
            !authorization ||
            !authorization.subject ||
            authorization.planHash !== payloadHash ||
            !Number.isSafeInteger(authorization.decidedAt) ||
            Date.now() - authorization.decidedAt > 30000 ||
            authorization.decidedAt > Date.now() + 5000
          )
            throw new QboError("submission_authorization_required");
          // An old definitive retry keeps its first writer; read/recovery never supplies it.
          op.submissionAuthorization ??= { ...authorization };
          op.state = "sending";
          op.attempts++;
          await save();
          sentNow = true;
          return await accept(await this.client.create(op));
        } catch (e) {
          const code = safeError(e);
          // A lost response or crash after durable 'sending' can never mint a new request ID.
          const wasSending = op.state === "sending";
          if (/conflict|stale/.test(code)) op.state = "conflict";
          else if (old?.state === "unknown" || old?.state === "sending")
            op.state = "unknown";
          else if (op.state === "succeeded") {
            /* A read failure cannot erase a committed receipt. */
          } else if (
            (e instanceof QboError && e.unknown) ||
            (sentNow && !(e instanceof QboError))
          )
            op.state = "unknown";
          else if (
            code === "qbo_retry_later" ||
            /reauthorization|required_configuration/.test(code)
          )
            op.state = "prepared";
          else if (sentNow) op.state = "rejected";
          op.lastError = code;
          await save();
          throw e instanceof QboError
            ? e
            : new QboError("sync_failed", wasSending);
        }
      }),
    );
  }
}
/** Server injection point. Never expose SyncJournal.execute as a browser payload endpoint. */
export class QuickBooksDispatcher {
  constructor(
    readonly load: ExportLoader,
    readonly mappings: Mappings,
    readonly journal: SyncJournal,
  ) {}
  /** Authenticated status check. A stored flag alone never releases a return hold. */
  async checkHolds(
    request: ExportRequest,
    options: { verify?: boolean } = {},
  ): Promise<AccountingHold[]> {
    validateMappings(this.mappings, this.journal.client.oauth.config.realmId);
    const e = await this.load(request);
    return this.checkExportHolds(e, request, options.verify === true);
  }
  private async checkExportHolds(
    e: AccountingExport,
    request: ExportRequest,
    verify = false,
  ): Promise<AccountingHold[]> {
    if (
      e.version !== "ap-qbo-export-v1" ||
      !e.authorizedSubject ||
      e.detail.caseId !== request.caseId
    )
      throw new QboError("authenticated_case_export_required");
    if (e.holds?.length) return e.holds;
    if (e.correction?.kind === "bank_return") return [];
    const required = e.requiredCorrections ?? [];
    if (!required.length) return [];
    const proof: NonNullable<SyncHold["resolution"]>["corrections"] = [];
    for (const c of required) {
      try {
        const op = await this.journal.get({
          realmId: this.mappings.realmId,
          identity: returnIdentity(
            e.detail.scope.organizationId,
            e.detail.scope.runId,
            c,
          ),
        });
        if (!op) throw new QboError("external_correction_required");
        assertRestoredOperation(c, op, this.mappings);
        const file = `verification-${hash({ realmId: op.realmId, identity: op.identity })}.json`;
        const receipt = await this.journal.store.lock(file, async () => {
          if (!verify)
            return this.journal.store.read<CorrectionVerification>(file);
          const record: CorrectionVerification = {
            version: "ap-qbo-correction-verification-v1",
            state: "failed",
            realmId: op.realmId,
            correctionId: c.correctionId,
            proposalHash: c.proposalHash,
            mappingHash: hash(this.mappings),
            operationHash: op.payloadHash,
            externalId: op.externalId!,
            syncToken: op.syncToken!,
            checkedAt: Date.now(),
            authorizedSubject: e.authorizedSubject,
            responseHash: null,
            error: null,
          };
          try {
            record.responseHash = hash(await this.journal.client.verify(op));
            record.state = "verified";
          } catch (error) {
            record.error = safeError(error);
          }
          await this.journal.store.write(file, record);
          return record;
        });
        if (
          !receipt ||
          receipt.version !== "ap-qbo-correction-verification-v1" ||
          receipt.state !== "verified" ||
          receipt.realmId !== op.realmId ||
          receipt.correctionId !== c.correctionId ||
          receipt.proposalHash !== c.proposalHash ||
          receipt.mappingHash !== hash(this.mappings) ||
          receipt.operationHash !== op.payloadHash ||
          receipt.externalId !== op.externalId ||
          receipt.syncToken !== op.syncToken ||
          !receipt.responseHash
        )
          throw new QboError("external_correction_verification_required");
        proof.push({
          correctionId: c.correctionId,
          proposalHash: c.proposalHash,
          externalId: op.externalId!,
          syncToken: op.syncToken!,
          responseHash: receipt.responseHash,
        });
      } catch (error) {
        return [
          {
            code: "return_correction_sync_required",
            owner: "controller",
            reason: `Approved return requires successful external journal verification: ${safeError(error)}`,
            relatedIds: [
              c.correctionId,
              c.returnTransactionId,
              c.returnJournalId,
            ],
          },
        ];
      }
    }
    if (!verify) return [];
    const covered = new Set(
      required.flatMap((c) => [
        c.correctionId,
        c.returnTransactionId,
        c.returnJournalId,
        c.original.paymentVersionId,
        c.original.commandId,
        c.observationId,
        c.returnTransactionRowId,
      ]),
    );
    const files = (await readdir(this.journal.store.root)).filter((n) =>
      /^hold-[a-f0-9]{64}\.json$/.test(n),
    );
    if (files.length > 1000)
      throw new QboError("hold_reconciliation_incomplete");
    for (const file of files)
      await this.journal.store.lock(file, async () => {
        const hold = await this.journal.store.read<SyncHold>(file);
        if (
          !hold ||
          hold.realmId !== this.mappings.realmId ||
          hold.caseId !== request.caseId ||
          hold.state !== "held"
        )
          return;
        const returns =
          [
            "return_accounting_remediation_required",
            "return_correction_sync_required",
          ].includes(hold.code) &&
          hold.relatedIds.length > 0 &&
          hold.relatedIds.every((id) => covered.has(id));
        const allocation =
          hold.code === "restored_payable_allocation_required" &&
          e.correction?.kind === "payment_allocation" &&
          hold.request.paymentVersionId ===
            e.correction.settlement.paymentVersionId;
        if (!returns && !allocation) return;
        await this.journal.store.write(file, {
          ...hold,
          state: "resolved",
          updatedAt: Date.now(),
          resolution: {
            verifiedAt: Date.now(),
            authorizedSubject: e.authorizedSubject,
            corrections: proof,
          },
        } satisfies SyncHold);
      });
    return [];
  }
  private async resolve(e: AccountingExport, request: ExportRequest) {
    const d = assertExport(e, request);
    const deps: Operation[] = [];
    if (e.correction?.kind === "bank_return") {
      const c = e.correction;
      const payment = await this.journal.get({
        realmId: this.mappings.realmId,
        identity: `BillPayment:${d.scope.organizationId}:${d.scope.runId}:${c.original.paymentVersionId}:${c.original.bankTransactionId}`,
      });
      if (!payment) throw new QboError("external_original_payment_required");
      return { plan: returnPlan(e, this.mappings, payment), deps: [payment] };
    }
    const originalBill = async (billId: string) => {
      const op = await this.journal.get({
        realmId: this.mappings.realmId,
        identity: `Bill:${d.scope.organizationId}:${d.scope.runId}:${billId}`,
      });
      if (!op || op.state !== "succeeded")
        throw new QboError("external_bill_required");
      deps.push(op);
      return op;
    };
    if (e.recognizedCredit) {
      const bill = await originalBill(e.recognizedCredit.billId);
      return {
        plan: creditPlan(e.recognizedCredit, this.mappings, bill),
        deps,
      };
    }
    const base = billPlan(e, this.mappings);
    if (
      !request.paymentVersionId &&
      !request.creditApplicationId &&
      !request.correctionId
    )
      return { plan: base, deps };
    if (!base.links.billId) throw new QboError("external_bill_required");
    const bill = await originalBill(base.links.billId);
    const items: AppliedCredit[] =
      e.creditApplication?.credits ?? e.settlement?.credits ?? [];
    const credits: Operation[] = [];
    for (const item of items) {
      const r = item.recognition;
      const op = await this.journal.get({
        realmId: this.mappings.realmId,
        identity: `VendorCredit:${r.creditId}:${r.journalId}`,
      });
      if (!op || op.state !== "succeeded")
        throw new QboError("external_credit_required");
      deps.push(op);
      credits.push(op);
    }
    if (e.correction?.kind === "payment_allocation") {
      const restored: Operation[] = [];
      for (const item of e.correction.restoredPayables) {
        const op = await this.journal.get({
          realmId: this.mappings.realmId,
          identity: returnIdentity(
            d.scope.organizationId,
            d.scope.runId,
            item.correction,
          ),
        });
        if (!op) throw new QboError("external_correction_required");
        assertRestoredOperation(item.correction, op, this.mappings);
        restored.push(op);
        deps.push(op);
      }
      return {
        plan: allocatedPaymentPlan(e, this.mappings, bill, credits, restored),
        deps,
      };
    }
    return {
      plan: request.creditApplicationId
        ? applicationPlan(e, this.mappings, bill, credits)
        : paymentPlan(e, this.mappings, bill, credits),
      deps,
    };
  }
  async run(
    request: ExportRequest,
    mode: "dry-run" | "submit" = "dry-run",
    approval?: { expectedPlanHash: string },
  ) {
    const e = await this.load(request);
    if (
      e.version !== "ap-qbo-export-v1" ||
      !e.authorizedSubject ||
      e.detail.caseId !== request.caseId
    )
      throw new QboError("authenticated_case_export_required");
    validateMappings(this.mappings, this.journal.client.oauth.config.realmId);
    const held = async (reason: AccountingHold) => ({
      mode,
      hold:
        mode === "submit"
          ? await this.journal.recordHold(request, reason)
          : {
              ...reason,
              state: "held" as const,
              realmId: this.mappings.realmId,
              caseId: request.caseId,
              request,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
    });
    const currentHolds = await this.checkExportHolds(
      e,
      request,
      mode === "submit",
    );
    if (currentHolds.length) return held(currentHolds[0]!);
    const resolved = await this.resolve(e, request);
    const { plan, deps } = resolved;
    if (approval && hash(plan) !== approval.expectedPlanHash)
      throw new QboError("preview_changed_before_write");
    if (mode === "dry-run") return { mode, plan };
    const freshAuthority = (value: AccountingExport) => {
      if (
        Date.now() - value.exportedAt > 30000 ||
        value.exportedAt > Date.now() + 5000 ||
        value.detail.identityMode !== "authenticated_human"
      )
        throw new QboError("fresh_authenticated_export_required");
      if (
        value.detail.scope.provider !== "increase" ||
        value.detail.scope.environment !== "sandbox"
      )
        throw new QboError("increase_sandbox_export_required");
    };
    freshAuthority(e);
    return {
      mode,
      operation: await this.journal.execute(
        plan,
        this.mappings,
        async () => {
          for (const op of deps) {
            const external = await this.journal.client.verify(op);
            if (plan.entity === "BillPayment") {
              if (
                op.entity === "JournalEntry" &&
                e.correction?.kind === "payment_allocation"
              ) {
                const allocation = e.correction.restoredPayables.find(
                  (r) => r.correction.correctionId === op.links.correctionId,
                );
                if (!allocation)
                  throw new QboError("restored_payable_binding_conflict");
                const applied = await this.journal.client.journalAppliedCents(
                  op,
                  this.mappings.vendors[e.correction.supplierId]!.id,
                );
                if (
                  BigInt(applied) + BigInt(allocation.amountCents) >
                  BigInt(allocation.correction.amountCents)
                )
                  throw new QboError("external_restored_balance_conflict");
                continue;
              }
              const need =
                op.entity === "Bill"
                  ? ((e.correction?.kind === "payment_allocation"
                      ? e.correction.originalBillCents
                      : undefined) ??
                    e.creditApplication?.amountCents ??
                    e.settlement?.grossAppliedCents ??
                    e.settlement?.amountCents)
                  : (
                      e.creditApplication?.credits ??
                      e.settlement?.credits ??
                      []
                    ).find((c) => c.recognition.creditId === op.links.creditId)
                      ?.amountCents;
              if (
                need !== undefined &&
                (typeof external.Balance !== "number" ||
                  !Number.isSafeInteger(Math.round(external.Balance * 100)) ||
                  Math.abs(
                    external.Balance * 100 - Math.round(external.Balance * 100),
                  ) > 0.000001 ||
                  Math.round(external.Balance * 100) < need)
              )
                throw new QboError("external_balance_conflict");
            }
          }
          const fresh = await this.load(request);
          freshAuthority(fresh);
          if (fresh.authorizedSubject !== e.authorizedSubject)
            throw new QboError("submission_identity_changed");
          const freshHolds = await this.checkExportHolds(fresh, request, true);
          if (freshHolds.length) {
            await this.journal.recordHold(request, freshHolds[0]!);
            throw new QboError("accounting_hold_before_write");
          }
          const next = await this.resolve(fresh, request);
          if (canonical(next.plan) !== canonical(plan))
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
