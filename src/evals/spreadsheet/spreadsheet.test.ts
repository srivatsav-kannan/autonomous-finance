import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { kernelTools, spreadsheetTools, type Flag, type ToolTrace } from "./agent-tools";
import { badCases, runKernelCase, runSheetCase } from "./bad-ops";
import { replayKernel, replaySheet } from "./replay";
import { SheetBooks } from "./sheet-books";
import { kernelState, scoreSlice, sheetState } from "./slice-score";
import { SheetTools } from "./workbook";
import { buildStream } from "./world-ops";

const small = { seed: 7, storeCount: 1, start: "2026-01-01", days: 4, plantErrors: true };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sheets-bench-"));

describe("workbook formulas", () => {
  it("recalculates SUMIFS, COUNTIFS, IF and arithmetic, including zero results", async () => {
    const t = await SheetTools.create(null);
    t.writeRange("Ledger", "A2", [["JE-2", "2026-01-01", "1100", 500, 0], ["JE-2", "2026-01-01", "4000", 0, 500]]);
    t.writeRange("AP", "A2", [["B-2", "v", "INV-1", "", "", "", "", 100, "approved", "", "d1", "a", "a", "", "=COUNTIFS(B:B,B2,C:C,C2)"]]);
    t.writeRange("AP", "A3", [["B-3", "v", "inv-1", "", "", "", "", 100, "held", "", "d2", "a", "", "", "=COUNTIFS(B:B,B3,C:C,C3)"]]);
    await t.recalc();
    const tb = new Map(t.rows("TB").map((r) => [String(r[0]), r]));
    expect(tb.get("1100")!.slice(2)).toEqual([500, 0, 500]);
    expect(tb.get("4000")!.slice(2)).toEqual([0, 500, -500]);
    expect(tb.get("TOTAL")![4]).toBe(0);
    // Excel matching is case-insensitive, so INV-1 and inv-1 count as the same invoice here.
    expect(t.rows("AP").map((r) => r[14])).toEqual([2, 2]);
    expect(t.checkValues().map((c) => c.name.startsWith("AP rows") ? c.value : 0)).toContain(2);
    expect(t.readRange("Checks", "C2:C2").values).toEqual([["OK"]]);
  });

  it("survives a save and reload with formula results intact", async () => {
    const dir = tmp();
    const t = await SheetTools.create(path.join(dir, "a.xlsx"));
    t.writeRange("Ledger", "A2", [["JE-2", "2026-01-01", "1100", 700, 0], ["JE-2", "2026-01-01", "4000", 0, 700]]);
    await t.recalc();
    const back = await SheetTools.load(path.join(dir, "a.xlsx"), null);
    expect(back.rows("TB").find((r) => r[0] === "1100")![4]).toBe(700);
    expect(back.checkValues().every((c) => c.ok)).toBe(true);
    expect(back.actions).toHaveLength(0);
  });
});

describe("part A: same stream, two substrates", () => {
  it("produces identical books on both paths with every workbook check at zero", async () => {
    const { steps } = buildStream(small);
    const { k } = await replayKernel(steps);
    const { s, trial } = await replaySheet(steps, null);
    const kernelTb = new Map((await k.trialBalance()).map((a) => [a.code, a.net]));
    for (const r of s.t.rows("TB").filter((x) => x[0] !== "TOTAL")) expect(Number(r[4])).toBe(kernelTb.get(String(r[0])) ?? 0);
    expect(k.h.all("bills").map((b) => [b.status, b.totalCents]).sort()).toEqual(s.t.rows("AP").map((r) => [r[8], r[7]]).sort());
    expect(s.t.checkValues().every((c) => c.ok)).toBe(true);
    expect((await k.verifyChain()).ok).toBe(true);
    // One typed call per operation on the kernel; several tool calls on the workbook.
    expect(k.calls).toBe(trial.perOp.length);
    expect(trial.perOp.every((o) => o.actions >= 4)).toBe(true);
  });

  it("kernel stops every injected bad operation; the workbook only flags some after they land", async () => {
    const { steps } = buildStream(small);
    const dir = tmp();
    const { s } = await replaySheet(steps, null);
    await s.t.save(path.join(dir, "baseline.xlsx"));
    const kernel: Record<string, string> = {}, sheet: Record<string, string> = {};
    for (const c of badCases(steps, "2026-01-04")) {
      const { k } = await replayKernel(steps);
      kernel[c.id] = (await runKernelCase(k, c)).outcome;
      sheet[c.id] = (await runSheetCase(new SheetBooks(await SheetTools.load(path.join(dir, "baseline.xlsx"), null)), c)).outcome;
    }
    expect(Object.values(kernel).filter((o) => o === "missed")).toHaveLength(0);
    expect(kernel.retried_posting).toBe("absorbed");
    expect(kernel.tamper_revenue_entry).toBe("detected");
    expect(kernel.bank_txn_matched_twice).toBe("prevented");
    expect(kernel.self_approval).toBe("prevented");
    expect(Object.values(sheet).filter((o) => o === "prevented")).toHaveLength(0);
    expect(Object.entries(sheet).filter(([, o]) => o === "detected").map(([id]) => id).sort()).toEqual([
      "ap_clerk_posts_cash", "bank_txn_matched_twice", "cash_amount_mismatch", "cash_without_bank_evidence",
      "duplicate_invoice_exact", "tamper_bill_accrual", "unbalanced_entry", "unknown_account",
    ]);
  });
});

describe("part B: tools and scoring without a model", () => {
  it("kernel tools return refusals to the model as values", async () => {
    const { KernelBooks } = await import("./kernel-books");
    const k = await KernelBooks.create();
    const trace: ToolTrace[] = [], flags: Flag[] = [];
    const post = kernelTools(k, flags, trace).find((t) => t.name === "post_entry")!;
    const input = post.schema.parse({ date: "2026-01-02", memo: "x", sourceKind: "revenue_daily", sourceRef: "r", lines: [{ account: "1100", debit: 10, credit: 0 }, { account: "4000", debit: 0, credit: 9 }] });
    expect(await post.run(input)).toMatchObject({ ok: false, code: "invalid_entry" });
    expect(trace).toEqual([{ tool: "post_entry", ok: false, refused: "invalid_entry" }]);
  });

  it("spreadsheet tools write, recalc and read back through the model-facing schemas", async () => {
    const t = await SheetTools.create(null);
    const trace: ToolTrace[] = [];
    const tools = new Map(spreadsheetTools(t, trace).map((x) => [x.name, x]));
    const call = (name: string, input: unknown) => tools.get(name)!.run(tools.get(name)!.schema.parse(input));
    expect(await call("read_range", { sheet: "Ledger", range: "used" })).toMatchObject({ lastRow: 1 });
    await call("write_range", { sheet: "Ledger", start: "A2", values: [["JE-2", "2026-01-01", "1100", 10, 0], ["JE-2", "2026-01-01", "4000", 0, 9]] });
    await call("recalc", {});
    expect(await call("read_range", { sheet: "Checks", range: "B2:C2" })).toMatchObject({ values: [[1, "CHECK"]] });
    expect(() => call("read_range", { sheet: "Nope", range: "A1" })).toThrow(); // schema rejects unknown sheets
    expect(trace.map((x) => x.tool)).toEqual(["read_range", "write_range", "recalc", "read_range"]);
  });

  it("scores both end states with the same oracle", async () => {
    const { world, steps } = buildStream({ ...small, days: 2 });
    const { k } = await replayKernel(steps);
    const { s } = await replaySheet(steps, null);
    const a = scoreSlice(world, await kernelState(k, []));
    const b = scoreSlice(world, sheetState(s.t));
    expect(b).toEqual({ ...a, refusals: 0 });
    expect(a.billsRecorded).toBe(a.invoiceDocuments);
    expect(a.trialBalanceNetsToZero).toBe(true);
  });
});
