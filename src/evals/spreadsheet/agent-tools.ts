// Part B tool sets. The same model gets either the kernel's typed tools or spreadsheet tools
// only. Both sets run in process (kernel harness, local .xlsx), so a run needs no backend.
import { z } from "zod";
import { LANDLORDS } from "../../../company/sweetgreen/profile";
import type { ToolDef } from "../../agents/llm";
import type { KernelBooks } from "./kernel-books";
import { SHEETS, type SheetTools } from "./workbook";
import type { Op } from "./world-ops";

export interface ToolTrace { tool: string; ok: boolean; refused?: string }

const MAX_RESULT_CHARS = 8_000;
const MAX_READ_ROWS = 200;

function tool<S extends z.ZodType>(trace: ToolTrace[], name: string, description: string, schema: S, run: (input: z.infer<S>) => Promise<unknown> | unknown, inputSchema?: Record<string, unknown>): ToolDef {
  const json = inputSchema ?? (z.toJSONSchema(schema) as Record<string, unknown>);
  delete json.$schema;
  return {
    name, description, schema, inputSchema: json,
    run: async (input) => {
      try {
        const out = await run(input as z.infer<S>);
        const refused = out && typeof out === "object" && (out as { ok?: boolean }).ok === false ? String((out as { code?: string }).code) : undefined;
        trace.push({ tool: name, ok: !refused, ...(refused ? { refused } : {}) });
        const text = JSON.stringify(out) ?? "null";
        return text.length > MAX_RESULT_CHARS ? { truncated: true, preview: text.slice(0, MAX_RESULT_CHARS) } : out;
      } catch (e) {
        // Returned, not thrown: the shared client hides thrown messages from the model.
        trace.push({ tool: name, ok: false, refused: "error" });
        return { ok: false, error: e instanceof Error ? e.message.slice(0, 500) : String(e) };
      }
    },
  };
}

const cents = z.number().int();
const entryLines = z.array(z.strictObject({ account: z.string(), debit: cents, credit: cents })).min(2);

export interface Flag { ref: string; reason: string }

export function kernelTools(k: KernelBooks, flags: Flag[], trace: ToolTrace[]): ToolDef[] {
  const landlords = new Set<string>(LANDLORDS.map((l) => l.id));
  const apply = (op: Op) => k.apply(op);
  return [
    tool(trace, "record_bill", "Record a vendor invoice or rent statement as a bill with your decision. The kernel checks arithmetic, duplicates, evidence and approval limits and returns {ok:false, code, error} if it refuses.",
      z.strictObject({
        documentId: z.string().describe("externalId of the received document"), vendor: z.string(), invoiceNumber: z.string(), invoiceDate: z.string(), dueDate: z.string(),
        store: z.string().nullable(), deliveryId: z.string().nullable(),
        lines: z.array(z.strictObject({ sku: z.string().nullable(), description: z.string(), quantity: z.number(), unitCents: cents, amountCents: cents })).min(1),
        totalCents: cents, expenseAccount: z.string(), decision: z.enum(["approve", "hold", "reject"]), exceptions: z.array(z.string()),
      }),
      (i) => apply({
        kind: "record_bill", key: `agent:bill:${i.documentId}`, seat: landlords.has(i.vendor) ? "lease_accountant-1" : "ap_clerk-1", documentExternalId: i.documentId,
        vendor: i.vendor, invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate, dueDate: i.dueDate, ...(i.store ? { store: i.store } : {}), ...(i.deliveryId ? { deliveryId: i.deliveryId } : {}),
        lines: i.lines.map(({ sku, ...l }) => (sku ? { sku, ...l } : l)), totalCents: i.totalCents, expenseAccount: i.expenseAccount, decision: i.decision, exceptions: i.exceptions,
      })),
    tool(trace, "post_entry", "Post a balanced journal entry for daily sales (revenue_daily) or a payroll register (payroll). Amounts are integer cents; each line has exactly one of debit or credit.",
      z.strictObject({ date: z.string(), memo: z.string(), sourceKind: z.enum(["revenue_daily", "payroll"]), sourceRef: z.string(), lines: entryLines }),
      (i) => apply({
        kind: "post_entry", key: `agent:entry:${i.sourceKind}:${i.sourceRef}`, seat: i.sourceKind === "payroll" ? "payroll_accountant-1" : "revenue_accountant-1",
        date: i.date, memo: i.memo, source: { kind: i.sourceKind, ref: i.sourceRef }, lines: i.lines,
      })),
    tool(trace, "match_bank_transaction", "Book a bank transaction. The entry's net cash movement must equal the bank amount; each bank transaction can be booked once.",
      z.strictObject({ txnId: z.string(), date: z.string(), memo: z.string(), lines: entryLines }),
      (i) => apply({ kind: "match_bank", key: `agent:bank:${i.txnId}`, seat: "cash_application-1", txnId: i.txnId, date: i.date, memo: i.memo, lines: i.lines })),
    tool(trace, "flag_exception", "Raise an exception for human review (suspicious documents, unexplained amounts, fee overcharges, payroll problems, credits to apply).",
      z.strictObject({ ref: z.string().describe("externalId, invoice number or bank txnId"), reason: z.string() }),
      (i) => { flags.push(i); return { ok: true, flagged: flags.length }; }),
  ];
}

const sheetName = z.enum(Object.keys(SHEETS) as [keyof typeof SHEETS, ...(keyof typeof SHEETS)[]]);

export function spreadsheetTools(t: SheetTools, trace: ToolTrace[]): ToolDef[] {
  const valuesSchema = z.array(z.array(z.union([z.string(), z.number(), z.null()])));
  return [
    tool(trace, "read_range", `Read cells in A1 notation, e.g. "A2:F10" or "A:A" (at most ${MAX_READ_ROWS} rows per call). range "used" returns only the used-range address and last row.`,
      z.strictObject({ sheet: sheetName, range: z.string() }), (i) => t.readRange(i.sheet, i.range, MAX_READ_ROWS)),
    tool(trace, "write_range", "Write a block of values starting at a cell, e.g. start \"A12\". Strings starting with \"=\" are formulas.",
      z.strictObject({ sheet: sheetName, start: z.string(), values: valuesSchema }), (i) => t.writeRange(i.sheet, i.start, i.values),
      {
        type: "object", additionalProperties: false, required: ["sheet", "start", "values"],
        properties: {
          sheet: { type: "string", enum: Object.keys(SHEETS) }, start: { type: "string" },
          values: { type: "array", items: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] } } },
        },
      }),
    tool(trace, "find_rows", "Find rows whose value in a column (letter) equals the given text, case-insensitive. Returns row numbers and full rows.",
      z.strictObject({ sheet: sheetName, column: z.string(), equals: z.string() }), (i) => t.findRows(i.sheet, i.column, i.equals)),
    tool(trace, "recalc", "Recalculate every formula in the workbook and save it.", z.strictObject({}), () => t.recalc()),
  ];
}
