import { describe, expect, it, vi } from "vitest";
import type { MutationCtx } from "../../convex/_generated/server";
import type { Seat } from "../../convex/lib/kernel";
import { appendEntry, type PostInput } from "../../convex/lib/post";
import { ROLE_CAPABILITIES } from "./roles";

const seat = { seatId: "ap", role: "ap_clerk", caps: ROLE_CAPABILITIES.ap_clerk } as Seat;
const entry = (date: string): PostInput => ({
  runId: "date-test", seat, date, memo: "Date validation", source: { kind: "bill" },
  idempotencyKey: date,
  lines: [{ account: "5000", debit: 100, credit: 0 }, { account: "2000", debit: 0, credit: 100 }],
});

function context() {
  const query = vi.fn(() => ({ withIndex: vi.fn(() => ({ unique: async () => null })) }));
  return { query, ctx: { db: { query } } as unknown as MutationCtx };
}

describe("posting dates", () => {
  it.each(["2026-02-31", "2026-02-29", "1900-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-01-00", "2026-1-01", "2026-01-01T00:00:00Z"])(
    "rejects invalid calendar date %s before touching the database",
    async (date) => {
      const { ctx, query } = context();
      expect(await appendEntry(ctx, entry(date))).toMatchObject({ ok: false, code: "invalid_entry" });
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(["2024-02-29", "2000-02-29", "2026-01-31", "2026-04-30", "0099-01-01", "9999-12-31"])(
    "allows valid calendar date %s through to period validation",
    async (date) => {
      const { ctx, query } = context();
      expect(await appendEntry(ctx, entry(date))).toMatchObject({ ok: false, code: "period_not_open" });
      expect(query).toHaveBeenCalledWith("periods");
    },
  );
});
