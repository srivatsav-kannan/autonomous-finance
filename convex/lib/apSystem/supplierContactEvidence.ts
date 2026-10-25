import type { QueryCtx } from "../../_generated/server";
import type { BankScope } from "../../../src/integrations/contracts";
import type { SourceBinding } from "../../../src/ap-system/contracts";
import { assertRowScope } from "../demoAuth";
import { deny } from "./shared";
/** Exact original identity wins over a parser's editable kind/name/sourceId. */
export async function independentContactEvidence(
  ctx: QueryCtx,
  scope: BankScope,
  bindings: SourceBinding[],
  phone?: string,
) {
  const all = await ctx.db
    .query("apCaseSources")
    .withIndex("by_source", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const requestedHashes = new Set(
    all
      .filter((s) => ["invoice", "credit_note"].includes(s.document.kind))
      .map((s) => s.sha256),
  );
  let containsPhone = !phone;
  for (const b of bindings) {
    const row = all.find(
      (s) =>
        s.sourceId === b.sourceId &&
        s.revision === b.revision &&
        s.sha256 === b.sha256,
    );
    if (!row)
      deny(
        "verification_evidence_missing",
        "Retain the exact original supporting this contact review first",
      );
    assertRowScope(row, scope);
    if (
      scope.environment !== "local" &&
      row.document.provenance.kind === "synthetic"
    )
      deny(
        "synthetic_contact_evidence_forbidden",
        "Synthetic contact evidence is a local test fixture, not operator verification of a real supplier",
      );
    if (requestedHashes.has(row.sha256))
      deny(
        "independent_contact_required",
        "An invoice or credit request, including a renamed copy of its original bytes, cannot establish its own trusted channel",
      );
    if (
      phone &&
      row.document.extractedText.replace(/[^0-9+]/g, "").includes(phone)
    )
      containsPhone = true;
  }
  if (!containsPhone)
    deny(
      "contact_phone_evidence_required",
      "The independently retained source must contain the proposed phone number for human comparison with its original",
    );
}
