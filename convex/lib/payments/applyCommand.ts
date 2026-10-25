import { paymentReleaseHash, assertPaymentRelease } from "../apSystem/paymentRelease";
import { derivePaymentAccountingBinding, assertPaymentAccountingBinding } from "../apSystem/paymentAccountingBinding";
import { accountingBindingHash } from "../../../src/payments/domain/accounting-binding";
import { assertGovernedCredits } from "../apSystem/governedCredits";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { assertRowScope, auditDemo, getPaymentConfig, requirePaymentSeat, requirePaymentHuman } from "../demoAuth";
import { canonical, sha256Hex } from "../kernel";
import { releaseReservations, reserveObligations } from "./reservations";
import { assertReservedObligations } from "./executionConfig";
import { resolveAPBusinessPaymentAuthority } from "../apSystem/businessAuthority";
import { commandRequestHash, buildIncreaseRequestBody, type BankCommand, type BankScope, type UnsentProviderCheck } from "../../../src/payments/contracts";
import { assertCanCancel, assertReleasableUnsent, assertSnapshotCurrent, safeSumCents } from "../../../src/payments/domain/rules";
import { businessDateSchema } from "../../../src/payments/domain/validation";
const safeSum = safeSumCents;
const dollars = (n: number) => { if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Amount must be positive integer USD cents"); };

export async function cancelUnsent(ctx: MutationCtx, version: Doc<"demoVersions">) {
  const command = await ctx.db.query("demoCommands").withIndex("by_command", q => q.eq("scope.runId", version.scope.runId).eq("command.commandId", version._id)).unique();
  // A failed first-dispatch authority check has no attempt; a human may cancel it.
  assertCanCancel(command?.attemptCount ?? 0, command?.execution === "exception" ? undefined : command?.execution);
  if (command && (command.firstAttemptAt !== undefined || command.generation !== 0 || command.providerTransferId || await ctx.db.query("demoAttempts").withIndex("by_command", q => q.eq("commandId", command._id)).first())) throw new Error("Submission may have started; resolve bank outcome before changing payment");
  if (await sha256Hex(canonical(version.snapshot)) !== version.snapshotHash) throw new Error("Corrupt snapshot requires reservation review");
  if (command) await ctx.db.patch(command._id, { execution: "cancelled" });
  await releaseReservations(ctx, version._id);
  await ctx.db.patch(version._id, { status: "cancelled" });
}
export async function versionForApproval(ctx: MutationCtx, scope: Doc<"demoConfigs">["scope"], versionId: Id<"demoVersions">, hash: string) {
  const baseConfig = await getPaymentConfig(ctx, scope);
  const version = await ctx.db.get(versionId); assertRowScope(version, scope);
  const p = version as Doc<"demoVersions">;
  if (p.status !== "awaiting_approval" || p.snapshotHash !== hash || await sha256Hex(canonical(p.snapshot)) !== hash) throw new Error("Stale payment approval");
  const authority = await resolveAPBusinessPaymentAuthority(ctx, scope, p.snapshot.bills.map(b => b.billId as Id<"demoBills">));
  const config = authority ? { ...baseConfig, ...authority } : baseConfig;
  assertSnapshotCurrent(config, p.snapshot);
  await assertPaymentAccountingBinding(ctx, scope, p.snapshot);
  await assertReservedObligations(ctx, p, config);
  if (p.snapshot.releasePolicyHash !== await paymentReleaseHash(ctx, scope, p.snapshot.bills.map(b => b.billId), p.snapshot.amountCents)) throw new Error("Stale payment release policy; cancel and prepare again");
  return p;
}
export async function requestPaymentCommand(ctx: MutationCtx, args: { scope: BankScope; seatId: string; token: string; requestKey: string; billIds: Id<"demoBills">[]; billAmounts?: { billId: Id<"demoBills">; amountCents: number }[]; executionDate?: string; credits: { creditId: Id<"demoCredits">; amountCents: number }[] }) {
    const { config: baseConfig } = await requirePaymentSeat(ctx, args, ["payments"]);
    if (!args.requestKey.trim() || !args.billIds.length || new Set(args.billIds).size !== args.billIds.length || new Set(args.credits.map(c => c.creditId)).size !== args.credits.length) throw new Error("Distinct bills/credits and request key required");
    if (args.executionDate !== undefined) businessDateSchema.parse(args.executionDate);
    const selectedAmounts = args.billAmounts?.slice().sort((a,b) => a.billId.localeCompare(b.billId));
    if (selectedAmounts) {
      if (selectedAmounts.length !== args.billIds.length || new Set(selectedAmounts.map(b => b.billId)).size !== selectedAmounts.length || selectedAmounts.some(b => !args.billIds.includes(b.billId))) throw new Error("Explicit amounts must cover each requested bill exactly once");
      selectedAmounts.forEach(b => dollars(b.amountCents));
    }
    const existing = await ctx.db.query("demoVersions").withIndex("by_key", q => q.eq("scope.runId", args.scope.runId).eq("requestKey", args.requestKey)).unique();
    if (existing) {
      if (existing.snapshot.schedule?.executionDate !== args.executionDate || canonical(existing.requestedBillAmounts ?? null) !== canonical(selectedAmounts ?? null) || existing.requestedBy !== args.seatId || canonical(existing.snapshot.bills.map(b => b.billId)) !== canonical([...args.billIds].sort()) || canonical(existing.snapshot.credits) !== canonical([...args.credits].sort((a,b) => a.creditId.localeCompare(b.creditId)))) throw new Error("Payment idempotency conflict");
      return { versionId: existing._id, snapshotHash: existing.snapshotHash };
    }
    const authority = await resolveAPBusinessPaymentAuthority(ctx, args.scope, args.billIds);
    const config = authority ? { ...baseConfig, ...authority } : baseConfig;
    const bills = [];
    for (const id of [...args.billIds].sort()) {
      const bill = await ctx.db.get(id); assertRowScope(bill, args.scope);
      const b = bill as Doc<"demoBills">;
      const linkedCase = await ctx.db.query("apCaseRecords").withIndex("by_bill", q => q.eq("scope.runId", args.scope.runId).eq("billId", id)).unique();
      if (linkedCase && (linkedCase.businessStatus !== "approved" || linkedCase.documentStatus !== "reviewed" || !linkedCase.fieldReviewId)) throw new Error("AP evidence review and business approval required before payment");
      if (b.status !== "approved" || b.flags.length || b.reservedVersionId || b.vendor !== config.beneficiary.vendor) throw new Error("Bill is not available for payment");
      const outstanding = b.approvedCents! - b.paidCents;
      const amountCents = selectedAmounts?.find(item => item.billId === id)?.amountCents ?? outstanding; dollars(amountCents);
      if (!Number.isSafeInteger(outstanding) || amountCents > outstanding) throw new Error("Payment allocation exceeds approved outstanding bill");
      bills.push({ billId: id, version: b.version, amountCents });
    }
    const credits = [...args.credits].sort((a,b) => a.creditId.localeCompare(b.creditId));
    for (const item of credits) {
      dollars(item.amountCents);
      const credit = await ctx.db.get(item.creditId); assertRowScope(credit, args.scope);
      const c = credit as Doc<"demoCredits">;
      if (c.vendor !== config.beneficiary.vendor || c.amountCents - c.reservedCents - c.consumedCents < item.amountCents) throw new Error("Credit unavailable");
    }
    await assertGovernedCredits(ctx, args.scope, credits, config.beneficiary.vendor);
    const amountCents = safeSum(bills.map(b => b.amountCents)) - safeSum(credits.map(c => c.amountCents)); dollars(amountCents);
    const accountingBinding = await derivePaymentAccountingBinding(ctx, args.scope, bills, credits);
    const releasePolicyHash = await paymentReleaseHash(ctx, args.scope, args.billIds, amountCents);
    const snapshot = { ...(releasePolicyHash ? {releasePolicyHash} : {}), ...(accountingBinding ? {accountingBinding} : {}), scope: args.scope, bills, credits, amountCents, currency: "USD" as const, destination: { externalAccountId: config.beneficiary.externalAccountId, version: config.beneficiary.version }, policyVersion: config.policyVersion, ...(args.executionDate !== undefined ? { schedule: { executionDate: args.executionDate, timeZone: "UTC" as const } } : {}) };
    const snapshotHash = await sha256Hex(canonical(snapshot));
    const versionId = await ctx.db.insert("demoVersions", { scope: args.scope, snapshot, snapshotHash, requestedBy: args.seatId, requestKey: args.requestKey, ...(selectedAmounts ? { requestedBillAmounts: selectedAmounts } : {}), status: "awaiting_approval", approvals: [], reservations: "none", createdAt: Date.now() });
    await reserveObligations(ctx, versionId);
    return { versionId, snapshotHash };
}

export async function approveWithinPolicyCommand(ctx: MutationCtx, args: { scope: BankScope; seatId: string; token: string; versionId: Id<"demoVersions">; snapshotHash: string }) {
    const { config } = await requirePaymentSeat(ctx, args, ["controller", "cfo_agent"]);
    const p = await versionForApproval(ctx, args.scope, args.versionId, args.snapshotHash);
    if (p.requestedBy === args.seatId || p.snapshot.amountCents > config.controllerLimitCents) throw new Error("Controller approval outside policy");
    if (!p.approvals.some(a => a.seatId === args.seatId)) await ctx.db.patch(p._id, { approvals: [...p.approvals, { seatId: args.seatId, subject: `agent:${args.seatId}`, kind: "controller", snapshotHash: args.snapshotHash, at: Date.now() }] });
    return { status: "awaiting_human_approval" as const };
}

export async function approveAndQueueCommand(ctx: MutationCtx, args: { scope: BankScope; versionId: Id<"demoVersions">; snapshotHash: string }) {
    const { seat, subject } = await requirePaymentHuman(ctx, args.scope);
    const existing = await ctx.db.get(args.versionId); assertRowScope(existing, args.scope);
    const e = existing as Doc<"demoVersions">;
    if (e.status === "queued" && e.snapshotHash === args.snapshotHash && e.approvals.some(a => a.subject === subject && a.kind === "human")) return { commandId: (await ctx.db.query("demoCommands").withIndex("by_command", q => q.eq("scope.runId", args.scope.runId).eq("command.commandId", e._id)).unique())!._id };
    const p = await versionForApproval(ctx, args.scope, args.versionId, args.snapshotHash);
    if (p.requestedBy === seat.seatId) throw new Error("Requester cannot approve own payment");
    await assertPaymentRelease(ctx, args.scope, p.snapshot, subject);
    const request = { ...(p.snapshot.accountingBinding ? {accountingBindingHash: await accountingBindingHash(p.snapshot.accountingBinding)} : {}), commandId: p._id, scope: args.scope, amountCents: p.snapshot.amountCents, currency: "USD" as const, destination: p.snapshot.destination, approvalVersion: p._id, idempotencyKey: `demo:${p._id}` };
    const savedRequest = args.scope.provider === "increase" ? { ...request, providerRequest: buildIncreaseRequestBody(request) } : request;
    const command: BankCommand = { ...savedRequest, requestHash: await commandRequestHash(savedRequest) };
    await ctx.db.patch(p._id, { status: "queued", reservations: "reserved", approvals: [...p.approvals, { seatId: seat.seatId, subject, kind: "human", snapshotHash: args.snapshotHash, at: Date.now() }] });
    const commandId = await ctx.db.insert("demoCommands", { scope: args.scope, command, versionId: p._id, execution: "queued", posting: "unposted", reconciliation: "unmatched", generation: 0, attemptCount: 0, nextAttemptAt: Date.now(), createdAt: Date.now() });
    await auditDemo(ctx, args.scope, seat.seatId, "payment_approved", { commandId, versionId: p._id, snapshotHash: p.snapshotHash });
    return { commandId };
}

/** Human-only release of a command claimed but never accepted by the bank. Convex holds no bank
 * credentials, so the trusted operator harness performs the provider check and this mutation
 * re-validates it, checks local evidence, and records who, why and what was checked. */
export async function releaseUnsentPayment(ctx: MutationCtx, args: { scope: BankScope; commandId: Id<"demoCommands">; reason: string; providerCheck: UnsentProviderCheck }) {
  const { seat, subject } = await requirePaymentHuman(ctx, args.scope);
  if (!args.reason.trim()) throw new Error("A human release reason is required");
  const row = await ctx.db.get(args.commandId); assertRowScope(row, args.scope);
  const c = row as Doc<"demoCommands">;
  const now = Date.now();
  assertReleasableUnsent(c, now, args.providerCheck);
  // Local evidence must agree with the provider check: nothing accepted, observed or imported.
  const [attempts, observations, transactions, notices] = await Promise.all([
    ctx.db.query("demoAttempts").withIndex("by_command", q => q.eq("commandId", c._id)).collect(),
    ctx.db.query("demoObservations").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect(),
    ctx.db.query("demoTransactions").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect(),
    ctx.db.query("demoInbox").withIndex("by_run_processed", q => q.eq("scope.runId", args.scope.runId).eq("processed", false)).first(),
  ]);
  if (attempts.some(a => a.result === "provider_accepted") || observations.some(o => o.observation.commandId === c.command.commandId) ||
      transactions.some(t => t.transaction.commandId === c.command.commandId)) throw new Error("Local bank evidence exists for this command; reconcile instead of releasing");
  if (notices) throw new Error("Resolve pending bank notifications before releasing a payment");
  const version = await ctx.db.get(c.versionId);
  if (!version || await sha256Hex(canonical(version.snapshot)) !== version.snapshotHash) throw new Error("Corrupt snapshot requires reservation review");
  const release = { seatId: seat.seatId, subject, reason: args.reason.trim(), at: now, providerCheck: args.providerCheck };
  await ctx.db.patch(c._id, { execution: "cancelled", release, leaseToken: undefined, leaseExpiresAt: undefined,
    lastError: undefined });
  await releaseReservations(ctx, version._id);
  await ctx.db.patch(version._id, { status: "cancelled" });
  await auditDemo(ctx, args.scope, seat.seatId, "unsent_payment_released", {
    commandId: c._id, versionId: version._id, reason: release.reason, firstAttemptAt: c.firstAttemptAt, attemptCount: c.attemptCount,
    originalRequestHash: c.command.requestHash, originalKey: c.command.idempotencyKey, providerCheck: args.providerCheck,
  });
}

export async function resumePayment(ctx: MutationCtx, args: { scope: BankScope; commandId: Id<"demoCommands">; reason: string }) {
    const { seat } = await requirePaymentHuman(ctx, args.scope);
    const row = await ctx.db.get(args.commandId); assertRowScope(row, args.scope);
    const c = row as Doc<"demoCommands">;
    if (c.execution !== "exception" || !args.reason.trim()) throw new Error("A reason and exception command are required");
    if (c.firstAttemptAt === undefined) throw new Error("No original dispatch time; cancel a never-attempted payment or review the historical outcome");
    await ctx.db.patch(c._id, { execution: c.providerTransferId ? "pending" : "unknown", nextAttemptAt: Date.now(), budgetAttemptCount: 0, budgetStartedAt: Date.now(), lastError: undefined });
    await auditDemo(ctx, args.scope, seat.seatId, "command_resumed", { commandId: c._id, reason: args.reason, originalRequestHash: c.command.requestHash, originalKey: c.command.idempotencyKey });
}
