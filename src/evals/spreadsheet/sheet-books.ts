// The spreadsheet procedure for each bookkeeping operation: the sequence of tool calls a
// careful agent issues when the only interface is read_range / write_range / find_rows /
// recalc. Each procedure looks up what it needs, writes the rows, recalculates and saves,
// then reads the Checks sheet back to see whether it broke the books.
import type { WorldEvent } from "../../world/generate";
import type { Op } from "./world-ops";
import { SheetTools, type Cell } from "./workbook";

const CHECKS_RANGE = "A2:C6";

export class SheetBooks {
  constructor(readonly t: SheetTools) {}

  #nextRow(sheet: string): number {
    return this.t.readRange(sheet, "used").lastRow + 1;
  }

  #ledgerRows(entryId: string, date: string, memo: string, source: { kind: string; ref: string }, seat: string, lines: { account: string; debit: number; credit: number }[]): Cell[][] {
    return lines.map((l) => [entryId, date, l.account, l.debit, l.credit, memo, source.kind, source.ref, seat]);
  }

  /** The bank feed is imported into the Bank sheet; other world events have no workbook row. */
  async ingest(e: WorldEvent): Promise<void> {
    if (e.type !== "bank.transaction") return;
    const p = e.payload as { txnId: string; date: string; account: string; amountCents: number; description: string };
    const row = this.#nextRow("Bank");
    this.t.writeRange("Bank", `A${row}`, [[p.txnId, p.date, p.account, p.amountCents, p.description, ""]]);
    await this.t.recalc();
  }

  async apply(op: Op): Promise<void> {
    switch (op.kind) {
      case "record_bill": {
        this.t.findRows("AP", "C", op.invoiceNumber); // duplicate look-up by vendor invoice number
        const apRow = this.#nextRow("AP");
        const approve = op.decision === "approve";
        const ledgerRow = approve ? this.#nextRow("Ledger") : 0;
        const entryId = approve ? `JE-${ledgerRow}` : "";
        const status = approve ? "approved" : op.decision === "hold" ? "held" : "rejected";
        this.t.writeRange("AP", `A${apRow}`, [[
          `B-${apRow}`, op.vendor, op.invoiceNumber, op.invoiceDate, op.dueDate, op.store ?? "", op.deliveryId ?? "", op.totalCents, status,
          op.exceptions.join("; "), op.documentExternalId, op.seat, approve ? op.seat : "", entryId, `=COUNTIFS(B:B,B${apRow},C:C,C${apRow})`,
        ]]);
        if (approve) {
          this.t.writeRange("Ledger", `A${ledgerRow}`, this.#ledgerRows(entryId, op.invoiceDate, `${op.vendor} invoice ${op.invoiceNumber}`, { kind: "bill", ref: `B-${apRow}` }, op.seat, [
            { account: op.expenseAccount, debit: op.totalCents, credit: 0 }, { account: "2000", debit: 0, credit: op.totalCents },
          ]));
        }
        break;
      }
      case "resolve_bill": {
        const found = this.t.findRows("AP", "K", op.documentExternalId).matches.at(-1);
        if (!found) throw new Error(`no AP row for ${op.documentExternalId}`);
        const [billId, vendor, invoiceNumber, invoiceDate, , , , total, , exceptions, documentId, recordedBy] = found.values;
        const approve = op.decision === "approve";
        const ledgerRow = approve ? this.#nextRow("Ledger") : 0;
        const entryId = approve ? `JE-${ledgerRow}` : "";
        this.t.writeRange("AP", `I${found.row}`, [[approve ? "approved" : "rejected", exceptions ?? null, documentId ?? null, recordedBy ?? null, op.seat, entryId]]);
        if (approve) {
          const cents = Number(total);
          this.t.writeRange("Ledger", `A${ledgerRow}`, this.#ledgerRows(entryId, String(invoiceDate), `${vendor} invoice ${invoiceNumber} (approved by controller)`, { kind: "bill", ref: String(billId) }, op.seat, [
            { account: op.expenseAccount, debit: cents, credit: 0 }, { account: "2000", debit: 0, credit: cents },
          ]));
        }
        break;
      }
      case "post_entry": {
        const row = this.#nextRow("Ledger");
        this.t.writeRange("Ledger", `A${row}`, this.#ledgerRows(`JE-${row}`, op.date, op.memo, op.source, op.seat, op.lines));
        break;
      }
      case "match_bank": {
        const bank = this.t.findRows("Bank", "A", op.txnId).matches[0];
        const row = this.#nextRow("Ledger");
        this.t.writeRange("Ledger", `A${row}`, this.#ledgerRows(`JE-${row}`, op.date, op.memo, { kind: "bank_match", ref: op.txnId }, op.seat, op.lines));
        if (bank) this.t.writeRange("Bank", `F${bank.row}`, [[`JE-${row}`]]);
        break;
      }
    }
    await this.t.recalc();
    this.t.readRange("Checks", CHECKS_RANGE);
  }

  /** Overwrite the amounts on an already-posted entry (both sides, so it stays balanced). */
  async tamper(sourceKind: string, deltaCents: number): Promise<void> {
    const rows = this.t.findRows("Ledger", "G", sourceKind).matches;
    const first = rows[0];
    if (!first) throw new Error(`no ledger rows with source ${sourceKind}`);
    const entry = rows.filter((r) => r.values[0] === first.values[0]);
    const debit = entry.find((r) => Number(r.values[3]) > 0)!;
    const credit = entry.find((r) => Number(r.values[4]) > 0 && (sourceKind !== "revenue_daily" || r.values[2] === "4000"))!;
    this.t.writeRange("Ledger", `D${debit.row}`, [[Number(debit.values[3]) + deltaCents]]);
    this.t.writeRange("Ledger", `E${credit.row}`, [[Number(credit.values[4]) + deltaCents]]);
    await this.t.recalc();
    this.t.readRange("Checks", CHECKS_RANGE);
  }
}
