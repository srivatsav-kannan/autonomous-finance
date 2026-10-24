import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { authSeat, canonical, type Seat } from "./kernel";
import { ROLE_CAPABILITIES } from "../../src/core/roles";
import { sameBankScope, type BankScope } from "../../src/integrations/contracts";
export { scopeValidator } from "../demoSchema";

export async function demoConfigForRun(ctx: QueryCtx, runId: string) {
  return ctx.db.query("demoConfigs").withIndex("by_run", q => q.eq("scope.runId", runId)).unique();
}
export async function getDemoConfig(ctx: QueryCtx, scope: BankScope) {
  const config = await demoConfigForRun(ctx, scope.runId);
  if (!config || !sameBankScope(config.scope, scope)) throw new Error("Forbidden: demo organization/run/provider/environment/account mismatch");
  return config;
}
export async function assertLegacyRun(ctx: QueryCtx, runId: string) {
  if (await demoConfigForRun(ctx, runId)) throw new Error("Demo runs require scoped demo APIs");
}
export async function requireService(ctx: QueryCtx, scope: BankScope, token: string, kind: "dispatcher" | "evidence") {
  const expected = process.env[kind === "dispatcher" ? "AP_DISPATCH_SECRET" : "AP_EVIDENCE_SECRET"];
  if (!expected || !token || token !== expected) throw new Error(`Forbidden: ${kind} credential required`);
  // A deployment must not accidentally collapse service privilege into one credential.
  if (process.env.AP_DISPATCH_SECRET === process.env.AP_EVIDENCE_SECRET || expected === process.env.KERNEL_ADMIN_SECRET) throw new Error("Demo service credentials must be distinct");
  let boundScope: BankScope;
  try { boundScope = JSON.parse(process.env.AP_BANK_SCOPE ?? ""); }
  catch { throw new Error("AP_BANK_SCOPE deployment binding required"); }
  if (!boundScope || !sameBankScope(boundScope, scope)) throw new Error("Forbidden: service account scope mismatch");
  return getDemoConfig(ctx, scope);
}
export async function requireDemoSeat(ctx: QueryCtx, args: { scope: BankScope; seatId: string; token: string }, roles: string[]) {
  const config = await getDemoConfig(ctx, args.scope);
  const auth = await authSeat(ctx, args.scope.runId, args.seatId, args.token);
  if (!auth.ok || !roles.includes(auth.seat.role) || auth.seat.kind !== "agent") throw new Error("Forbidden: agent role or credential");
  return { config, seat: auth.seat };
}
export async function requireHuman(ctx: QueryCtx, scope: BankScope) {
  const config = await getDemoConfig(ctx, scope);
  const identity = await ctx.auth.getUserIdentity();
  // tokenIdentifier includes issuer, preventing equal subjects from another issuer authenticating.
  const binding = identity && config.humanSubjects.find(p => p.subject === identity.tokenIdentifier);
  if (!binding) throw new Error("Forbidden: independently authenticated human required");
  const seat = await ctx.db.query("seats").withIndex("by_run_seat", q => q.eq("runId", scope.runId).eq("seatId", binding.seatId)).unique();
  if (!seat || seat.kind !== "human" || seat.role !== "human_cfo" || seat.status !== "active") throw new Error("Forbidden: active human CFO binding required");
  return { config, seat, subject: binding.subject };
}
/** Internal accounting authority; never accepted as a public request argument. */
export function accountingSeat(runId: string): Seat {
  return { _id: "demo-accounting" as Doc<"seats">["_id"], _creationTime: 0, runId, seatId: "demo-evidence-service", role: "controller", name: "Verified demo accounting", kind: "agent", capabilities: {}, status: "active", tokenHash: "", createdAt: 0, caps: ROLE_CAPABILITIES.controller };
}
export function assertRowScope(row: {scope: BankScope} | null, scope: BankScope): asserts row is {scope: BankScope} {
  if (!row || !sameBankScope(row.scope, scope)) throw new Error("Forbidden: row outside account scope");
}
export async function auditDemo(ctx: MutationCtx, scope: BankScope, actor: string, kind: string, refs: unknown) {
  await ctx.db.insert("activity", { runId: scope.runId, seatId: actor, kind, text: `AP demo ${kind}`, refs: JSON.parse(canonical(refs)), at: Date.now() });
}
