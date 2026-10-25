// Score the books either path ended with against the world's private answer key. Books use
// evaluateBooks from src/evals/books.ts, the same independent oracle src/evals/score.ts
// uses (scoreRun itself reads a live Convex deployment, which this harness does not use).
import { normalizeInvoiceNumber } from "../../../convex/lib/invoiceIdentity";
import { evaluateBooks, type BooksStatus } from "../books";
import type { generateWorld } from "../../world/generate";
import type { Flag } from "./agent-tools";
import type { KernelBooks } from "./kernel-books";
import type { SheetTools } from "./workbook";

type World = ReturnType<typeof generateWorld>;

export interface BooksState {
  bills: { _id: string; documentEventId: string; vendor: string; invoiceNumber: string; totalCents: number; status: string; entryId?: string; exceptions: string[]; lineTotalCents: number }[];
  trialBalance: { code: string; net: number }[];
  flags: Flag[];
  refusals: number;
}

export async function kernelState(k: KernelBooks, flags: Flag[]): Promise<BooksState> {
  const externalOf = new Map([...k.eventIds].map(([ext, id]) => [id, ext]));
  return {
    bills: k.h.all("bills").map((b) => ({
      _id: b._id, documentEventId: externalOf.get(b.documentEventId ?? "") ?? String(b.documentEventId), vendor: b.vendor, invoiceNumber: b.invoiceNumber,
      totalCents: b.totalCents, status: b.status, entryId: b.entryId ?? undefined, exceptions: b.exceptions, lineTotalCents: b.lines.reduce((s, l) => s + l.amountCents, 0),
    })),
    trialBalance: (await k.trialBalance()).map((a) => ({ code: a.code, net: a.net })),
    flags,
    refusals: k.h.all("violations").length,
  };
}

export function sheetState(t: SheetTools): BooksState {
  return {
    bills: t.rows("AP").map((r) => ({
      _id: String(r[0]), documentEventId: String(r[10] ?? ""), vendor: String(r[1] ?? ""), invoiceNumber: normalizeInvoiceNumber(String(r[2] ?? "")),
      totalCents: Number(r[7]), status: String(r[8] ?? ""), entryId: r[13] ? String(r[13]) : undefined,
      exceptions: String(r[9] ?? "").split(";").map((s) => s.trim()).filter(Boolean), lineTotalCents: Number(r[7]),
    })),
    trialBalance: t.rows("TB").filter((r) => r[0] !== "TOTAL" && Number(r[4]) !== 0).map((r) => ({ code: String(r[0]), net: Number(r[4]) })),
    flags: t.rows("Exceptions").map((r) => ({ ref: String(r[0] ?? ""), reason: String(r[1] ?? "") })),
    refusals: 0,
  };
}

export interface SliceScore {
  booksStatus: BooksStatus["status"];
  booksDiffs: number;
  booksReasons: string[];
  trialBalanceNetsToZero: boolean;
  invoiceDocuments: number;
  billsRecorded: number;
  errors: { id: string; type: string; caught: boolean; how: string }[];
  caught: number;
  planted: number;
  decoysFlagged: number;
  refusals: number;
}

export function scoreSlice(world: World, s: BooksState): SliceScore {
  const documents = world.events.filter((e) => e.type === "document.received").map((e) => ({ _id: e.externalId, externalId: e.externalId, payload: e.payload }));
  const books = evaluateBooks({
    truth: world.truth, bills: s.bills, intents: [], documents, trialBalance: s.trialBalance, blockedDocuments: new Set(), outgoingPayments: [],
  });
  const flagged = (ref: string) => s.flags.some((f) => f.ref.includes(ref) || f.reason.includes(ref));
  const billsFor = (vendor: string | undefined, ref: string) => s.bills.filter((b) => (!vendor || b.vendor === vendor) && normalizeInvoiceNumber(b.invoiceNumber) === normalizeInvoiceNumber(ref));
  const errors = world.answerKey.errors.map((e) => {
    const bs = billsFor(e.subject.vendor, e.subject.ref);
    let caught = false, how = "";
    switch (e.type) {
      case "duplicate_exact": case "duplicate_lookalike": {
        const dup = s.bills.filter((b) => b.documentEventId === e.subject.documentExternalId);
        const booked = dup.some((b) => b.status === "approved" || b.status === "paid");
        caught = !booked && (dup.some((b) => b.status === "rejected") || flagged(e.subject.ref) || (s.refusals > 0 && dup.length === 0));
        how = booked ? "duplicate booked" : caught ? "rejected or flagged" : "not handled";
        break;
      }
      case "price_over_contract": case "short_shipment": case "cam_over_cap": case "unapplied_credit": {
        const b = bs[0];
        // As in score.ts: the bill must name this exception and be held, rejected or short-paid.
        caught = Boolean(b && b.exceptions.some((x) => x.startsWith(e.type)) && (b.status === "held" || b.status === "rejected" || b.totalCents < b.lineTotalCents)) || flagged(e.subject.ref);
        how = b ? `bill ${b.status}${b.exceptions.length ? ` (${b.exceptions.join("; ")})` : ""}` : flagged(e.subject.ref) ? "flagged, no bill" : "no bill";
        break;
      }
      default:
        // Bank lines, payouts, payroll and remit requests are caught only by a flag citing their id.
        caught = flagged(e.subject.ref);
        how = caught ? "flagged" : "not flagged";
    }
    return { id: e.id, type: e.type, caught, how };
  });
  const invoiceDocuments = documents.filter((d) => ["invoice", "lease_invoice"].includes((d.payload as { kind?: string }).kind ?? "")).length;
  return {
    booksStatus: books.booksStatus.status,
    booksDiffs: books.books.filter((b) => b.diff !== 0).length,
    booksReasons: books.booksStatus.reasons.slice(0, 12),
    trialBalanceNetsToZero: s.trialBalance.reduce((a, b) => a + b.net, 0) === 0,
    invoiceDocuments,
    billsRecorded: s.bills.length,
    errors,
    caught: errors.filter((e) => e.caught).length,
    planted: errors.length,
    decoysFlagged: world.answerKey.decoys.filter((d) => flagged(d.subject.ref)).length,
    refusals: s.refusals,
  };
}
