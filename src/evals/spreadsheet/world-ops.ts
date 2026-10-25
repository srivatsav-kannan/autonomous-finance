// The shared input for both bookkeeping paths: a seeded world turned into one ordered
// stream of steps. "ingest" is the outside world arriving; "op" is a bookkeeping
// operation an agent issues. Both the kernel path and the spreadsheet path apply exactly
// this stream, so any difference in time, actions or caught errors comes from the
// substrate, not from different inputs.
import { LANDLORDS, VENDORS } from "../../../company/sweetgreen/profile";
import { parseMoney } from "../../core/money";
import { BUILTIN_PARSERS, parseWith } from "../../integrations/parsers";
import { generateWorld, type WorldEvent, type WorldOptions } from "../../world/generate";
import { addDays } from "../../world/rng";

export interface BillLine { sku?: string; description: string; quantity: number; unitCents: number; amountCents: number }
export interface EntryLine { account: string; debit: number; credit: number }

export const SEATS = {
  "ap_clerk-1": "ap_clerk",
  "lease_accountant-1": "lease_accountant",
  "controller-1": "controller",
  "cash_application-1": "cash_application",
  "revenue_accountant-1": "revenue_accountant",
  "payroll_accountant-1": "payroll_accountant",
} as const;
export type SeatId = keyof typeof SEATS;

export type Op =
  | {
    kind: "record_bill"; key: string; seat: SeatId; documentExternalId: string; vendor: string; invoiceNumber: string;
    invoiceDate: string; dueDate: string; store?: string; deliveryId?: string; lines: BillLine[]; totalCents: number;
    expenseAccount: string; decision: "approve" | "hold" | "reject"; exceptions: string[];
  }
  | { kind: "resolve_bill"; key: string; seat: SeatId; documentExternalId: string; decision: "approve" | "reject"; expenseAccount: string }
  | { kind: "post_entry"; key: string; seat: SeatId; date: string; memo: string; source: { kind: string; ref: string }; lines: EntryLine[] }
  | { kind: "match_bank"; key: string; seat: SeatId; txnId: string; date: string; memo: string; lines: EntryLine[] };
export type OpKind = Op["kind"];

export type Step = { kind: "ingest"; event: WorldEvent } | { kind: "op"; op: Op };

/** Bills above this are held for the controller; mirrors the kernel's default auto-approve policy. */
export const AUTO_APPROVE_CENTS = 5_000_00;

interface Extracted { invoiceNumber: string; store: string; deliveryId?: string; lines: BillLine[]; totalCents: number }

// The two built-in parsers cover columnar and key-value layouts. The benchmark also needs the
// narrative, pipe and lease layouts, which production reads with Claude or learned parsers.
// Parsing is done once, before timing, and feeds both paths identically.
function extractNarrative(text: string): Extracted | null {
  const head = /^(.+?): Invoice (\S+)$/m.exec(text);
  if (!head) return null;
  const lines = [...text.matchAll(/^ - (\d+(?:\.\d+)?) x (.+?) \((\S+)\) at (\$[\d,]+\.\d{2}) each \((\$[\d,]+\.\d{2})\)$/gm)].map((m) => ({
    sku: m[3]!, description: m[2]!, quantity: Number(m[1]), unitCents: parseMoney(m[4]!), amountCents: parseMoney(m[5]!),
  }));
  return {
    invoiceNumber: head[2]!,
    store: /location \(([a-z0-9-]+)\)/.exec(text)?.[1] ?? "",
    deliveryId: /delivery (DLV-\S+?),? dated/.exec(text)?.[1],
    lines,
    totalCents: parseMoney(/^Total: (\$[\d,]+\.\d{2})/m.exec(text)?.[1] ?? "0"),
  };
}

function extractPipe(text: string): Extracted | null {
  const head = /^H\|[^|]*\|([^|]+)\|\d{8}\|\d{8}\|([^|]*)\|([^|]*)$/m.exec(text);
  const total = /^T\|(\d+)\|/m.exec(text);
  if (!head || !total) return null;
  const lines = [...text.matchAll(/^L\|([^|]+)\|(\d+(?:\.\d+)?)\|(\d+)\|(\d+)\|(.*)$/gm)].map((m) => ({
    sku: m[1]!, quantity: Number(m[2]), unitCents: Number(m[3]), amountCents: Number(m[4]), description: m[5]!,
  }));
  return { invoiceNumber: head[1]!, store: head[2]!, deliveryId: head[3] || undefined, lines, totalCents: Number(total[1]) };
}

function extractLease(text: string): Extracted | null {
  const head = /Rent Statement (\S+)/.exec(text);
  const base = /^Base rent: (\$[\d,]+\.\d{2})$/m.exec(text);
  const cam = /^Common area maintenance \(CAM\): (\$[\d,]+\.\d{2})$/m.exec(text);
  const total = /^Total due: (\$[\d,]+\.\d{2})$/m.exec(text);
  if (!head || !base || !cam || !total) return null;
  const line = (description: string, cents: number) => ({ description, quantity: 1, unitCents: cents, amountCents: cents });
  return {
    invoiceNumber: head[1]!, store: /\(([a-z0-9-]+)\)/.exec(text)?.[1] ?? "",
    lines: [line("Base rent", parseMoney(base[1]!)), line("CAM", parseMoney(cam[1]!))], totalCents: parseMoney(total[1]!),
  };
}

function extract(kind: string, text: string): Extracted {
  let out: Extracted | null = null;
  if (kind === "lease_invoice") out = extractLease(text);
  else {
    const parsed = parseWith(BUILTIN_PARSERS, text);
    out = parsed.ok
      ? { invoiceNumber: parsed.invoice.invoiceNumber, store: parsed.invoice.storeId, deliveryId: parsed.invoice.deliveryId ?? undefined, lines: parsed.invoice.lines, totalCents: parsed.invoice.totalCents }
      : extractNarrative(text) ?? extractPipe(text);
  }
  if (!out || !out.lines.length) throw new Error(`benchmark could not extract invoice:\n${text.slice(0, 200)}`);
  const sum = out.lines.reduce((s, l) => s + l.amountCents, 0);
  if (sum !== out.totalCents || out.lines.some((l) => Math.round(l.quantity * l.unitCents) !== l.amountCents)) {
    throw new Error(`benchmark extraction failed line math for ${out.invoiceNumber}`);
  }
  return out;
}

const omitUndefined = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** Build the world and the deterministic bookkeeping stream for it. */
export function buildStream(options: WorldOptions) {
  const world = generateWorld(options);
  const duplicates = new Map((world.truth.accounting?.duplicateDocuments ?? []).map((d) => [d.documentExternalId, d.originalDocumentExternalId]));
  const byExternal = new Map(world.events.map((e) => [e.externalId, e]));
  const terminated = new Map<string, string>(); // employeeId -> effective date
  const steps: Step[] = [];
  const op = (o: Op) => steps.push({ kind: "op", op: omitUndefined(o) });

  for (const e of world.events) {
    steps.push({ kind: "ingest", event: e });
    const p = e.payload as Record<string, any>;
    switch (e.type) {
      case "document.received": {
        if (p.kind !== "invoice" && p.kind !== "lease_invoice") break;
        const isLease = p.kind === "lease_invoice";
        const vendor = isLease ? LANDLORDS.find((l) => l.contact.email === p.from) : VENDORS.find((v) => v.contact.email === p.from);
        if (!vendor) throw new Error(`unknown sender ${p.from}`);
        const x = extract(p.kind, p.text);
        const expenseAccount = isLease ? "5200" : (vendor as (typeof VENDORS)[number]).expenseAccount;
        const terms = isLease ? 5 : (vendor as (typeof VENDORS)[number]).termsNetDays;
        const original = duplicates.get(e.externalId);
        const hold = isLease || x.totalCents > AUTO_APPROVE_CENTS;
        const decision = original ? "reject" : hold ? "hold" : "approve";
        op({
          kind: "record_bill", key: `bill:${e.externalId}`, seat: isLease ? "lease_accountant-1" : "ap_clerk-1",
          documentExternalId: e.externalId, vendor: vendor.id, invoiceNumber: x.invoiceNumber, invoiceDate: e.occurredOn,
          dueDate: addDays(e.occurredOn, terms), store: x.store || undefined, deliveryId: x.deliveryId, lines: x.lines,
          totalCents: x.totalCents, expenseAccount, decision, exceptions: original ? [`duplicate_invoice: resend of ${original}`] : [],
        });
        if (decision === "hold") {
          op({ kind: "resolve_bill", key: `resolve:${e.externalId}`, seat: "controller-1", documentExternalId: e.externalId, decision: "approve", expenseAccount });
        }
        break;
      }
      case "hr.roster_change":
        if (p.change === "terminated") terminated.set(p.employeeId, p.effective);
        break;
      case "sales.daily": {
        const marketplace = Object.values(p.marketplace as Record<string, number>).reduce((a, b) => a + b, 0);
        const collections = p.in_store.grossCents + p.digital.grossCents + p.salesTaxCents - p.giftCardsRedeemedCents + p.giftCardsSoldCents;
        const lines = [
          { account: "1100", debit: collections, credit: 0 },
          { account: "2200", debit: p.giftCardsRedeemedCents, credit: 0 },
          { account: "1110", debit: marketplace, credit: 0 },
          { account: "4000", debit: 0, credit: p.in_store.grossCents },
          { account: "4010", debit: 0, credit: p.digital.grossCents },
          { account: "4020", debit: 0, credit: marketplace },
          { account: "2300", debit: 0, credit: p.salesTaxCents },
          { account: "2200", debit: 0, credit: p.giftCardsSoldCents },
        ].filter((l) => l.debit > 0 || l.credit > 0);
        op({ kind: "post_entry", key: `revenue:${e.externalId}`, seat: "revenue_accountant-1", date: p.date, memo: `Daily sales ${p.store} ${p.date}`, source: { kind: "revenue_daily", ref: e.externalId }, lines });
        break;
      }
      case "payroll.register": {
        const legit = (p.employees as { id: string; grossCents: number }[])
          .filter((x) => !(terminated.has(x.id) && terminated.get(x.id)! < p.payDate))
          .reduce((s, x) => s + x.grossCents, 0);
        op({
          kind: "post_entry", key: `payroll:${p.registerId}`, seat: "payroll_accountant-1", date: p.payDate, memo: `Payroll ${p.store} ${p.period}`,
          source: { kind: "payroll", ref: p.registerId }, lines: [{ account: "5100", debit: legit, credit: 0 }, { account: "2100", debit: 0, credit: legit }],
        });
        break;
      }
      case "bank.transaction": {
        let lines: EntryLine[];
        if (p.detail) {
          // Card settlement: deposit net of processor fee clears the card receivable.
          lines = [
            { account: "1020", debit: p.amountCents, credit: 0 },
            { account: "5400", debit: p.detail.feeCents, credit: 0 },
            { account: "1100", debit: 0, credit: p.detail.grossCents },
          ];
        } else if (String(p.txnId).startsWith("dep-payout-")) {
          const report = byExternal.get(String(p.txnId).slice("dep-".length))?.payload as { lines: { grossCents: number }[] } | undefined;
          if (!report) throw new Error(`payout report missing for ${p.txnId}`);
          const gross = report.lines.reduce((s, l) => s + l.grossCents, 0);
          lines = [
            { account: "1020", debit: p.amountCents, credit: 0 },
            { account: "5410", debit: gross - p.amountCents, credit: 0 },
            { account: "1110", debit: 0, credit: gross },
          ];
        } else if (p.amountCents < 0) {
          // Unidentified operating debit: park in suspense.
          lines = [{ account: "6900", debit: -p.amountCents, credit: 0 }, { account: "1000", debit: 0, credit: -p.amountCents }];
        } else {
          throw new Error(`unhandled bank transaction ${p.txnId}`);
        }
        op({ kind: "match_bank", key: `bank:${p.txnId}`, seat: "cash_application-1", txnId: p.txnId, date: p.date, memo: p.description, lines: lines.filter((l) => l.debit > 0 || l.credit > 0) });
        break;
      }
    }
  }
  return { world, steps };
}

export function opCounts(steps: Step[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of steps) {
    const k = s.kind === "op" ? s.op.kind : `ingest:${s.event.type}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
