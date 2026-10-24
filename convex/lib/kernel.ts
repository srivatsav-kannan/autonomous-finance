import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { ROLE_CAPABILITIES, type Capabilities, type Role } from "../../src/core/roles";

// Kernel results are values, not exceptions: a blocked operation must still be able to
// write its violation record (a thrown error would roll the whole transaction back).
export type Ok<T> = { ok: true } & T;
export type Fail = { ok: false; code: string; error: string };
export type Result<T> = Ok<T> | Fail;

export function fail(code: string, error: string): Fail {
  return { ok: false, code, error };
}

/** Stable JSON: object keys sorted recursively, so hashes don't depend on key order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type Seat = Doc<"seats"> & { caps: Capabilities };

export async function loadSeat(
  ctx: QueryCtx,
  runId: string,
  seatId: string,
): Promise<Doc<"seats"> | null> {
  return await ctx.db
    .query("seats")
    .withIndex("by_run_seat", (q) => q.eq("runId", runId).eq("seatId", seatId))
    .unique();
}

/** Authenticate a seat by token. Returns the seat with its role capabilities. */
export async function authSeat(
  ctx: QueryCtx,
  runId: string,
  seatId: string,
  token: string,
): Promise<Result<{ seat: Seat }>> {
  const seat = await loadSeat(ctx, runId, seatId);
  if (!seat) return fail("unknown_seat", `no seat ${seatId} in run ${runId}`);
  if (seat.status !== "active") return fail("seat_retired", `seat ${seatId} is retired`);
  if ((await sha256Hex(token)) !== seat.tokenHash) return fail("bad_token", `bad token for ${seatId}`);
  const roleCaps = ROLE_CAPABILITIES[seat.role as Role];
  if (!roleCaps) return fail("unknown_role", `seat ${seatId} has unknown role ${seat.role}`);
  // Capabilities stored on the seat can narrow, never widen, the role's defaults.
  return { ok: true, seat: { ...seat, caps: roleCaps } };
}

export function requireAdmin(secret: string): Fail | null {
  const expected = process.env.KERNEL_ADMIN_SECRET;
  if (!expected) return fail("admin_unconfigured", "KERNEL_ADMIN_SECRET is not set on the deployment");
  if (secret !== expected) return fail("bad_admin_secret", "admin secret mismatch");
  return null;
}

export async function recordViolation(
  ctx: MutationCtx,
  runId: string,
  seatId: string,
  operation: string,
  failure: Fail,
): Promise<Fail> {
  await ctx.db.insert("violations", {
    runId,
    seatId,
    operation,
    reason: `${failure.code}: ${failure.error}`,
    at: Date.now(),
  });
  await ctx.db.insert("activity", {
    runId,
    seatId,
    kind: "blocked",
    text: `${operation} blocked: ${failure.error}`,
    at: Date.now(),
  });
  return failure;
}

/**
 * Stripe-style idempotency: the same key with the same payload returns the stored result;
 * the same key with a different payload is a conflict.
 */
export async function checkIdempotency(
  ctx: MutationCtx,
  runId: string,
  key: string,
  scope: string,
  payload: unknown,
): Promise<{ hit: true; result: unknown } | { hit: false; payloadHash: string } | { conflict: Fail }> {
  const payloadHash = await sha256Hex(canonical(payload));
  const existing = await ctx.db
    .query("idempotency")
    .withIndex("by_run_key", (q) => q.eq("runId", runId).eq("key", key))
    .unique();
  if (!existing) return { hit: false, payloadHash };
  if (existing.scope !== scope || existing.payloadHash !== payloadHash) {
    return {
      conflict: fail(
        "idempotency_conflict",
        `key ${key} was already used for a different ${existing.scope} request`,
      ),
    };
  }
  return { hit: true, result: existing.result };
}

export async function storeIdempotency(
  ctx: MutationCtx,
  runId: string,
  key: string,
  scope: string,
  payloadHash: string,
  result: unknown,
): Promise<void> {
  await ctx.db.insert("idempotency", { runId, key, scope, payloadHash, result, createdAt: Date.now() });
}

export async function logActivity(
  ctx: MutationCtx,
  runId: string,
  seatId: string,
  kind: string,
  text: string,
  refs?: unknown,
): Promise<void> {
  await ctx.db.insert("activity", { runId, seatId, kind, text, refs, at: Date.now() });
}

export async function getRun(ctx: QueryCtx, runId: string): Promise<Doc<"runs"> | null> {
  return await ctx.db
    .query("runs")
    .withIndex("by_runId", (q) => q.eq("runId", runId))
    .unique();
}

export interface Policy {
  /** Payments at or above this need a second approval. */
  dualApprovalCents: number;
  /** Payments at or above this need a human approval. */
  humanApprovalCents: number;
  /** Bills under this with a clean match can be auto-approved by an AP clerk. */
  autoApproveCents: number;
}

export const DEFAULT_POLICY: Policy = {
  dualApprovalCents: 10_000_00,
  humanApprovalCents: 50_000_00,
  autoApproveCents: 5_000_00,
};

export function runPolicy(run: Doc<"runs">): Policy {
  const p = (run.config as { policy?: Partial<Policy> } | undefined)?.policy ?? {};
  return { ...DEFAULT_POLICY, ...p };
}
