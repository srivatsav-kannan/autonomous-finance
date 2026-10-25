import type { SourceDocument } from "../contracts";
/** Original page order is authoritative; duplicate or reordered provider pages cannot be complete. */
export function pageStatuses(
  count: number,
  pages: Record<string, unknown>[],
): SourceDocument["pageStatus"] {
  const exact =
    pages.length === count && pages.every((p, i) => p.page_number === i + 1);
  return Array.from({ length: count }, (_, i) => {
    const page = i + 1,
      matches = pages.filter((p) => p.page_number === page);
    if (!matches.length)
      return {
        page,
        status: "missing" as const,
        reason: "Provider omitted original page",
      };
    if (matches.length !== 1)
      return {
        page,
        status: "failed" as const,
        reason: "Duplicate provider page identity",
      };
    if (!exact)
      return {
        page,
        status: "failed" as const,
        reason: "Provider/original page order or count mismatch",
      };
    return {
      page,
      status:
        matches[0]!.success === true
          ? ("complete" as const)
          : ("failed" as const),
      reason: matches[0]!.success === true ? null : "Provider page failed",
    };
  });
}
