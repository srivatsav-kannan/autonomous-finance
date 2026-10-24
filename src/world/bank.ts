import fs from "node:fs";
import path from "node:path";
import { runDir } from "./scenario";
import { addDays } from "./rng";

export interface OutgoingPayment {
  bankRef: string;
  intentId: string;
  payee: string;
  amountCents: number;
  bank: string;
  accountLast4: string;
  sentOn: string;
}

/**
 * The simulated bank. Agents send payments through it; the next day the payment shows up
 * as a debit on the operating account's feed, which cash application must reconcile.
 * Idempotent: sending the same intent twice returns the original bank reference.
 * (A Capital One Nessie adapter can replace this; same interface.)
 */
export class WorldBank {
  private file: string;
  constructor(runId: string) {
    this.file = path.join(runDir(runId), "bank-outbox.json");
  }

  private load(): OutgoingPayment[] {
    return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : [];
  }

  send(p: Omit<OutgoingPayment, "bankRef">): OutgoingPayment {
    const all = this.load();
    const existing = all.find((x) => x.intentId === p.intentId);
    if (existing) return existing;
    const sent = { ...p, bankRef: `ACH-${p.sentOn.replaceAll("-", "")}-${String(all.length + 1).padStart(4, "0")}` };
    all.push(sent);
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2));
    return sent;
  }

  /** Debits that should appear on the feed on `date` (payments sent the day before). */
  debitsFor(date: string): OutgoingPayment[] {
    return this.load().filter((p) => addDays(p.sentOn, 1) === date);
  }

  all(): OutgoingPayment[] {
    return this.load();
  }
}
