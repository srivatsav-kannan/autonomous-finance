import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { assertRowScope } from "../demoAuth";

/** Request, reservation ownership and approval work commit in one mutation. */
export async function reserveObligations(ctx: MutationCtx, versionId: Id<"demoVersions">) {
  const version = await ctx.db.get(versionId);
  if (!version || version.reservations !== "none") throw new Error("New payment reservation required");
  for (const item of version.snapshot.bills) {
    const bill = await ctx.db.get(item.billId); assertRowScope(bill, version.scope);
    if (!bill || bill.reservedVersionId || bill.version !== item.version || bill.flags.length || bill.status !== "approved" || !Number.isSafeInteger(item.amountCents) || item.amountCents <= 0 || !Number.isSafeInteger(bill.approvedCents) || !Number.isSafeInteger(bill.paidCents) || bill.paidCents < 0 || bill.approvedCents! - bill.paidCents < item.amountCents) throw new Error("Stale bill or conflicting reservation");
    await ctx.db.patch(item.billId, { reservedVersionId: versionId });
  }
  for (const item of version.snapshot.credits) {
    const credit = await ctx.db.get(item.creditId); assertRowScope(credit, version.scope);
    if (!credit || credit.amountCents - credit.reservedCents - credit.consumedCents < item.amountCents) throw new Error("Concurrent credit allocation conflict");
    await ctx.db.patch(item.creditId, { reservedCents: credit.reservedCents + item.amountCents });
  }
  await ctx.db.patch(versionId, { reservations: "reserved" });
}

/** Release only on never-started cancellation or verified permanent bank rejection. */
export async function releaseReservations(ctx: MutationCtx, versionId: Id<"demoVersions">) {
  const version = await ctx.db.get(versionId);
  if (!version) throw new Error("Missing payment version");
  if (version.reservations !== "reserved") return;
  for (const item of version.snapshot.bills) {
    const bill = await ctx.db.get(item.billId);
    if (!bill || bill.reservedVersionId !== versionId) throw new Error("Bill reservation ownership mismatch");
    await ctx.db.patch(bill._id, { reservedVersionId: undefined });
  }
  for (const item of version.snapshot.credits) {
    const credit = await ctx.db.get(item.creditId);
    if (!credit || credit.reservedCents < item.amountCents) throw new Error("Credit reservation mismatch");
    await ctx.db.patch(credit._id, { reservedCents: credit.reservedCents - item.amountCents });
  }
  await ctx.db.patch(versionId, { reservations: "released" });
}
/** Call in the same transaction as the verified original debit journal and marker. */
export async function settleEffects(ctx: MutationCtx, versionId: Id<"demoVersions">) {
  const version = await ctx.db.get(versionId);
  if (!version) throw new Error("Missing payment version");
  if (version.reservations === "consumed") return;
  if (version.reservations !== "reserved") throw new Error("Settlement requires reserved obligations");
  for (const item of version.snapshot.bills) {
    const bill = await ctx.db.get(item.billId);
    if (!bill || bill.reservedVersionId !== versionId) throw new Error("Bill reservation ownership mismatch");
    const paidCents = bill.paidCents + item.amountCents;
    if (paidCents > (bill.approvedCents ?? 0)) throw new Error("Settlement exceeds bill");
    await ctx.db.patch(bill._id, { paidCents, status: paidCents === bill.approvedCents ? "paid" : "approved", reservedVersionId: undefined });
  }
  for (const item of version.snapshot.credits) {
    const credit = await ctx.db.get(item.creditId);
    if (!credit || credit.reservedCents < item.amountCents) throw new Error("Credit reservation mismatch");
    await ctx.db.patch(credit._id, { reservedCents: credit.reservedCents - item.amountCents, consumedCents: credit.consumedCents + item.amountCents });
  }
  await ctx.db.patch(versionId, { reservations: "consumed", status: "settled" });
}
/** Reopen only the returned CASH principal. Applied credits remain consumed. */
export async function returnEffects(ctx: MutationCtx, versionId: Id<"demoVersions">) {
  const version = await ctx.db.get(versionId);
  if (!version || version.reservations !== "consumed") throw new Error("Return requires original settlement");
  if (version.status === "returned") return;
  let remainingCredits = version.snapshot.credits.reduce((n, c) => n + c.amountCents, 0);
  for (const item of version.snapshot.bills) {
    const bill = await ctx.db.get(item.billId);
    if (!bill) throw new Error("Missing bill");
    const appliedCredit = Math.min(remainingCredits, item.amountCents);
    remainingCredits -= appliedCredit;
    const returnedCents = item.amountCents - appliedCredit;
    if (bill.paidCents < returnedCents) throw new Error("Return exceeds previously applied cash");
    await ctx.db.patch(bill._id, { paidCents: bill.paidCents - returnedCents, status: returnedCents > 0 ? "approved" : bill.status });
  }
  await ctx.db.patch(versionId, { status: "returned" });
}
