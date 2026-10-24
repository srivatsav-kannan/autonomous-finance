import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { scopeValidator } from "./demoSchema";
import { accountingSeat, assertRowScope, auditDemo, getDemoConfig, requireDemoSeat, requireHuman, requireService } from "./lib/demoAuth";
import { releaseReservations } from "./lib/demoEffects";
import { canonical, getRun, requireAdmin, sha256Hex } from "./lib/kernel";
import { appendDemoEntry, validDemoDate } from "./lib/demoPost";
import { normalizeInvoiceNumber } from "./lib/invoiceIdentity";
import { commandRequestHash, buildIncreaseRequestBody, type BankCommand } from "../src/integrations/contracts";

const scoped = { scope: scopeValidator };
const agent = { ...scoped, seatId: v.string(), token: v.string() };
const service = { ...scoped, token: v.string() };
const validDate = validDemoDate;
const safeSum = (xs: number[]) => xs.reduce((n, x) => { const result = n + x; if (!Number.isSafeInteger(result)) throw new Error("Unsafe cumulative USD cents"); return result; }, 0);
const dollars = (n: number) => { if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Amount must be positive integer USD cents"); };

/** Trusted setup activates an immutable account, beneficiary, policy and human identity binding. */
export const configure = mutation({
  args: { ...scoped, secret: v.string(), beneficiary: v.object({ vendor: v.string(), externalAccountId: v.string(), version: v.string() }), policyVersion: v.string(), controllerLimitCents: v.number(), humanSubjects: v.array(v.object({ subject: v.string(), seatId: v.string() })) },
  handler: async (ctx, args) => {
    const denied = requireAdmin(args.secret); if (denied) throw new Error(denied.error);
    if (!await getRun(ctx, args.scope.runId)) throw new Error("Create run before configuring demo");
    const existing = await ctx.db.query("demoConfigs").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).unique();
    if (existing) throw new Error("Demo configuration is immutable; create a fresh run");
    if ((args.scope.provider === "fake") !== (args.scope.environment === "local")) throw new Error("Provider/environment mismatch");
    if (![args.scope.organizationId, args.scope.runId, args.scope.accountId, args.beneficiary.vendor, args.beneficiary.externalAccountId, args.beneficiary.version, args.policyVersion].every(s => s.trim().length > 0)) throw new Error("Empty configuration field");
    dollars(args.controllerLimitCents);
    if (!args.humanSubjects.length || new Set(args.humanSubjects.map(p => p.subject)).size !== args.humanSubjects.length) throw new Error("Distinct human identities required");
    // Historical bank outcomes must be resolved, never silently moved into this dispatcher.
    for (const table of ["paymentIntents", "bills", "journalEntries"] as const) {
      const old = await ctx.db.query(table).filter(q => q.eq(q.field("runId"), args.scope.runId)).first();
      if (old) throw new Error("Demo activation requires a fresh run without historical financial rows");
    }
    for (const binding of args.humanSubjects) {
      const seat = await ctx.db.query("seats").withIndex("by_run_seat", q => q.eq("runId", args.scope.runId).eq("seatId", binding.seatId)).unique();
      if (!seat || seat.kind !== "human" || seat.role !== "human_cfo" || !binding.subject.includes("|")) throw new Error("Bind issuer|subject to an existing human CFO");
    }
    const { secret: _, ...config } = args;
    await ctx.db.insert("demoConfigs", { ...config, createdAt: Date.now() });
    return { ok: true as const };
  },
});

export const recordBill = mutation({
  args: { ...agent, vendor: v.string(), invoiceNumber: v.string(), invoiceDate: v.string(), originalCents: v.number(), expenseAccount: v.string(), evidence: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { config } = await requireDemoSeat(ctx, args, ["ap_clerk"]);
    dollars(args.originalCents);
    if (args.vendor !== config.beneficiary.vendor || !validDate(args.invoiceDate) || !args.evidence.length || args.evidence.some(s => !s.trim())) throw new Error("Invalid vendor, date or invoice evidence");
    if (!["5000", "5200", "5300", "6000", "6100", "6200"].includes(args.expenseAccount)) throw new Error("AP expense account required");
    const invoiceNumber = normalizeInvoiceNumber(args.invoiceNumber);
    if (!invoiceNumber) throw new Error("Invoice identity required");
    const recordHash = await sha256Hex(canonical({ vendor: args.vendor, invoiceNumber, invoiceDate: args.invoiceDate, originalCents: args.originalCents, expenseAccount: args.expenseAccount, evidence: args.evidence }));
    const prior = await ctx.db.query("demoBills").withIndex("by_invoice", q => q.eq("scope.runId", args.scope.runId).eq("vendor", args.vendor).eq("invoiceNumber", invoiceNumber)).unique();
    if (prior) {
      if (prior.recordHash ? prior.recordHash !== recordHash : (prior.originalCents !== args.originalCents || prior.invoiceDate !== args.invoiceDate || prior.expenseAccount !== args.expenseAccount || canonical(prior.evidence) !== canonical(args.evidence))) throw new Error("Invoice idempotency conflict");
      return { billId: prior._id, replayed: true };
    }
    const billId = await ctx.db.insert("demoBills", { scope: args.scope, vendor: args.vendor, invoiceNumber, invoiceDate: args.invoiceDate, recordHash, originalCents: args.originalCents, expenseAccount: args.expenseAccount, evidence: args.evidence, flags: [], paidCents: 0, version: 1, createdBy: args.seatId, status: "recorded", createdAt: Date.now() });
    return { billId, replayed: false };
  },
});

export const attachEvidence = mutation({
  args: { ...agent, billId: v.id("demoBills"), evidence: v.string() },
  handler: async (ctx, args) => {
    await requireDemoSeat(ctx, args, ["ap_clerk"]);
    const bill = await ctx.db.get(args.billId); assertRowScope(bill, args.scope);
    if (!args.evidence.trim()) throw new Error("Evidence reference required");
    await ctx.db.patch(args.billId, { evidence: [...new Set([...(bill as Doc<"demoBills">).evidence, args.evidence])] });
  },
});

async function cancelUnsent(ctx: MutationCtx, version: Doc<"demoVersions">) {
  const command = await ctx.db.query("demoCommands").withIndex("by_command", q => q.eq("scope.runId", version.scope.runId).eq("command.commandId", version._id)).unique();
  if (command && (command.attemptCount > 0 || command.execution !== "queued")) throw new Error("Submission may have started; resolve bank outcome before changing payment");
  if (command) await ctx.db.patch(command._id, { execution: "cancelled" });
  await releaseReservations(ctx, version._id);
  await ctx.db.patch(version._id, { status: "cancelled" });
}
export const flagException = mutation({
  args: { ...agent, billId: v.id("demoBills"), reason: v.string() },
  handler: async (ctx, args) => {
    await requireDemoSeat(ctx, args, ["ap_clerk"]);
    const bill = await ctx.db.get(args.billId); assertRowScope(bill, args.scope);
    if (!args.reason.trim()) throw new Error("Exception reason required");
    const typed = bill as Doc<"demoBills">;
    if (typed.reservedVersionId) {
      const version = await ctx.db.get(typed.reservedVersionId);
      const command = await ctx.db.query("demoCommands").withIndex("by_command", q => q.eq("scope.runId", args.scope.runId).eq("command.commandId", typed.reservedVersionId!)).unique();
      if (version && (!command || command.attemptCount === 0)) await cancelUnsent(ctx, version);
      else await auditDemo(ctx, args.scope, args.seatId, "exception_after_dispatch", { billId: typed._id, reason: args.reason, commandId: command?._id });
    }
    await ctx.db.patch(args.billId, { flags: [...typed.flags, args.reason], version: typed.version + 1 });
  },
});

/** Resolve a reviewed discrepancy without revising any approved or paid financial amount. */
export const resolveBillExceptions = mutation({
  args: { ...scoped, billId: v.id("demoBills"), expectedVersion: v.number(), flags: v.array(v.string()), reason: v.string(), evidence: v.array(v.string()), seatId: v.optional(v.string()), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = args.seatId !== undefined || args.token !== undefined
      ? (await requireDemoSeat(ctx, { scope: args.scope, seatId: args.seatId ?? "", token: args.token ?? "" }, ["controller"])).seat
      : (await requireHuman(ctx, args.scope)).seat;
    const bill = await ctx.db.get(args.billId); assertRowScope(bill, args.scope);
    const typed = bill as Doc<"demoBills">;
    if (typed.createdBy === actor.seatId) throw new Error("Bill creator cannot resolve their own exceptions");
    if (typed.version !== args.expectedVersion) throw new Error("Stale bill exception review");
    if (!args.reason.trim() || !args.flags.length || new Set(args.flags).size !== args.flags.length ||
        args.flags.some(flag => !typed.flags.includes(flag)) || !args.evidence.length ||
        args.evidence.some(ref => !ref.trim() || !typed.evidence.includes(ref))) {
      throw new Error("Select current flags and attached evidence with a resolution reason");
    }
    await ctx.db.patch(typed._id, { flags: typed.flags.filter(flag => !args.flags.includes(flag)), version: typed.version + 1 });
    await auditDemo(ctx, args.scope, actor.seatId, "bill_exceptions_resolved", {
      billId: typed._id, reviewedVersion: typed.version, flags: args.flags, reason: args.reason.trim(), evidence: args.evidence,
    });
    return { billId: typed._id, version: typed.version + 1 };
  },
});

async function accept(ctx: MutationCtx, args: {scope: Doc<"demoConfigs">["scope"]; billId: Id<"demoBills">; approvedCents: number}, actor: string, limit: number) {
  const bill = await ctx.db.get(args.billId); assertRowScope(bill, args.scope);
  const typed = bill as Doc<"demoBills">;
  dollars(args.approvedCents);
  if (args.approvedCents > typed.originalCents || args.approvedCents > limit || typed.createdBy === actor) throw new Error("Bill approval amount/authority/segregation violation");
  if (typed.reservedVersionId || typed.paidCents > 0) throw new Error("Cannot revise reserved or paid bill");
  if (typed.entryId) {
    if (typed.approvedCents !== args.approvedCents) throw new Error("Accepted amounts are immutable; use a separately approved credit");
    if (!typed.flags.length) return { billId: typed._id, entryId: typed.entryId };
    await ctx.db.patch(typed._id, { flags: [], version: typed.version + 1 });
    return { billId: typed._id, entryId: typed.entryId };
  }
  const posted = await appendDemoEntry(ctx, { runId: args.scope.runId, seat: accountingSeat(args.scope.runId), date: typed.invoiceDate, memo: `Accepted invoice ${typed.vendor}/${typed.invoiceNumber}`, source: { kind: "bill", ref: typed._id }, lines: [{ account: typed.expenseAccount, debit: args.approvedCents, credit: 0 }, { account: "2000", debit: 0, credit: args.approvedCents }], idempotencyKey: `demo:bill:${typed._id}` });
  if (!posted.ok) throw new Error(posted.error); // Roll back all financial writes on any failure.
  await ctx.db.patch(typed._id, { approvedCents: args.approvedCents, status: "approved", flags: [], version: typed.version + 1, entryId: posted.entryId });
  await auditDemo(ctx, args.scope, actor, "bill_accepted", { billId: typed._id, approvedCents: args.approvedCents });
  return { billId: typed._id, entryId: posted.entryId };
}
export const acceptBill = mutation({ args: { ...agent, billId: v.id("demoBills"), approvedCents: v.number() }, handler: async (ctx, args) => { const { config } = await requireDemoSeat(ctx, args, ["controller"]); return accept(ctx, args, args.seatId, config.controllerLimitCents); } });
export const humanAcceptBill = mutation({ args: { ...scoped, billId: v.id("demoBills"), approvedCents: v.number() }, handler: async (ctx, args) => { const { seat } = await requireHuman(ctx, args.scope); return accept(ctx, args, seat.seatId, Number.MAX_SAFE_INTEGER); } });

export const recordCredit = mutation({
  args: { ...scoped, reference: v.string(), amountCents: v.number(), evidence: v.string(), date: v.string(), expenseAccount: v.string() },
  handler: async (ctx, args) => {
    const { config, seat } = await requireHuman(ctx, args.scope);
    dollars(args.amountCents);
    if (!validDate(args.date) || !args.reference.trim() || !args.evidence.trim() || !["5000", "5200", "5300", "6000", "6100", "6200"].includes(args.expenseAccount)) throw new Error("Valid credit reference, evidence and expense account required");
    const existing = await ctx.db.query("demoCredits").withIndex("by_reference", q => q.eq("scope.runId", args.scope.runId).eq("vendor", config.beneficiary.vendor).eq("reference", args.reference)).unique();
    if (existing) {
      if (existing.amountCents !== args.amountCents || existing.evidence !== args.evidence || existing.date !== args.date || existing.expenseAccount !== args.expenseAccount) throw new Error("Credit idempotency conflict");
      return { creditId: existing._id };
    }
    const posted = await appendDemoEntry(ctx, { runId: args.scope.runId, seat: accountingSeat(args.scope.runId), date: args.date, memo: `Approved credit ${args.reference}`, source: { kind: "vendor_credit", ref: args.reference }, lines: [{ account: "2000", debit: args.amountCents, credit: 0 }, { account: args.expenseAccount, debit: 0, credit: args.amountCents }], idempotencyKey: `demo:credit:${args.reference}` });
    if (!posted.ok) throw new Error(posted.error);
    const creditId = await ctx.db.insert("demoCredits", { scope: args.scope, vendor: config.beneficiary.vendor, reference: args.reference, amountCents: args.amountCents, reservedCents: 0, consumedCents: 0, evidence: args.evidence, date: args.date, expenseAccount: args.expenseAccount, entryId: posted.entryId, createdAt: Date.now() });
    await auditDemo(ctx, args.scope, seat.seatId, "credit_accepted", { creditId });
    return { creditId };
  },
});

export const requestPayment = mutation({
  args: { ...agent, requestKey: v.string(), billIds: v.array(v.id("demoBills")), credits: v.array(v.object({ creditId: v.id("demoCredits"), amountCents: v.number() })) },
  handler: async (ctx, args) => {
    const { config } = await requireDemoSeat(ctx, args, ["payments"]);
    if (!args.requestKey.trim() || !args.billIds.length || new Set(args.billIds).size !== args.billIds.length || new Set(args.credits.map(c => c.creditId)).size !== args.credits.length) throw new Error("Distinct bills/credits and request key required");
    const existing = await ctx.db.query("demoVersions").withIndex("by_key", q => q.eq("scope.runId", args.scope.runId).eq("requestKey", args.requestKey)).unique();
    if (existing) {
      if (existing.requestedBy !== args.seatId || canonical(existing.snapshot.bills.map(b => b.billId)) !== canonical([...args.billIds].sort()) || canonical(existing.snapshot.credits) !== canonical([...args.credits].sort((a,b) => a.creditId.localeCompare(b.creditId)))) throw new Error("Payment idempotency conflict");
      return { versionId: existing._id, snapshotHash: existing.snapshotHash };
    }
    const bills = [];
    for (const id of [...args.billIds].sort()) {
      const bill = await ctx.db.get(id); assertRowScope(bill, args.scope);
      const b = bill as Doc<"demoBills">;
      if (b.status !== "approved" || b.flags.length || b.reservedVersionId || b.vendor !== config.beneficiary.vendor) throw new Error("Bill is not available for payment");
      const amountCents = b.approvedCents! - b.paidCents; dollars(amountCents);
      bills.push({ billId: id, version: b.version, amountCents });
    }
    const credits = [...args.credits].sort((a,b) => a.creditId.localeCompare(b.creditId));
    for (const item of credits) {
      dollars(item.amountCents);
      const credit = await ctx.db.get(item.creditId); assertRowScope(credit, args.scope);
      const c = credit as Doc<"demoCredits">;
      if (c.vendor !== config.beneficiary.vendor || c.amountCents - c.reservedCents - c.consumedCents < item.amountCents) throw new Error("Credit unavailable");
    }
    const amountCents = safeSum(bills.map(b => b.amountCents)) - safeSum(credits.map(c => c.amountCents)); dollars(amountCents);
    const snapshot = { scope: args.scope, bills, credits, amountCents, currency: "USD" as const, destination: { externalAccountId: config.beneficiary.externalAccountId, version: config.beneficiary.version }, policyVersion: config.policyVersion };
    const snapshotHash = await sha256Hex(canonical(snapshot));
    const versionId = await ctx.db.insert("demoVersions", { scope: args.scope, snapshot, snapshotHash, requestedBy: args.seatId, requestKey: args.requestKey, status: "awaiting_approval", approvals: [], reservations: "none", createdAt: Date.now() });
    return { versionId, snapshotHash };
  },
});

async function versionForApproval(ctx: MutationCtx, scope: Doc<"demoConfigs">["scope"], versionId: Id<"demoVersions">, hash: string) {
  const config = await getDemoConfig(ctx, scope);
  const version = await ctx.db.get(versionId); assertRowScope(version, scope);
  const p = version as Doc<"demoVersions">;
  if (p.status !== "awaiting_approval" || p.snapshotHash !== hash || await sha256Hex(canonical(p.snapshot)) !== hash) throw new Error("Stale payment approval");
  if (p.snapshot.policyVersion !== config.policyVersion || canonical(p.snapshot.destination) !== canonical({ externalAccountId: config.beneficiary.externalAccountId, version: config.beneficiary.version })) throw new Error("Stale policy or beneficiary");
  for (const item of p.snapshot.bills) {
    const b = await ctx.db.get(item.billId);
    if (!b || b.version !== item.version || b.flags.length || b.status !== "approved" || b.reservedVersionId || b.approvedCents! - b.paidCents !== item.amountCents) throw new Error("Stale bill or conflicting reservation");
  }
  for (const item of p.snapshot.credits) {
    const c = await ctx.db.get(item.creditId);
    if (!c || c.amountCents - c.reservedCents - c.consumedCents < item.amountCents) throw new Error("Concurrent credit allocation conflict");
  }
  return p;
}
export const approveWithinPolicy = mutation({
  args: { ...agent, versionId: v.id("demoVersions"), snapshotHash: v.string() },
  handler: async (ctx, args) => {
    const { config } = await requireDemoSeat(ctx, args, ["controller", "cfo_agent"]);
    const p = await versionForApproval(ctx, args.scope, args.versionId, args.snapshotHash);
    if (p.requestedBy === args.seatId || p.snapshot.amountCents > config.controllerLimitCents) throw new Error("Controller approval outside policy");
    if (!p.approvals.some(a => a.seatId === args.seatId)) await ctx.db.patch(p._id, { approvals: [...p.approvals, { seatId: args.seatId, subject: `agent:${args.seatId}`, kind: "controller", snapshotHash: args.snapshotHash, at: Date.now() }] });
    return { status: "awaiting_human_approval" as const };
  },
});

/** T2: authenticated human approval + reservation + immutable provider outbox are one mutation. */
export const approveAndQueue = mutation({
  args: { ...scoped, versionId: v.id("demoVersions"), snapshotHash: v.string() },
  handler: async (ctx, args) => {
    const { seat, subject } = await requireHuman(ctx, args.scope);
    const existing = await ctx.db.get(args.versionId); assertRowScope(existing, args.scope);
    const e = existing as Doc<"demoVersions">;
    if (e.status === "queued" && e.snapshotHash === args.snapshotHash && e.approvals.some(a => a.subject === subject && a.kind === "human")) return { commandId: (await ctx.db.query("demoCommands").withIndex("by_command", q => q.eq("scope.runId", args.scope.runId).eq("command.commandId", e._id)).unique())!._id };
    const p = await versionForApproval(ctx, args.scope, args.versionId, args.snapshotHash);
    if (p.requestedBy === seat.seatId) throw new Error("Requester cannot approve own payment");
    const request = { commandId: p._id, scope: args.scope, amountCents: p.snapshot.amountCents, currency: "USD" as const, destination: p.snapshot.destination, approvalVersion: p._id, idempotencyKey: `demo:${p._id}` };
    const savedRequest = args.scope.provider === "increase" ? { ...request, providerRequest: buildIncreaseRequestBody(request) } : request;
    const command: BankCommand = { ...savedRequest, requestHash: await commandRequestHash(savedRequest) };
    for (const item of p.snapshot.bills) await ctx.db.patch(item.billId, { reservedVersionId: p._id });
    for (const item of p.snapshot.credits) { const c = (await ctx.db.get(item.creditId))!; await ctx.db.patch(c._id, { reservedCents: c.reservedCents + item.amountCents }); }
    await ctx.db.patch(p._id, { status: "queued", reservations: "reserved", approvals: [...p.approvals, { seatId: seat.seatId, subject, kind: "human", snapshotHash: args.snapshotHash, at: Date.now() }] });
    const commandId = await ctx.db.insert("demoCommands", { scope: args.scope, command, versionId: p._id, execution: "queued", posting: "unposted", reconciliation: "unmatched", generation: 0, attemptCount: 0, nextAttemptAt: Date.now(), createdAt: Date.now() });
    await auditDemo(ctx, args.scope, seat.seatId, "payment_approved", { commandId, versionId: p._id, snapshotHash: p.snapshotHash });
    return { commandId };
  },
});
export const cancel = mutation({ args: { ...scoped, versionId: v.id("demoVersions") }, handler: async (ctx, args) => { const { seat } = await requireHuman(ctx, args.scope); const p = await ctx.db.get(args.versionId); assertRowScope(p, args.scope); await cancelUnsent(ctx, p as Doc<"demoVersions">); await auditDemo(ctx, args.scope, seat.seatId, "payment_cancelled", { versionId: args.versionId }); } });

const claimArgs = { ...service, commandId: v.id("demoCommands"), generation: v.number(), leaseToken: v.string() };
const LEASE_MS = 30_000;
const ATTEMPT_BUDGET = 8;
const TIME_BUDGET_MS = 24 * 60 * 60 * 1000;
async function ownedClaim(ctx: MutationCtx, args: {scope: Doc<"demoConfigs">["scope"];token:string;commandId:Id<"demoCommands">;generation:number;leaseToken:string}) {
  await requireService(ctx, args.scope, args.token, "dispatcher");
  const c = await ctx.db.get(args.commandId); assertRowScope(c, args.scope);
  const row = c as Doc<"demoCommands">;
  if (row.execution !== "in_flight" || row.generation !== args.generation || row.leaseToken !== args.leaseToken || (row.leaseExpiresAt ?? 0) <= Date.now()) throw new Error("Stale dispatcher lease");
  const attempt = await ctx.db.query("demoAttempts").withIndex("by_command", q => q.eq("commandId", row._id).eq("generation", row.generation)).unique();
  if (!attempt || attempt.completedAt) throw new Error("Attempt already completed");
  return { row, attempt };
}
/** Claim and persist attempt start before any external call. Convex serializes racing claimers. */
export const claim = mutation({
  args: { ...service, workerId: v.string(), leaseToken: v.string() },
  handler: async (ctx, args) => {
    await requireService(ctx, args.scope, args.token, "dispatcher");
    if (!args.workerId.trim() || args.leaseToken.length < 16) throw new Error("Unique worker lease token required");
    const now = Date.now();
    const rows = await ctx.db.query("demoCommands").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect();
    for (const row of rows.sort((a,b) => a.nextAttemptAt - b.nextAttemptAt)) {
      if (!(row.execution === "queued" || row.execution === "unknown" || (row.execution === "in_flight" && (row.leaseExpiresAt ?? 0) <= now)) || row.nextAttemptAt > now) continue;
      if ((row.budgetAttemptCount ?? row.attemptCount) >= ATTEMPT_BUDGET || ((row.budgetStartedAt ?? row.firstAttemptAt) !== undefined && now - (row.budgetStartedAt ?? row.firstAttemptAt)! >= TIME_BUDGET_MS)) {
        await ctx.db.patch(row._id, { execution: "exception", lastError: "Automatic recovery budget exhausted; bank outcome unresolved", leaseToken: undefined, leaseExpiresAt: undefined });
        continue;
      }
      if (row.leaseToken === args.leaseToken) throw new Error("Restart requires a fresh lease token");
      const version = await ctx.db.get(row.versionId);
      if (!version || version.reservations !== "reserved" || !version.approvals.some(a => a.kind === "human" && a.snapshotHash === version.snapshotHash) || await commandRequestHash(row.command) !== row.command.requestHash) throw new Error("Authorized immutable command invariant failed");
      const generation = row.generation + 1;
      await ctx.db.patch(row._id, { execution: "in_flight", generation, leaseToken: args.leaseToken, leaseExpiresAt: now + LEASE_MS, attemptCount: row.attemptCount + 1, budgetAttemptCount: (row.budgetAttemptCount ?? row.attemptCount) + 1, budgetStartedAt: row.budgetStartedAt ?? now, firstAttemptAt: row.firstAttemptAt ?? now });
      await ctx.db.insert("demoAttempts", { scope: args.scope, commandId: row._id, generation, leaseToken: args.leaseToken, workerId: args.workerId, startedAt: now });
      return { commandId: row._id, command: row.command, generation, leaseToken: args.leaseToken, providerTransferId: row.providerTransferId };
    }
    return null;
  },
});
export const heartbeat = mutation({ args: claimArgs, handler: async (ctx, args) => { const { row } = await ownedClaim(ctx, args); await ctx.db.patch(row._id, { leaseExpiresAt: Date.now() + LEASE_MS }); return { ok: true as const }; } });
export const complete = mutation({
  args: { ...claimArgs, providerTransferId: v.string() },
  handler: async (ctx, args) => {
    const { row, attempt } = await ownedClaim(ctx, args);
    if (!args.providerTransferId.trim() || (row.providerTransferId && row.providerTransferId !== args.providerTransferId)) throw new Error("Provider transfer identity conflict");
    const duplicate = await ctx.db.query("demoCommands").withIndex("by_transfer", q => q.eq("scope.runId", args.scope.runId).eq("providerTransferId", args.providerTransferId)).unique();
    if (duplicate && duplicate._id !== row._id) throw new Error("Provider transfer already belongs to another command");
    await ctx.db.patch(row._id, { execution: "pending", providerTransferId: args.providerTransferId, leaseToken: undefined, leaseExpiresAt: undefined, lastError: undefined });
    await ctx.db.patch(attempt._id, { completedAt: Date.now(), result: "provider_accepted" });
    return { ok: true as const };
  },
});
export const fail = mutation({
  args: { ...claimArgs, errorClass: v.string(), error: v.string(), retryAfterMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { row, attempt } = await ownedClaim(ctx, args);
    const classes = ["validation", "authentication", "configuration", "rate_limit", "transport", "unknown", "idempotency_conflict", "not_found"];
    if (!classes.includes(args.errorClass) || (args.retryAfterMs !== undefined && (!Number.isSafeInteger(args.retryAfterMs) || args.retryAfterMs < 0))) throw new Error("Invalid provider failure classification");
    const retryable = ["rate_limit", "transport", "unknown", "not_found"].includes(args.errorClass);
    const exhausted = (row.budgetAttemptCount ?? row.attemptCount) >= ATTEMPT_BUDGET || Date.now() - (row.budgetStartedAt ?? row.firstAttemptAt)! >= TIME_BUDGET_MS;
    // Deterministic persisted jitter: restarts cannot erase/recompute a chosen retry time.
    const jitter = (row.generation * 7919) % 1000;
    const backoff = Math.min(60_000, 500 * 2 ** (row.attemptCount - 1)) + jitter;
    const nextAttemptAt = Date.now() + Math.max(backoff, args.retryAfterMs ?? 0);
    const execution = retryable && !exhausted ? "unknown" as const : "exception" as const;
    await ctx.db.patch(row._id, { execution, lastError: `${args.errorClass}: ${args.error}`.slice(0, 2000), nextAttemptAt, leaseToken: undefined, leaseExpiresAt: undefined });
    await ctx.db.patch(attempt._id, { completedAt: Date.now(), result: execution, errorClass: args.errorClass });
    return { execution, nextAttemptAt };
  },
});
/** Human operator may resume original identity only; no release or key/provider replacement. */
export const resume = mutation({
  args: { ...scoped, commandId: v.id("demoCommands"), reason: v.string() },
  handler: async (ctx, args) => {
    const { seat } = await requireHuman(ctx, args.scope);
    const row = await ctx.db.get(args.commandId); assertRowScope(row, args.scope);
    const c = row as Doc<"demoCommands">;
    if (c.execution !== "exception" || !args.reason.trim()) throw new Error("A reason and exception command are required");
    await ctx.db.patch(c._id, { execution: c.providerTransferId ? "pending" : "unknown", nextAttemptAt: Date.now(), budgetAttemptCount: 0, budgetStartedAt: Date.now(), lastError: undefined });
    await auditDemo(ctx, args.scope, seat.seatId, "command_resumed", { commandId: c._id, reason: args.reason, originalRequestHash: c.command.requestHash, originalKey: c.command.idempotencyKey });
  },
});

/** Human review includes exact immutable amount, bills, credits and beneficiary reference. */
export const humanReview = query({
  args: scoped,
  handler: async (ctx, args) => {
    const { config, seat } = await requireHuman(ctx, args.scope);
    const [bills, credits, versions, commands] = await Promise.all([
      ctx.db.query("demoBills").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect(),
      ctx.db.query("demoCredits").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect(),
      ctx.db.query("demoVersions").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect(),
      ctx.db.query("demoCommands").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect(),
    ]);
    return { operator: { seatId: seat.seatId, name: seat.name }, beneficiary: config.beneficiary, policyVersion: config.policyVersion, bills, credits, versions, commands: commands.map(({ leaseToken: _, ...c }) => c) };
  },
});
export const view = query({
  args: agent,
  handler: async (ctx, args) => {
    const { seat } = await requireDemoSeat(ctx, args, ["ap_clerk", "payments", "controller", "cash_application", "treasury", "fpa", "integrations_engineer", "auditor", "cfo_agent"]);
    const bills = await ctx.db.query("demoBills").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect();
    const commands = await ctx.db.query("demoCommands").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect();
    const statuses = commands.map(c => ({ commandId: c._id, versionId: c.versionId, amountCents: c.command.amountCents, execution: c.execution, posting: c.posting, reconciliation: c.reconciliation, attemptCount: c.attemptCount, nextAttemptAt: c.nextAttemptAt, lastError: c.lastError }));
    if (seat.role === "ap_clerk") return { role: seat.role, bills };
    if (seat.role === "payments") return { role: seat.role, payments: statuses };
    if (seat.role === "integrations_engineer") return { role: seat.role, diagnostics: statuses.map(({ amountCents: _, ...s }) => s) };
    if (["treasury", "fpa", "cfo_agent"].includes(seat.role)) return { role: seat.role, outstandingCents: bills.reduce((n,b) => n + (b.approvedCents ?? 0) - b.paidCents, 0), pendingPaymentCents: commands.filter(c => !["settled", "returned", "cancelled", "rejected"].includes(c.execution)).reduce((n,c) => n + c.command.amountCents, 0) };
    if (seat.role === "cash_application") return { role: seat.role, payments: statuses };
    const versions = await ctx.db.query("demoVersions").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect();
    return { role: seat.role, bills, versions, payments: statuses };
  },
});
