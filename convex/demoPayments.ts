import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { scopeValidator, provenanceValidator, providerCheckValidator } from "./demoSchema";
import { accountingSeat, assertRowScope, auditDemo, requireDemoSeat, requireHuman, requirePaymentSeat, requirePaymentHuman } from "./lib/demoAuth";
import { canonical, getRun, requireAdmin, sha256Hex } from "./lib/kernel";
import { appendDemoEntry, validDemoDate } from "./lib/demoPost";
import { normalizeInvoiceNumber } from "./lib/invoiceIdentity";

import { PAYMENT_EXECUTOR_VERSION } from "../src/payments/contracts";
import { assertPaymentExecutor } from "../src/payments/domain/rules";

import { cancelUnsent, requestPaymentCommand, approveWithinPolicyCommand, approveAndQueueCommand, resumePayment, releaseUnsentPayment } from "./lib/payments/applyCommand";

import { claimEffect, completeEffect, failEffect, heartbeatEffect } from "./lib/payments/applyEffect";

const scoped = { scope: scopeValidator };
const agent = { ...scoped, seatId: v.string(), token: v.string() };
const service = { ...scoped, token: v.string(), paymentExecutorVersion: v.optional(v.string()) };
const validDate = validDemoDate;
const dollars = (n: number) => { if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Amount must be positive integer USD cents"); };

/** Trusted setup activates an immutable account, beneficiary, policy and human identity binding. */
export const configure = mutation({
  args: { ...scoped, secret: v.string(), paymentExecutorVersion: v.optional(v.string()), provenance: v.optional(provenanceValidator), beneficiary: v.object({ vendor: v.string(), externalAccountId: v.string(), version: v.string() }), policyVersion: v.string(), controllerLimitCents: v.number(), humanSubjects: v.array(v.object({ subject: v.string(), seatId: v.string() })),
    // Set for a reused bank account: unlinked activity created before it is prior history, not this run's cash.
    activitySince: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const denied = requireAdmin(args.secret); if (denied) throw new Error(denied.error);
    if (args.activitySince !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(args.activitySince) || !Number.isFinite(Date.parse(args.activitySince)))) throw new Error("activitySince must be an ISO UTC timestamp");
    if (args.paymentExecutorVersion !== undefined) assertPaymentExecutor(args.paymentExecutorVersion);
    if (args.provenance && (!args.provenance.decisionPath.trim() || !args.provenance.knowledgeCommit.trim())) throw new Error("Execution provenance must name the reviewed decision and commit");
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
    for (const table of ["demoBills", "demoCredits", "demoVersions", "demoCommands", "demoAttempts", "demoTransactions", "demoObservations", "demoInbox", "demoCursors"] as const) {
      const old = await ctx.db.query(table).filter(q => q.eq(q.field("scope.runId"), args.scope.runId)).first();
      if (old) throw new Error("Demo activation requires a fresh run without historical financial rows");
    }
    for (const binding of args.humanSubjects) {
      const seat = await ctx.db.query("seats").withIndex("by_run_seat", q => q.eq("runId", args.scope.runId).eq("seatId", binding.seatId)).unique();
      if (!seat || seat.kind !== "human" || seat.role !== "human_cfo" || !binding.subject.includes("|")) throw new Error("Bind issuer|subject to an existing human CFO");
    }
    const { secret: _, ...config } = args;
    await ctx.db.insert("demoConfigs", { ...config, paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, createdAt: Date.now() });
    return { ok: true as const };
  },
});

export const recordBill = mutation({
  args: { ...agent, vendor: v.string(), invoiceNumber: v.string(), invoiceDate: v.string(), originalCents: v.number(), expenseAccount: v.string(), evidence: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { config } = await requirePaymentSeat(ctx, args, ["ap_clerk"]);
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
    await requirePaymentSeat(ctx, args, ["ap_clerk"]);
    const bill = await ctx.db.get(args.billId); assertRowScope(bill, args.scope);
    if (!args.evidence.trim()) throw new Error("Evidence reference required");
    await ctx.db.patch(args.billId, { evidence: [...new Set([...(bill as Doc<"demoBills">).evidence, args.evidence])] });
  },
});

export const flagException = mutation({
  args: { ...agent, billId: v.id("demoBills"), reason: v.string() },
  handler: async (ctx, args) => {
    await requirePaymentSeat(ctx, args, ["ap_clerk"]);
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
      ? (await requirePaymentSeat(ctx, { scope: args.scope, seatId: args.seatId ?? "", token: args.token ?? "" }, ["controller"])).seat
      : (await requirePaymentHuman(ctx, args.scope)).seat;
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
export const acceptBill = mutation({ args: { ...agent, billId: v.id("demoBills"), approvedCents: v.number() }, handler: async (ctx, args) => { const { config } = await requirePaymentSeat(ctx, args, ["controller"]); return accept(ctx, args, args.seatId, config.controllerLimitCents); } });
export const humanAcceptBill = mutation({ args: { ...scoped, billId: v.id("demoBills"), approvedCents: v.number() }, handler: async (ctx, args) => { const { seat } = await requirePaymentHuman(ctx, args.scope); return accept(ctx, args, seat.seatId, Number.MAX_SAFE_INTEGER); } });

export const recordCredit = mutation({
  args: { ...scoped, reference: v.string(), amountCents: v.number(), evidence: v.string(), date: v.string(), expenseAccount: v.string() },
  handler: async (ctx, args) => {
    const { config, seat } = await requirePaymentHuman(ctx, args.scope);
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
  handler: requestPaymentCommand,
});

export const approveWithinPolicy = mutation({
  args: { ...agent, versionId: v.id("demoVersions"), snapshotHash: v.string() },
  handler: approveWithinPolicyCommand,
});

/** Authenticated human approval retains request reservations and atomically inserts the outbox. */
export const approveAndQueue = mutation({
  args: { ...scoped, versionId: v.id("demoVersions"), snapshotHash: v.string() },
  handler: approveAndQueueCommand,
});
export const cancel = mutation({ args: { ...scoped, versionId: v.id("demoVersions") }, handler: async (ctx, args) => { const { seat } = await requirePaymentHuman(ctx, args.scope); const p = await ctx.db.get(args.versionId); assertRowScope(p, args.scope); await cancelUnsent(ctx, p as Doc<"demoVersions">); await auditDemo(ctx, args.scope, seat.seatId, "payment_cancelled", { versionId: args.versionId }); } });

const claimArgs = { ...service, commandId: v.id("demoCommands"), generation: v.number(), leaseToken: v.string() };
/** Claim and persist attempt start before any external call. Convex serializes racing claimers. */
export const claim = mutation({
  args: { ...service, workerId: v.string(), leaseToken: v.string() },
  handler: claimEffect,
});
export const heartbeat = mutation({ args: claimArgs, handler: heartbeatEffect });
export const complete = mutation({
  args: { ...claimArgs, providerTransferId: v.string() },
  handler: completeEffect,
});
export const fail = mutation({
  args: { ...claimArgs, errorClass: v.string(), error: v.string(), retryAfterMs: v.optional(v.number()) },
  handler: failEffect,
});
/** Human operator may resume original identity only; no release or key/provider replacement. */
export const resume = mutation({
  args: { ...scoped, commandId: v.id("demoCommands"), reason: v.string() },
  handler: resumePayment,
});
/** Human operator releases a claimed-but-never-sent command after the safety window and a
 * fresh provider check. A transfer that appears later is flagged and never posted. */
export const releaseUnsent = mutation({
  args: { ...scoped, commandId: v.id("demoCommands"), reason: v.string(), providerCheck: providerCheckValidator },
  handler: releaseUnsentPayment,
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
    const executionEligible = config.paymentExecutorVersion === PAYMENT_EXECUTOR_VERSION;
    return {
      operator: { seatId: seat.seatId, name: seat.name }, beneficiary: config.beneficiary, policyVersion: config.policyVersion,
      executionConfig: {
        paymentExecutorVersion: config.paymentExecutorVersion ?? null, provenance: config.provenance ?? null,
        eligible: executionEligible, reason: executionEligible ? null : "Historical executor metadata requires review; automatic dispatch is disabled",
      },
      bills, credits, versions, commands: commands.map(({ leaseToken: _, ...c }) => c),
    };
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
