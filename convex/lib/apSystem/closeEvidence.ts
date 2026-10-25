import type { QueryCtx, MutationCtx } from "../../_generated/server";
import type { BankScope } from "../../../src/integrations/contracts";
import {
  sourceDocumentSchema,
  type SourceBinding,
  type SourceDocument,
} from "../../../src/ap-system/contracts";
import { canonical } from "../kernel";
import { assertRowScope } from "../demoAuth";
import { deny, metadataSource, verifyOriginal } from "./shared";
export async function closeEvidence(
  ctx: QueryCtx,
  scope: BankScope,
  bindings: SourceBinding[],
) {
  const sources: SourceDocument[] = [];
  for (const b of bindings) {
    const row = await ctx.db
      .query("apCaseSources")
      .withIndex("by_source", (q) =>
        q
          .eq("scope.runId", scope.runId)
          .eq("sourceId", b.sourceId)
          .eq("revision", b.revision),
      )
      .unique();
    if (!row || row.sha256 !== b.sha256)
      deny(
        "close_evidence_missing",
        "Exact retained original evidence is required",
      );
    assertRowScope(row, scope);
    sources.push(sourceDocumentSchema.parse(row.document));
  }
  return sources;
}
export async function retainCloseEvidence(
  ctx: MutationCtx,
  scope: BankScope,
  source: SourceDocument,
) {
  if (source.byteLength > 8 * 1024 * 1024)
    deny("source_too_large", "Close evidence is limited to8MiB per original");
  await verifyOriginal(source);
  const metadata = metadataSource(source);
  if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > 750000)
    deny("metadata_too_large", "Close evidence metadata exceeds750KiB");
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
    if (
      prior.sha256 !== source.sha256 ||
      canonical(prior.document) !== canonical(metadata)
    )
      deny(
        "source_revision_conflict",
        "Retained close source revisions are immutable",
      );
    return;
  }
  const versions = await ctx.db
    .query("apCaseSources")
    .withIndex("by_source", (q) =>
      q.eq("scope.runId", scope.runId).eq("sourceId", source.sourceId),
    )
    .collect();
  const latest = versions.sort((a, b) => b.revision - a.revision)[0];
  if (
    latest &&
    (source.revision !== latest.revision + 1 ||
      source.replaces?.sourceId !== latest.sourceId ||
      source.replaces.revision !== latest.revision ||
      source.replaces.sha256 !== latest.sha256)
  )
    deny(
      "source_revision_conflict",
      "Replacement must name the latest original revision",
    );
  await ctx.db.insert("apCaseSources", {
    scope,
    sourceId: source.sourceId,
    revision: source.revision,
    sha256: source.sha256,
    document: metadata,
  });
  for (
    let offset = 0, index = 0;
    offset < source.originalBase64!.length;
    offset += 200000, index++
  )
    await ctx.db.insert("apCaseSourceChunks", {
      scope,
      sourceId: source.sourceId,
      revision: source.revision,
      sha256: source.sha256,
      index,
      content: source.originalBase64!.slice(offset, offset + 200000),
    });
}
