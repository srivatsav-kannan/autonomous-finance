// Path 2: a real .xlsx workbook kept the way a human finance team keeps one, behind the
// four tools spreadsheet-based AI finance tools expose: read_range, write_range, find_rows
// and recalc. Each tool call is one "action" an agent must issue.
//
// exceljs reads and writes the file but has no calculation engine, so recalc() uses the
// small evaluator below for the formulas this workbook uses (SUM, SUMIFS, COUNTIF(S), IF,
// arithmetic, comparisons). It recalculates every formula and writes cached results into
// the file, so Excel shows the same numbers when it opens it.
import ExcelJS from "exceljs";
import { CHART } from "../../core/accounts";

export type Cell = string | number | boolean | null;

export const SHEETS = {
  Ledger: ["EntryId", "Date", "Account", "Debit (cents)", "Credit (cents)", "Memo", "SourceKind", "SourceRef", "PostedBy"],
  AP: ["BillId", "Vendor", "InvoiceNumber", "InvoiceDate", "DueDate", "Store", "DeliveryId", "Total (cents)", "Status", "Exceptions", "DocumentId", "RecordedBy", "ApprovedBy", "EntryId", "DupCount"],
  Bank: ["TxnId", "Date", "Account", "Amount (cents)", "Description", "MatchedEntry"],
  TB: ["Account", "Name", "Debits", "Credits", "Net"],
  Checks: ["Check", "Value", "Status"],
  Exceptions: ["Ref", "Reason", "FlaggedBy"],
} as const;
export type SheetName = keyof typeof SHEETS;

/** TB rows 2..TB_TOTAL_ROW-1 hold the chart of accounts; the total row sums them. */
export const TB_TOTAL_ROW = CHART.length + 2;

/** The reconciliations a finance team typically builds into its workbook. 0 means OK. */
export const CHECKS: { name: string; formula: string }[] = [
  { name: "Trial balance difference (debits - credits)", formula: `TB!C${TB_TOTAL_ROW}-TB!D${TB_TOTAL_ROW}` },
  { name: "AP rows sharing vendor + invoice number", formula: `COUNTIF(AP!O:O,">1")` },
  { name: "Bank rec, operating 1000 (books - bank)", formula: `SUMIFS(Ledger!D:D,Ledger!C:C,"1000")-SUMIFS(Ledger!E:E,Ledger!C:C,"1000")-SUMIFS(Bank!D:D,Bank!C:C,"operating")` },
  { name: "Bank rec, deposits 1020 (books - bank)", formula: `SUMIFS(Ledger!D:D,Ledger!C:C,"1020")-SUMIFS(Ledger!E:E,Ledger!C:C,"1020")-SUMIFS(Bank!D:D,Bank!C:C,"deposits")` },
  { name: "AP subledger (approved) vs GL 2000", formula: `SUMIFS(AP!H:H,AP!I:I,"approved")-(SUMIFS(Ledger!E:E,Ledger!C:C,"2000")-SUMIFS(Ledger!D:D,Ledger!C:C,"2000"))` },
];

export interface Action { tool: "read_range" | "write_range" | "find_rows" | "recalc"; sheet?: string; cellsRead: number; cellsWritten: number; ms: number }

// ---------- A1 helpers ----------
export function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function colLetters(n: number): string {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function parseCell(ref: string): { c: number; r: number | null } {
  const m = /^\$?([A-Z]+)\$?(\d*)$/i.exec(ref.trim());
  if (!m) throw new Error(`bad cell reference ${ref}`);
  return { c: colNumber(m[1]!), r: m[2] ? Number(m[2]) : null };
}
export function parseRange(range: string): { c1: number; r1: number | null; c2: number; r2: number | null } {
  const [a, b] = range.split(":");
  const p1 = parseCell(a!);
  const p2 = b ? parseCell(b) : p1;
  return { c1: p1.c, r1: p1.r, c2: p2.c, r2: p2.r };
}

// ---------- formula evaluator ----------
type Ast =
  | { t: "num"; v: number } | { t: "str"; v: string }
  | { t: "ref"; sheet?: string; a: string; b?: string }
  | { t: "call"; name: string; args: Ast[] }
  | { t: "bin"; op: string; l: Ast; r: Ast } | { t: "neg"; e: Ast };

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:("[^"]*")|(\d+(?:\.\d+)?)|(\$?[A-Za-z_][A-Za-z0-9_$]*)|(<=|>=|<>|[=<>+\-*/(),:!]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`formula syntax error near "${src.slice(i, i + 12)}"`);
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4]!);
    i = re.lastIndex;
  }
  return out;
}

const astCache = new Map<string, Ast>();
export function parseFormula(src: string): Ast {
  const hit = astCache.get(src);
  if (hit) return hit;
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++]!;
  const expect = (t: string) => { if (next() !== t) throw new Error(`expected ${t} in ${src}`); };
  const cmp = (): Ast => {
    let l = add();
    while (["=", "<>", "<", ">", "<=", ">="].includes(peek() ?? "")) { const op = next(); l = { t: "bin", op, l, r: add() }; }
    return l;
  };
  const add = (): Ast => {
    let l = mul();
    while (peek() === "+" || peek() === "-") { const op = next(); l = { t: "bin", op, l, r: mul() }; }
    return l;
  };
  const mul = (): Ast => {
    let l = unary();
    while (peek() === "*" || peek() === "/") { const op = next(); l = { t: "bin", op, l, r: unary() }; }
    return l;
  };
  const unary = (): Ast => (peek() === "-" ? (next(), { t: "neg", e: unary() }) : primary());
  const primary = (): Ast => {
    const tok = next();
    if (tok === undefined) throw new Error(`unexpected end of ${src}`);
    if (tok === "(") { const e = cmp(); expect(")"); return e; }
    if (tok.startsWith("\"")) return { t: "str", v: tok.slice(1, -1) };
    if (/^\d/.test(tok)) return { t: "num", v: Number(tok) };
    if (peek() === "(") {
      next();
      const args: Ast[] = [];
      if (peek() !== ")") { args.push(cmp()); while (peek() === ",") { next(); args.push(cmp()); } }
      expect(")");
      return { t: "call", name: tok.toUpperCase(), args };
    }
    let sheet: string | undefined;
    let a = tok;
    if (peek() === "!") { next(); sheet = tok; a = next(); }
    if (peek() === ":") { next(); return { t: "ref", sheet, a, b: next() }; }
    return { t: "ref", sheet, a };
  };
  const ast = cmp();
  if (p !== toks.length) throw new Error(`unexpected token ${toks[p]} in ${src}`);
  astCache.set(src, ast);
  return ast;
}

interface RangeVal { range: true; sheet: string; c1: number; r1: number; c2: number; r2: number }
type Val = Cell | RangeVal;
const isRange = (v: Val): v is RangeVal => typeof v === "object" && v !== null;

function asNumber(v: Cell): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function matches(value: Cell, criterion: Cell): boolean {
  if (typeof criterion === "string") {
    const m = /^(<=|>=|<>|=|<|>)(.*)$/.exec(criterion);
    if (m) {
      const [, op, rhs] = m;
      const a = asNumber(value), b = asNumber(rhs!);
      if (a !== null && b !== null) {
        return op === "<=" ? a <= b : op === ">=" ? a >= b : op === "<>" ? a !== b : op === "=" ? a === b : op === "<" ? a < b : a > b;
      }
      const sa = String(value ?? "").toLowerCase(), sb = rhs!.toLowerCase();
      return op === "<>" ? sa !== sb : op === "=" ? sa === sb : false;
    }
  }
  const a = asNumber(value), b = asNumber(criterion);
  if (a !== null && b !== null) return a === b;
  return String(value ?? "").toLowerCase() === String(criterion ?? "").toLowerCase();
}

class Evaluator {
  readonly #memo = new Map<string, Cell>();
  readonly #cols = new Map<string, (Cell | undefined)[]>();
  readonly #active = new Set<string>();
  constructor(private wb: ExcelJS.Workbook) {}

  #ws(sheet: string) {
    const ws = this.wb.getWorksheet(sheet);
    if (!ws) throw new Error(`no sheet ${sheet}`);
    return ws;
  }

  /** Resolved value of one cell; formula cells are evaluated (memoized per recalc). */
  cell(sheet: string, r: number, c: number): Cell {
    const key = `${sheet}!${r},${c}`;
    if (this.#memo.has(key)) return this.#memo.get(key)!;
    const raw = this.#ws(sheet).getRow(r).getCell(c).value;
    let v: Cell;
    if (raw && typeof raw === "object" && "formula" in raw) {
      if (this.#active.has(key)) throw new Error(`circular reference at ${key}`);
      this.#active.add(key);
      const out = this.eval(parseFormula(String(raw.formula)), sheet);
      this.#active.delete(key);
      v = isRange(out) ? null : out;
    } else v = normalize(raw);
    this.#memo.set(key, v);
    return v;
  }

  // Columns are filled lazily, only for the rows a range asks for, so a bounded range never
  // evaluates (and cycles through) the cell that contains it.
  #column(sheet: string, c: number): (Cell | undefined)[] {
    const key = `${sheet}!${c}`;
    let col = this.#cols.get(key);
    if (!col) this.#cols.set(key, col = []);
    return col;
  }

  values(rv: RangeVal): Cell[] {
    const out: Cell[] = [];
    for (let c = rv.c1; c <= rv.c2; c++) {
      const col = this.#column(rv.sheet, c);
      for (let r = rv.r1; r <= rv.r2; r++) {
        let v = col[r];
        if (v === undefined) col[r] = v = this.cell(rv.sheet, r, c);
        out.push(v);
      }
    }
    return out;
  }

  eval(ast: Ast, sheet: string): Val {
    switch (ast.t) {
      case "num": case "str": return ast.v;
      case "neg": { const v = this.eval(ast.e, sheet); return -(asNumber(isRange(v) ? null : v) ?? 0); }
      case "ref": {
        const s = ast.sheet ?? sheet;
        const a = parseCell(ast.a), b = ast.b ? parseCell(ast.b) : null;
        const lastRow = this.#ws(s).rowCount;
        if (!b) {
          if (a.r === null) throw new Error(`bad reference ${ast.a}`);
          return this.cell(s, a.r, a.c);
        }
        return { range: true, sheet: s, c1: a.c, r1: a.r ?? 1, c2: b.c, r2: b.r ?? lastRow };
      }
      case "bin": {
        const lv = this.eval(ast.l, sheet), rv = this.eval(ast.r, sheet);
        const l = isRange(lv) ? null : lv, r = isRange(rv) ? null : rv;
        if (["+", "-", "*", "/"].includes(ast.op)) {
          const x = asNumber(l) ?? 0, y = asNumber(r) ?? 0;
          return ast.op === "+" ? x + y : ast.op === "-" ? x - y : ast.op === "*" ? x * y : x / y;
        }
        return matches(l, `${ast.op}${r ?? ""}`);
      }
      case "call": {
        const args = ast.args.map((x) => this.eval(x, sheet));
        const flat = (v: Val) => (isRange(v) ? this.values(v) : [v]);
        switch (ast.name) {
          case "SUM": return args.flatMap(flat).reduce<number>((s, v) => s + (typeof v === "number" ? v : 0), 0);
          case "ABS": return Math.abs(asNumber(isRange(args[0]!) ? null : args[0] as Cell) ?? 0);
          case "IF": return (args[0] ? args[1] : args[2]) as Cell;
          case "COUNTIF": return this.values(args[0] as RangeVal).filter((v) => matches(v, args[1] as Cell)).length;
          case "COUNTIFS": case "SUMIFS": {
            const sumRange = ast.name === "SUMIFS" ? this.values(args[0] as RangeVal) : null;
            const pairs: [Cell[], Cell][] = [];
            for (let i = sumRange ? 1 : 0; i < args.length; i += 2) pairs.push([this.values(args[i] as RangeVal), args[i + 1] as Cell]);
            const n = sumRange?.length ?? pairs[0]![0].length;
            let total = 0;
            for (let i = 0; i < n; i++) {
              if (!pairs.every(([vals, crit]) => matches(vals[i] ?? null, crit))) continue;
              total += sumRange ? (typeof sumRange[i] === "number" ? sumRange[i] as number : 0) : 1;
            }
            return total;
          }
          default: throw new Error(`unsupported function ${ast.name}`);
        }
      }
    }
  }
}

function normalize(raw: ExcelJS.CellValue): Cell {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" || typeof raw === "string" || typeof raw === "boolean") return raw;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === "object" && "result" in raw) return normalize(raw.result as ExcelJS.CellValue);
  if (typeof raw === "object" && "richText" in raw) return raw.richText.map((t) => t.text).join("");
  return String(raw);
}

// ---------- the tools ----------
export class SheetTools {
  readonly actions: Action[] = [];
  #formulas = new Map<string, Set<string>>(); // sheet -> "r,c"
  // exceljs drops falsy cached results (a formula equal to 0 reads back as no result), so
  // the last recalculated value of every formula cell is kept here.
  #results = new Map<string, Cell>();

  private constructor(readonly wb: ExcelJS.Workbook, public file: string | null) {
    wb.eachSheet((ws) => ws.eachRow((row, r) => row.eachCell((cell, c) => {
      if (cell.value && typeof cell.value === "object" && "formula" in cell.value) this.#track(ws.name, r, c, true);
    })));
  }

  /** A new workbook with the team's layout: headers, chart of accounts, TB formulas and checks. */
  static async create(file: string | null): Promise<SheetTools> {
    const wb = new ExcelJS.Workbook();
    for (const [name, headers] of Object.entries(SHEETS)) wb.addWorksheet(name).addRow([...headers]);
    const tb = wb.getWorksheet("TB")!;
    CHART.forEach((a, i) => {
      const r = i + 2;
      tb.addRow([a.code, a.name, { formula: `SUMIFS(Ledger!D:D,Ledger!C:C,A${r})` }, { formula: `SUMIFS(Ledger!E:E,Ledger!C:C,A${r})` }, { formula: `C${r}-D${r}` }]);
    });
    tb.addRow(["TOTAL", "", { formula: `SUM(C2:C${TB_TOTAL_ROW - 1})` }, { formula: `SUM(D2:D${TB_TOTAL_ROW - 1})` }, { formula: `C${TB_TOTAL_ROW}-D${TB_TOTAL_ROW}` }]);
    const checks = wb.getWorksheet("Checks")!;
    CHECKS.forEach((c, i) => checks.addRow([c.name, { formula: c.formula }, { formula: `IF(B${i + 2}=0,"OK","CHECK")` }]));
    const tools = new SheetTools(wb, file);
    await tools.#recalc();
    return tools;
  }

  static async load(file: string, saveTo: string | null = file): Promise<SheetTools> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const tools = new SheetTools(wb, null);
    await tools.#recalc(); // restore formula results without saving; not an agent action
    tools.file = saveTo;
    return tools;
  }

  #value(sheet: string, r: number, c: number, raw: ExcelJS.CellValue): Cell {
    if (raw && typeof raw === "object" && "formula" in raw) return this.#results.get(`${sheet}!${r},${c}`) ?? null;
    return normalize(raw);
  }

  #track(sheet: string, r: number, c: number, isFormula: boolean) {
    let set = this.#formulas.get(sheet);
    if (!set) this.#formulas.set(sheet, set = new Set());
    if (isFormula) set.add(`${r},${c}`); else set.delete(`${r},${c}`);
  }
  #ws(sheet: string) {
    const ws = this.wb.getWorksheet(sheet);
    if (!ws) throw new Error(`no sheet named ${sheet}; sheets are ${Object.keys(SHEETS).join(", ")}`);
    return ws;
  }
  #log(a: Omit<Action, "ms">, started: number) { this.actions.push({ ...a, ms: performance.now() - started }); }

  /** read_range. `range` is A1 notation ("A2:F10", "A:A") or "used" for the used-range address only. */
  readRange(sheet: string, range: string, maxRows = Infinity): { used?: string; lastRow: number; values?: Cell[][]; truncated?: boolean } {
    const started = performance.now();
    const ws = this.#ws(sheet);
    const lastRow = ws.rowCount;
    if (range === "used") {
      this.#log({ tool: "read_range", sheet, cellsRead: 0, cellsWritten: 0 }, started);
      return { used: `A1:${colLetters(Math.max(1, ws.columnCount))}${lastRow}`, lastRow };
    }
    const p = parseRange(range);
    const r1 = p.r1 ?? 1;
    let r2 = Math.min(p.r2 ?? lastRow, lastRow);
    const truncated = r2 - r1 + 1 > maxRows;
    if (truncated) r2 = r1 + maxRows - 1;
    const values: Cell[][] = [];
    for (let r = r1; r <= r2; r++) {
      const row = ws.getRow(r);
      const out: Cell[] = [];
      for (let c = p.c1; c <= p.c2; c++) out.push(this.#value(sheet, r, c, row.getCell(c).value));
      values.push(out);
    }
    this.#log({ tool: "read_range", sheet, cellsRead: values.length * (p.c2 - p.c1 + 1), cellsWritten: 0 }, started);
    return { lastRow, values, ...(truncated ? { truncated } : {}) };
  }

  /** write_range. Strings starting with "=" are written as formulas. */
  writeRange(sheet: string, start: string, values: Cell[][]): { updated: string; cells: number } {
    const started = performance.now();
    const ws = this.#ws(sheet);
    const s = parseCell(start);
    if (s.r === null) throw new Error("write_range start must be a cell like A2");
    let cells = 0, width = 0;
    values.forEach((rowVals, i) => {
      const row = ws.getRow(s.r! + i);
      rowVals.forEach((v, j) => {
        const isFormula = typeof v === "string" && v.startsWith("=");
        row.getCell(s.c + j).value = isFormula ? { formula: v.slice(1) } : v;
        this.#track(sheet, s.r! + i, s.c + j, isFormula);
        cells++;
      });
      width = Math.max(width, rowVals.length);
      row.commit();
    });
    this.#log({ tool: "write_range", sheet, cellsRead: 0, cellsWritten: cells }, started);
    return { updated: `${start}:${colLetters(s.c + Math.max(width, 1) - 1)}${s.r + Math.max(values.length, 1) - 1}`, cells };
  }

  /** find_rows. Rows (after the header) whose cell in `column` equals `equals`, case-insensitive. */
  findRows(sheet: string, column: string, equals: string, maxRows = 50): { matches: { row: number; values: Cell[] }[] } {
    const started = performance.now();
    const ws = this.#ws(sheet);
    const c = colNumber(column);
    const width = SHEETS[sheet as SheetName]?.length ?? ws.columnCount;
    const want = equals.trim().toLowerCase();
    const found: { row: number; values: Cell[] }[] = [];
    for (let r = 2; r <= ws.rowCount && found.length < maxRows; r++) {
      const row = ws.getRow(r);
      if (String(this.#value(sheet, r, c, row.getCell(c).value) ?? "").trim().toLowerCase() !== want) continue;
      const vals: Cell[] = [];
      for (let k = 1; k <= width; k++) vals.push(this.#value(sheet, r, k, row.getCell(k).value));
      found.push({ row: r, values: vals });
    }
    this.#log({ tool: "find_rows", sheet, cellsRead: found.length * width, cellsWritten: 0 }, started);
    return { matches: found };
  }

  async #recalc(): Promise<number> {
    const ev = new Evaluator(this.wb);
    let n = 0;
    for (const [sheet, cells] of this.#formulas) {
      const ws = this.#ws(sheet);
      for (const key of cells) {
        const [r, c] = key.split(",").map(Number) as [number, number];
        const cell = ws.getRow(r).getCell(c);
        const value = cell.value as { formula: string };
        const result = ev.cell(sheet, r, c);
        this.#results.set(`${sheet}!${r},${c}`, result);
        cell.value = { formula: value.formula, result: result as never };
        n++;
      }
    }
    if (this.file) await this.wb.xlsx.writeFile(this.file);
    return n;
  }

  /** recalc. Recalculates every formula and saves the workbook. */
  async recalc(): Promise<{ formulas: number; saved: boolean }> {
    const started = performance.now();
    const formulas = await this.#recalc();
    this.#log({ tool: "recalc", cellsRead: 0, cellsWritten: 0 }, started);
    return { formulas, saved: Boolean(this.file) };
  }

  // ---- untracked access for scoring and parity checks (not agent actions) ----
  rows(sheet: SheetName): Cell[][] {
    const ws = this.#ws(sheet);
    const out: Cell[][] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const vals: Cell[] = [];
      for (let c = 1; c <= SHEETS[sheet].length; c++) vals.push(this.#value(sheet, r, c, row.getCell(c).value));
      if (vals.some((v) => v !== null && v !== "")) out.push(vals);
    }
    return out;
  }
  checkValues(): { name: string; value: number; ok: boolean }[] {
    return this.rows("Checks").map((r) => ({ name: String(r[0]), value: Number(r[1]), ok: Number(r[1]) === 0 }));
  }
  async save(file: string) { await this.wb.xlsx.writeFile(file); }
}
