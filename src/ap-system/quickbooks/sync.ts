import {
  PrivateStore,
  QboError,
  hash,
  canonical,
  safeError,
} from "./private-store";
import { QboClient } from "./client";
import { assertExport, billPlan, paymentPlan, validateMappings } from "./plans";
import type {
  ExportLoader,
  ExportRequest,
  Mappings,
  Operation,
  Plan,
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
  async execute(
    plan: Plan,
    mappings: Mappings,
    beforeWrite?: () => Promise<void>,
  ) {
    if (
      plan.realmId !== this.client.oauth.config.realmId ||
      plan.minorVersion !== 75 ||
      hash(mappings) !== plan.mappingHash
    )
      throw new QboError("operation_configuration_mismatch");
    const key = this.key(plan);
    return this.store.lock(key, async () => {
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
    });
  }
}
/** Server injection point. Never expose SyncJournal.execute as a browser payload endpoint. */
export class QuickBooksDispatcher {
  constructor(
    readonly load: ExportLoader,
    readonly mappings: Mappings,
    readonly journal: SyncJournal,
  ) {}
  async run(request: ExportRequest, mode: "dry-run" | "submit" = "dry-run", approval?: { expectedPlanHash: string }) {
    const e = await this.load(request);
    const d = assertExport(e, request);
    validateMappings(this.mappings, this.journal.client.oauth.config.realmId);
    let plan = billPlan(e, this.mappings);
    if (request.paymentVersionId) {
      const bill = await this.journal.get(plan);
      if (!bill) throw new QboError("external_bill_required");
      plan = paymentPlan(e, this.mappings, bill);
    }
    if (approval && hash(plan) !== approval.expectedPlanHash) throw new QboError("preview_changed_before_write");
    if (mode === "dry-run") return { mode, plan };
    if (
      Date.now() - e.exportedAt > 30000 ||
      e.exportedAt > Date.now() + 5000 ||
      d.identityMode !== "authenticated_human"
    )
      throw new QboError("fresh_authenticated_export_required");
    // Fake/local cases are useful in dry-run, but not evidence for live sandbox accounting.
    if (d.scope.provider !== "increase" || d.scope.environment !== "sandbox")
      throw new QboError("increase_sandbox_export_required");
    return {
      mode,
      operation: await this.journal.execute(plan, this.mappings, async () => {
        // Mapping/network waits may outlive approval. Re-fetch immediately before first POST.
        let originalBill: Operation | null = null;
        if (request.paymentVersionId) {
          originalBill = await this.journal.get(billPlan(e, this.mappings));
          if (!originalBill) throw new QboError("external_bill_required");
          await this.journal.client.verify(originalBill);
        }
        const fresh = await this.load(request);
        const current = assertExport(fresh, request);
        if (
          Date.now() - fresh.exportedAt > 30000 ||
          fresh.exportedAt > Date.now() + 5000 ||
          current.identityMode !== "authenticated_human" ||
          current.scope.provider !== "increase" ||
          current.scope.environment !== "sandbox"
        )
          throw new QboError("fresh_authenticated_export_required");
        const next = originalBill
          ? paymentPlan(fresh, this.mappings, originalBill)
          : billPlan(fresh, this.mappings);
        if (canonical(next) !== canonical(plan))
          throw new QboError("approval_changed_before_write");
      }),
    };
  }
}
