import { recoverCloseReceipt, inspectCloseReceipt } from "./close-recovery";
import type { CloseReceiptAccess } from "./close-receipt-types";
/** Request-owned period accounting bridge. Status and preview never contact QBO. */
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { BankScope } from "../../payments/contracts";
import {
  closeExportRequestSchema,
  type CloseExportRequest,
} from "../close-contracts";
import { OAuth, configFromEnv } from "./oauth";
import { PrivateStore, QboError, hash, safeError } from "./private-store";
import { QboClient } from "./client";
import { SyncJournal } from "./sync";
import {
  QuickBooksCloseDispatcher,
  type CloseExportEnvelope,
  type CloseSyncHold,
} from "./close-sync";
import { validateMappings } from "./plans";
import type { Mappings, Operation, Plan } from "./types";
import type { QBOReceipt } from "./runtime";
const receipt = (o: Operation): QBOReceipt => ({
  entity: o.entity,
  requestId: o.requestId,
  state: o.state,
  externalId: o.externalId,
  syncToken: o.syncToken,
  links: o.links,
  updatedAt: o.updatedAt,
  lastError: o.lastError,
  submissionAuthorization: o.submissionAuthorization,
});
export type QBOClosePreview =
  | { plan: Plan; planHash: string; externalWrites: 0; hold?: never }
  | { hold: CloseSyncHold; externalWrites: 0; plan?: never; planHash?: never };
export type QBOCloseSubmit =
  | { operation: QBOReceipt; hold?: never }
  | { hold: CloseSyncHold; operation?: never };
export type QBOCloseVerify =
  | { operation: QBOReceipt; verifiedAt: number; hold?: never }
  | { hold: CloseSyncHold; operation?: never; verifiedAt?: never };
export type QBOCloseStatus = {
  authority?: "current" | "historical_receipt_only";
  externalReadsAllowed?: boolean;
  externalWritesAllowed: boolean;
  configuration: "not_configured" | "incomplete" | "configured";
  grant: "authorization_required" | "available";
  mappings: "missing" | "configured";
  exportId: string;
  receipts: QBOReceipt[];
  holds: CloseSyncHold[];
  complete: boolean;
  externalVerification: "not_checked";
  reason?: string;
};
export function createQBOCloseBridge(
  human: ConvexHttpClient,
  scope: BankScope,
  env: NodeJS.ProcessEnv = process.env,
) {
  const supplied = [
    "QBO_CLIENT_ID",
    "QBO_CLIENT_SECRET",
    "QBO_REALM_ID",
    "QBO_REDIRECT_URI",
    "QBO_ENVIRONMENT",
  ].some((k) => Boolean(env[k]));
  let config: ReturnType<typeof configFromEnv> | undefined;
  try {
    if (supplied) config = configFromEnv(env);
  } catch {}
  const store = config
      ? new PrivateStore(
          resolve(env.QBO_PRIVATE_DIR ?? "var/quickbooks-private"),
        )
      : undefined,
    client =
      config && store ? new QboClient(new OAuth(config, store)) : undefined;
  const load = async (
    input: CloseExportRequest,
  ): Promise<CloseExportEnvelope> => {
    const request = closeExportRequestSchema.parse(input);
    const result = await human.query(
      makeFunctionReference<"query">("apClose:accountingExport"),
      { scope, input: request },
    );
    return { ...result, scope };
  };
  const dispatcher = async () => {
    if (!config || !store || !client)
      throw new QboError("qbo_sandbox_configuration_required");
    const mappings = await store.read<Mappings>("mappings.json");
    if (!mappings) throw new QboError("accounting_mappings_required");
    validateMappings(mappings, config.realmId);
    return new QuickBooksCloseDispatcher(
      load,
      mappings,
      new SyncJournal(store, client),
    );
  };
  return {
    async status(request: CloseExportRequest): Promise<QBOCloseStatus> {
      let current: CloseExportEnvelope | undefined;
      let historical: CloseReceiptAccess | null = null;
      try {
        current = await load(request);
      } catch (error) {
        if (!request.actionId) throw error;
        historical = await human.query(
          makeFunctionReference<"query">("apAccountingReceiptAccess:tax"),
          { scope, input: request },
        );
        if (!historical) throw error;
      }
      const exportId = current?.accounting.exportId ?? historical!.exportId;
      const status: QBOCloseStatus = {
        authority: historical ? "historical_receipt_only" : "current",
        externalReadsAllowed:
          scope.provider === "increase" && scope.environment === "sandbox",
        externalWritesAllowed:
          !historical &&
          scope.provider === "increase" &&
          scope.environment === "sandbox",
        configuration: config
          ? "configured"
          : supplied
            ? "incomplete"
            : "not_configured",
        grant: "authorization_required",
        mappings: "missing",
        exportId,
        receipts: [],
        holds: [],
        complete: true,
        externalVerification: "not_checked",
      };
      if (historical)
        status.holds = [
          {
            state: "held",
            owner: "controller",
            code: "current_tax_authority_unavailable",
            reason:
              "Current approval is unavailable. Only read-only verification or recovery of an existing sent receipt is allowed.",
            realmId: config?.realmId ?? "",
            exportId,
            request,
            createdAt: Date.now(),
          },
        ];
      if (!config || !store) return status;
      try {
        const token = await store.read<{
          realmId: string;
          clientHash: string;
          blocked: boolean;
          refreshUntil: number;
          hardUntil: number | null;
        }>("tokens.json");
        if (
          token &&
          !token.blocked &&
          token.realmId === config.realmId &&
          token.clientHash === hash(config.clientId) &&
          token.refreshUntil > Date.now() &&
          (token.hardUntil === null || token.hardUntil > Date.now())
        )
          status.grant = "available";
        if (historical) {
          const saved = await inspectCloseReceipt(
            new SyncJournal(store, client!),
            request,
            historical,
          );
          if (saved) status.receipts = [receipt(saved)];
          return status;
        }
        try {
          const d = await dispatcher();
          status.mappings = "configured";
          const preview = await d.run(request, "dry-run");
          if (preview.hold) status.holds = [preview.hold];
        } catch (error) {
          status.reason = safeError(error);
          status.complete = false;
        }
        const files = (await readdir(store.root))
          .filter((f) => /^operation-[a-f0-9]{64}\.json$/.test(f))
          .sort();
        if (files.length > 1000) status.complete = false;
        for (const file of files.slice(0, 1000)) {
          const op = await store.read<Operation>(file);
          if (
            op?.realmId === config.realmId &&
            op.links?.closeExportId === exportId
          )
            status.receipts.push(receipt(op));
        }
        return status;
      } catch (error) {
        return { ...status, reason: safeError(error), complete: false };
      }
    },
    async preview(request: CloseExportRequest): Promise<QBOClosePreview> {
      const d = await dispatcher(),
        result = await d.run(request, "dry-run");
      if (result.hold) return { hold: result.hold, externalWrites: 0 };
      if (!result.plan) throw new QboError("plan_required");
      return {
        plan: result.plan,
        planHash: hash(result.plan),
        externalWrites: 0,
      };
    },
    async submit(
      request: CloseExportRequest,
      expectedPlanHash: string,
    ): Promise<QBOCloseSubmit> {
      if (!/^[a-f0-9]{64}$/.test(expectedPlanHash))
        throw new QboError("approved_preview_required");
      const d = await dispatcher(),
        result = await d.run(request, "submit", { expectedPlanHash });
      if (result.hold) return { hold: result.hold };
      if (!result.operation) throw new QboError("operation_required");
      return { operation: receipt(result.operation) };
    },
    async verify(request: CloseExportRequest): Promise<QBOCloseVerify> {
      request = closeExportRequestSchema.parse(request);
      if (request.actionId) {
        const authorize = async () =>
          (await human.query(
            makeFunctionReference<"query">("apAccountingReceiptAccess:tax"),
            { scope, input: request },
          )) as CloseReceiptAccess | null;
        const access = await authorize();
        if (access) {
          if (!config || !store || !client)
            throw new QboError("qbo_sandbox_configuration_required");
          const result = await recoverCloseReceipt(
            new SyncJournal(store, client),
            request,
            async () => {
              const a = await authorize();
              if (!a) throw new QboError("tax_receipt_access_required");
              return a;
            },
          );
          if (result.state !== "succeeded")
            return {
              hold: {
                state: "held",
                owner: "controller",
                code: "unknown_not_found_no_repost",
                reason:
                  "The original request outcome remains unknown; no new posting is authorized.",
                realmId: config.realmId,
                exportId: access.exportId,
                request,
                createdAt: Date.now(),
              },
            };
          return { operation: receipt(result), verifiedAt: Date.now() };
        }
      }
      const d = await dispatcher(),
        result = await d.run(request, "dry-run");
      if (result.hold) return { hold: result.hold };
      if (!result.plan) throw new QboError("plan_required");
      const op = await d.journal.get(result.plan);
      if (!op || op.state !== "succeeded")
        throw new QboError("successful_operation_required");
      await d.journal.client.verify(op);
      return { operation: receipt(op), verifiedAt: Date.now() };
    },
  };
}
export type QBOCloseBridge = ReturnType<typeof createQBOCloseBridge>;
