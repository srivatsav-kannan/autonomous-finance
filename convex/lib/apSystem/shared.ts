import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { canonical, sha256Hex } from "../kernel";
import {
  assertRowScope,
  requirePaymentHuman,
  requirePaymentSeat,
} from "../demoAuth";
import type { BankScope } from "../../../src/integrations/contracts";
import {
  AP_POLICY_VERSION,
  intakeSchema,
  type APIntake,
  type ReviewRequest,
  type SourceDocument,
} from "../../../src/ap-system/contracts";
import { sourceKey } from "../../../src/ap-system/policy";

export function deny(code: string, reason: string): never {
  throw new ConvexError({ code, reason });
}
export type ReadAuth = { scope: BankScope; seatId?: string; token?: string };
export async function readAuth(ctx: QueryCtx, args: ReadAuth) {
  if (args.seatId !== undefined || args.token !== undefined)
    return requirePaymentSeat(
      ctx,
      { scope: args.scope, seatId: args.seatId ?? "", token: args.token ?? "" },
      ["ap_clerk", "controller", "payments", "auditor", "cfo_agent"],
    );
  return requirePaymentHuman(ctx, args.scope);
}
export async function caseRow(
  ctx: QueryCtx,
  scope: BankScope,
  id: string,
): Promise<Doc<"apCaseRecords">> {
  const normalized = ctx.db.normalizeId("apCaseRecords", id);
  if (!normalized) deny("case_not_found", "Case not found in current scope");
  const row = await ctx.db.get(normalized);
  assertRowScope(row, scope);
  return row as Doc<"apCaseRecords">;
}
export function bindings(input: APIntake) {
  return input.documents
    .map(({ sourceId, revision, sha256 }) => ({ sourceId, revision, sha256 }))
    .sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
}
export async function snapshot(input: APIntake) {
  return sha256Hex(
    canonical({
      contractVersion: input.contractVersion,
      candidate: input.candidate,
      extraction: input.extraction,
      purchasingEvidence: input.purchasingEvidence,
      documents: input.documents
        .map((d) => ({
          ...bindings({ ...input, documents: [d] })[0]!,
          pageStatus: d.pageStatus,
        }))
        .sort((a, b) => sourceKey(a).localeCompare(sourceKey(b))),
      policyVersion: AP_POLICY_VERSION,
    }),
  );
}
export function currentReview(
  row: Doc<"apCaseRecords">,
  request: ReviewRequest,
): APIntake {
  const input = intakeSchema.parse(row.intake);
  if (
    row.currentRevision !== request.expectedRevision ||
    row.snapshotHash !== request.snapshotHash ||
    canonical(bindings(input)) !==
      canonical(
        [...request.sourceBindings].sort((a, b) =>
          sourceKey(a).localeCompare(sourceKey(b)),
        ),
      )
  )
    deny(
      "stale_review",
      "Review must bind the current case revision, snapshot and every source version",
    );
  const evidenceIds = new Set(
    input.candidate?.evidence.map((e) => e.evidenceId) ??
      input.extraction.evidence.map((e) => e.evidenceId),
  );
  if (
    new Set(request.evidenceIds).size !== request.evidenceIds.length ||
    request.evidenceIds.some((e) => !evidenceIds.has(e))
  )
    deny(
      "invalid_review_evidence",
      "Review refers to missing or duplicate evidence",
    );
  return input;
}
export async function replay(
  ctx: QueryCtx,
  scope: BankScope,
  key: string,
  payload: unknown,
) {
  const payloadHash = await sha256Hex(canonical(payload));
  const prior = await ctx.db
    .query("apCaseOperations")
    .withIndex("by_key", (q) => q.eq("scope.runId", scope.runId).eq("key", key))
    .unique();
  if (prior) {
    assertRowScope(prior, scope);
    if (prior.payloadHash !== payloadHash)
      deny(
        "idempotency_conflict",
        "Operation key was already used with different input or authority",
      );
  }
  return { payloadHash, prior };
}
export async function receipt(
  ctx: MutationCtx,
  scope: BankScope,
  key: string,
  payloadHash: string,
  result: unknown,
) {
  await ctx.db.insert("apCaseOperations", { scope, key, payloadHash, result });
}
export async function verifyOriginal(source: SourceDocument) {
  if (!source.originalBase64)
    deny(
      "original_required",
      "Retained original bytes are required for AP intake",
    );
  if (source.byteLength > 8 * 1024 * 1024)
    deny(
      "source_too_large",
      "Original exceeds the verified 8 MiB packet bound; staged larger-file storage is not yet supported",
    );
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(source.originalBase64), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    deny("invalid_original", "Invalid original base64");
  }
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (bytes.byteLength !== source.byteLength || digest !== source.sha256)
    deny(
      "source_hash_mismatch",
      "Original bytes do not match their immutable source binding",
    );
}
export function metadataSource(source: SourceDocument): SourceDocument {
  const { originalBase64: _, ...metadata } = source;
  return {
    ...metadata,
    originalRef: `retained:${source.sourceId}:${source.revision}:${source.sha256}`,
  };
}
export function storedIntake(input: APIntake): APIntake {
  return { ...input, documents: input.documents.map(metadataSource) };
}
function immutableMetadata(source: SourceDocument) {
  const {
    deliveryId: _,
    name: __,
    originalRef: ___,
    provenance,
    ...metadata
  } = metadataSource(source);
  const { originalFilename: ____, ...origin } = provenance;
  return { ...metadata, provenance: origin };
}
export async function sourceBytes(
  ctx: QueryCtx,
  scope: BankScope,
  source: SourceDocument,
): Promise<string> {
  const chunks = await ctx.db
    .query("apCaseSourceChunks")
    .withIndex("by_source", (q) =>
      q
        .eq("scope.runId", scope.runId)
        .eq("sourceId", source.sourceId)
        .eq("revision", source.revision),
    )
    .collect();
  if (chunks.some((c, i) => c.index !== i || c.sha256 !== source.sha256))
    deny(
      "source_storage_incomplete",
      "Original source chunks are missing or belong to another revision",
    );
  const originalBase64 = chunks.map((c) => c.content).join("");
  await verifyOriginal({ ...source, originalBase64 });
  return originalBase64;
}
export async function saveSources(
  ctx: MutationCtx,
  scope: BankScope,
  caseId: Id<"apCaseRecords">,
  input: APIntake,
) {
  for (const source of input.documents) {
    const prior = await ctx.db
      .query("apCaseSources")
      .withIndex("by_source", (q) =>
        q
          .eq("scope.runId", scope.runId)
          .eq("sourceId", source.sourceId)
          .eq("revision", source.revision),
      )
      .unique();
    if (prior) {
      assertRowScope(prior, scope);
      if (
        prior.sha256 !== source.sha256 ||
        canonical(immutableMetadata(prior.document)) !==
          canonical(immutableMetadata(source))
      )
        deny(
          "source_revision_conflict",
          "Source bytes, extracted text, page status and processor metadata are immutable per revision; explicitly import a new revision",
        );
    } else {
      const versions = await ctx.db
        .query("apCaseSources")
        .withIndex("by_source", (q) =>
          q.eq("scope.runId", scope.runId).eq("sourceId", source.sourceId),
        )
        .collect();
      const last = versions.sort((a, b) => b.revision - a.revision)[0];
      if (
        last &&
        (source.revision !== last.revision + 1 ||
          !source.replaces ||
          sourceKey(source.replaces) !== sourceKey(last))
      )
        deny(
          "source_revision_conflict",
          "New source version must explicitly replace the latest retained source binding",
        );
      await ctx.db.insert("apCaseSources", {
        scope,
        sourceId: source.sourceId,
        revision: source.revision,
        sha256: source.sha256,
        document: metadataSource(source),
      });
      const bytes = source.originalBase64!;
      for (
        let offset = 0, index = 0;
        offset < bytes.length;
        offset += 200_000, index++
      )
        await ctx.db.insert("apCaseSourceChunks", {
          scope,
          sourceId: source.sourceId,
          revision: source.revision,
          sha256: source.sha256,
          index,
          content: bytes.slice(offset, offset + 200_000),
        });
    }
    const delivery = await ctx.db
      .query("apCaseDeliveries")
      .withIndex("by_delivery", (q) =>
        q.eq("scope.runId", scope.runId).eq("deliveryId", source.deliveryId),
      )
      .unique();
    if (delivery) {
      assertRowScope(delivery, scope);
      if (
        delivery.caseId !== caseId ||
        sourceKey(delivery) !== sourceKey(source)
      )
        deny(
          "delivery_conflict",
          "Delivery ID already identifies another source/case",
        );
    } else
      await ctx.db.insert("apCaseDeliveries", {
        scope,
        caseId,
        deliveryId: source.deliveryId,
        sourceId: source.sourceId,
        revision: source.revision,
        sha256: source.sha256,
        name: source.name,
        at: Date.now(),
      });
  }
}
