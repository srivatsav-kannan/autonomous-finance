import type { CaseStatus, RuntimeMode } from "../../src/invoice-mvp/contracts";
export const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
export const dateTime = (time: number) => new Date(time).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const statusLabel: Record<CaseStatus, string> = { received: "Received", investigating: "Investigating", needs_review: "Needs review", evidence_missing: "Evidence missing", recorded: "Recorded", excluded: "Excluded", superseded: "Superseded", duplicate: "Duplicate" };
export const modeLabel: Record<RuntimeMode, string> = { deterministic: "Deterministic rules", mock_model: "Mock model · test only", live_model: "Live model" };
