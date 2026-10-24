import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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

type PaymentRequest = Omit<OutgoingPayment, "bankRef">;
const REQUEST_FIELDS = ["intentId", "payee", "amountCents", "bank", "accountLast4", "sentOn"] as const;
const receiptKey = (intentId: string) => createHash("sha256").update(intentId).digest("hex");

function checkReplay(receipt: OutgoingPayment, request: PaymentRequest): OutgoingPayment {
  if (REQUEST_FIELDS.some((field) => receipt[field] !== request[field])) {
    throw new Error(`WorldBank idempotency conflict for intent ${request.intentId}`);
  }
  return receipt;
}

function readReceipt(value: unknown, source: string): OutgoingPayment {
  const p = value as Partial<OutgoingPayment> | null;
  if (!p || typeof p !== "object" || !Number.isSafeInteger(p.amountCents) ||
    ["bankRef", "intentId", "payee", "bank", "accountLast4", "sentOn"].some((field) => typeof p[field as keyof OutgoingPayment] !== "string")) {
    throw new Error(`Invalid WorldBank receipt in ${source}`);
  }
  return p as OutgoingPayment;
}

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Simulated bank with immutable, per-intent receipts. A completed temp file is fsynced
 * before link() publishes it without overwriting another process's receipt. A crash
 * before publication leaves an ignored temp; a crash afterward is recovered by get/send.
 * Legacy bank-outbox.json remains read-only and is included in every lookup.
 *
 * This protocol requires one local POSIX filesystem with atomic hard links and directory
 * fsync. Do not run old bank-outbox.json writers concurrently; this is not a real bank API
 * or a distributed/network-filesystem payment service.
 */
export class WorldBank {
  private file: string;
  private directory: string;

  constructor(runId: string) {
    this.file = path.join(runDir(runId), "bank-outbox.json");
    this.directory = path.join(runDir(runId), "bank-outbox");
  }

  private legacy(): OutgoingPayment[] {
    if (!fs.existsSync(this.file)) return [];
    const data: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!Array.isArray(data)) throw new Error(`Invalid WorldBank outbox in ${this.file}`);
    return data.map((p) => readReceipt(p, this.file));
  }

  private receiptFile(intentId: string): string {
    return path.join(this.directory, `${receiptKey(intentId)}.json`);
  }

  private stored(file: string): OutgoingPayment {
    const receipt = readReceipt(JSON.parse(fs.readFileSync(file, "utf8")), file);
    if (path.basename(file) !== `${receiptKey(receipt.intentId)}.json`) {
      throw new Error(`WorldBank receipt does not match its intent key: ${file}`);
    }
    return receipt;
  }

  private merge(receipts: OutgoingPayment[]): OutgoingPayment[] {
    const byIntent = new Map<string, OutgoingPayment>();
    for (const receipt of receipts) {
      const prior = byIntent.get(receipt.intentId);
      if (prior) {
        checkReplay(prior, receipt);
        if (prior.bankRef !== receipt.bankRef) throw new Error(`Conflicting WorldBank receipts for intent ${receipt.intentId}`);
      } else {
        byIntent.set(receipt.intentId, receipt);
      }
    }
    return [...byIntent.values()];
  }

  /** Look up an accepted transfer, including legacy outbox receipts. */
  get(intentId: string): OutgoingPayment | undefined {
    const file = this.receiptFile(intentId);
    const receipts = this.legacy().filter((p) => p.intentId === intentId);
    if (fs.existsSync(file)) {
      receipts.push(this.stored(file));
      // A concurrent sender may have linked the receipt and died before its directory sync.
      syncDirectory(this.directory);
    }
    return this.merge(receipts)[0];
  }

  send(p: PaymentRequest): OutgoingPayment {
    const existing = this.get(p.intentId);
    if (existing) return checkReplay(existing, p);

    fs.mkdirSync(this.directory, { recursive: true });
    syncDirectory(path.dirname(this.directory));
    const key = receiptKey(p.intentId);
    // Unlike a row count, the intent digest remains unique across concurrent senders.
    const sent: OutgoingPayment = { ...p, bankRef: `ACH-${p.sentOn.replaceAll("-", "")}-${key}` };
    readReceipt(sent, "payment request");
    const temporary = path.join(this.directory, `.${key}-${randomUUID()}.tmp`);
    const destination = this.receiptFile(p.intentId);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      try {
        fs.writeFileSync(fd, JSON.stringify(sent, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.linkSync(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const winner = checkReplay(this.stored(destination), p);
        syncDirectory(this.directory);
        return winner;
      }
      syncDirectory(this.directory);
      return sent;
    } finally {
      // Killed processes can leave .tmp files; readers deliberately ignore them.
      fs.unlinkSync(temporary);
    }
  }

  /** Debits that should appear on the feed on `date` (payments sent the day before). */
  debitsFor(date: string): OutgoingPayment[] {
    return this.all().filter((p) => addDays(p.sentOn, 1) === date);
  }

  all(): OutgoingPayment[] {
    const receipts = this.legacy();
    if (fs.existsSync(this.directory)) {
      for (const name of fs.readdirSync(this.directory).sort()) {
        if (name.endsWith(".json")) receipts.push(this.stored(path.join(this.directory, name)));
      }
    }
    return this.merge(receipts);
  }
}
