import {
  closeExportRequestSchema,
  type CloseExportRequest,
} from "../close-contracts";
import type {
  CloseReceiptAccess,
  CloseReceiptAccessLoader,
} from "./close-receipt-types";
import type { Operation, Plan } from "./types";
import { closeIdentity } from "./close-sync";
import { canonical, hash, QboError } from "./private-store";
import { SyncJournal } from "./sync";
function planOf(o: Operation): Plan {
  return {
    version: o.version,
    realmId: o.realmId,
    minorVersion: o.minorVersion,
    entity: o.entity,
    identity: o.identity,
    links: o.links,
    mappingHash: o.mappingHash,
    payload: o.payload,
  };
}
function checkAccess(a: CloseReceiptAccess, request: CloseExportRequest) {
  if (
    !a.authorizedSubject ||
    !Number.isSafeInteger(a.accessedAt) ||
    Date.now() - a.accessedAt > 30000 ||
    a.accessedAt > Date.now() + 5000 ||
    a.scope.provider !== "increase" ||
    a.scope.environment !== "sandbox" ||
    canonical(a.request) !== canonical(request) ||
    a.exportId !== `tax_reclassification:${a.journalId}` ||
    !request.actionId ||
    a.approvalId !== request.actionId
  )
    throw new QboError("fresh_tax_receipt_access_required");
}
function assertFrozenReceipt(
  op: Operation,
  access: CloseReceiptAccess,
  realmId: string,
  identity: string,
) {
  if (
    op.version !== "ap-qbo-operation-v1" ||
    op.minorVersion !== 75 ||
    op.entity !== "JournalEntry" ||
    op.identity !== identity ||
    op.realmId !== realmId ||
    op.links.closeExportId !== access.exportId ||
    op.links.closeActionId !== access.approvalId ||
    op.links.closeJournalId !== access.journalId ||
    op.links.closeApprovalHash !== access.approvalHash ||
    op.links.closeJournalHash !== access.journalHash ||
    !/^[a-f0-9]{64}$/.test(op.mappingHash) ||
    op.payloadHash !== hash(planOf(op)) ||
    op.requestId !== `ap-${hash({ realm: realmId, identity }).slice(0, 44)}` ||
    !op.submissionAuthorization?.subject ||
    op.submissionAuthorization.subject !== op.links.closeSubmittingSubject ||
    op.submissionAuthorization.planHash !== op.payloadHash ||
    !Number.isSafeInteger(op.submissionAuthorization.decidedAt)
  )
    throw new QboError("immutable_tax_receipt_conflict");
}
export async function inspectCloseReceipt(
  journal: SyncJournal,
  request: CloseExportRequest,
  access: CloseReceiptAccess,
) {
  checkAccess(access, request);
  const realmId = journal.client.oauth.config.realmId,
    identity = closeIdentity(access.scope, access.exportId);
  const op = await journal.get({ realmId, identity });
  if (op) assertFrozenReceipt(op, access, realmId, identity);
  return op;
}
/** GET/query only. No call to execute/create; cannot create an operation or refresh its approval/mappings. */
export async function recoverCloseReceipt(
  journal: SyncJournal,
  request: CloseExportRequest,
  authorize: CloseReceiptAccessLoader,
) {
  request = closeExportRequestSchema.parse(request);
  const access = await authorize(request);
  checkAccess(access, request);
  const identity = closeIdentity(access.scope, access.exportId),
    realmId = journal.client.oauth.config.realmId;
  const key = journal.key({ realmId, identity });
  return journal.store.lock(`realm-submit-${realmId}`, () =>
    journal.store.lock(key, async () => {
      const op = await journal.get({ realmId, identity });
      if (
        !op ||
        !["unknown", "sending", "succeeded"].includes(op.state) ||
        op.attempts < 1
      )
        throw new QboError("sent_tax_receipt_required");
      assertFrozenReceipt(op, access, realmId, identity);
      const next = await authorize(request);
      checkAccess(next, request);
      if (next.authorizedSubject !== access.authorizedSubject)
        throw new QboError("receipt_identity_changed");
      if (
        canonical({ ...next, accessedAt: 0 }) !==
        canonical({ ...access, accessedAt: 0 })
      )
        throw new QboError("receipt_authority_changed");
      if (op.state === "succeeded") {
        await journal.client.verify(op);
        return op;
      }
      const found = await journal.client.find(op);
      if (!found) {
        const pending = {
          ...op,
          state: "unknown" as const,
          lastError: "unknown_not_found_no_repost",
          updatedAt: Date.now(),
        };
        await journal.store.write(key, pending);
        return pending;
      }
      if (
        typeof found.Id !== "string" ||
        !/^\d{1,32}$/.test(found.Id) ||
        typeof found.SyncToken !== "string" ||
        !/^\d+$/.test(found.SyncToken)
      )
        throw new QboError("external_identity_missing");
      const recovered: Operation = {
        ...op,
        state: "succeeded",
        externalId: found.Id,
        syncToken: found.SyncToken,
        responseHash: hash(found),
        lastError: null,
        updatedAt: Date.now(),
      };
      await journal.store.write(key, recovered);
      return recovered;
    }),
  );
}
