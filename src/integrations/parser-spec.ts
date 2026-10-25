import { z } from "zod";
import { parseMoney } from "../core/money";
import type { ParsedInvoice } from "./invoice";

// Agent-written parsers are data, not code: the model writes a JSON spec of regexes and field
// mappings, and this fixed interpreter applies it. Nothing the model writes is ever executed,
// so a document that steers parser generation can at worst produce a wrong spec, which the
// schema, arithmetic checks and the controller's stored tests then have to catch.

/** Longest document a spec is run against. Bounds regex work on hostile input. */
export const MAX_DOCUMENT_CHARS = 100_000;
const MAX_PATTERN_CHARS = 400;
const MAX_LINES = 1_000;

/** How a captured string becomes a field value. Dates always come out as YYYY-MM-DD. */
export const Convert = z.enum(["text", "money", "cents", "number", "iso_date", "us_date", "compact_date", "long_date"]);
type Convert = z.infer<typeof Convert>;

// The structural schema stays free of length, range and regex constraints so it works as a
// strict structured-output schema on both providers; ParserSpec checks those below.
const Pattern = z.string();
// Only flags that don't change matching cost or engine semantics: no g/y (we iterate
// ourselves), no s (lets `.` run across the whole document), no u/v/d.
const Flags = z.enum(["", "i", "m", "im"]);
const Group = z.number().int();

const Capture = z.object({
  pattern: Pattern,
  flags: Flags,
  group: Group,
  as: Convert,
  /** No match, or an empty capture, gives null instead of failing the parse. */
  optional: z.boolean(),
}).strict();

const Column = z.object({ group: Group, as: Convert }).strict();

/** One field: a capture, or null for "this layout never has it". */
const Field = Capture.nullable();

const Shape = z.object({
  fields: z.object({
    vendorName: Field, invoiceNumber: Field, invoiceDate: Field, dueDate: Field, storeId: Field, deliveryId: Field,
    totalCents: Field, remitBank: Field, remitLast4: Field, note: Field,
  }).strict(),
  lines: z.object({
    pattern: Pattern, flags: Flags,
    sku: Column, description: Column, quantity: Column, unitCents: Column, amountCents: Column,
  }).strict(),
}).strict();

/**
 * Structural shape only, for the model's structured output. Every key is required so it
 * works as a strict JSON schema; the safety checks below run on the result.
 */
export const ParserSpecShape = Shape;

/** Why a regex is refused, or null. Exported for the error message the model gets back. */
export function unsafePattern(pattern: string, flags: string): string | null {
  if (!pattern.length || pattern.length > MAX_PATTERN_CHARS) return `patterns must be 1-${MAX_PATTERN_CHARS} characters`;
  try {
    new RegExp(pattern, flags);
  } catch (e) {
    return `invalid regex: ${e instanceof Error ? e.message : e}`;
  }
  if (/\\[1-9]|\\k</.test(pattern)) return "backreferences are not allowed";
  // Reject a quantified group that itself contains a quantifier or an alternation, e.g.
  // (a+)+, (?:[^|]*\|){3} or (a|ab)*: the shapes that backtrack exponentially. Write the
  // repetition out instead. A trailing `?` on such a group is fine.
  const stack: { risky: boolean }[] = [{ risky: false }];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") { i++; continue; }
    if (c === "[") {
      for (i++; i < pattern.length && pattern[i] !== "]"; i++) if (pattern[i] === "\\") i++;
      continue;
    }
    if (c === "(") { stack.push({ risky: false }); continue; }
    const top = stack[stack.length - 1]!;
    if (c === "|") { top.risky = true; continue; }
    if (c === "*" || c === "+" || c === "{") { top.risky = true; continue; }
    if (c === ")") {
      const group = stack.pop()!;
      const next = pattern[i + 1];
      const quantified = next === "*" || next === "+" || next === "{";
      if (group.risky && quantified) return `nested repetition near "${pattern.slice(Math.max(0, i - 20), i + 2)}"`;
      stack[stack.length - 1]!.risky ||= group.risky || quantified;
    }
  }
  return null;
}

export const ParserSpec = Shape.superRefine((spec, ctx) => {
  const l = spec.lines;
  const patterns: [string[], string, string][] = [[["lines", "pattern"], l.pattern, l.flags]];
  const groups: [string[], number][] = (["sku", "description", "quantity", "unitCents", "amountCents"] as const).map((c) => [["lines", c, "group"], l[c].group]);
  for (const [name, f] of Object.entries(spec.fields)) {
    if (!f) continue;
    patterns.push([["fields", name, "pattern"], f.pattern, f.flags]);
    groups.push([["fields", name, "group"], f.group]);
  }
  for (const [where, pattern, flags] of patterns) {
    const problem = unsafePattern(pattern, flags);
    if (problem) ctx.addIssue({ code: "custom", path: where, message: problem });
  }
  for (const [where, group] of groups) {
    if (group < 1 || group > 9) ctx.addIssue({ code: "custom", path: where, message: "capture group must be 1-9" });
  }
});
export type ParserSpec = z.infer<typeof ParserSpec>;
export type ParserSpecInput = z.input<typeof ParserSpec>;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function isoDate(y: string, m: string, d: string): string {
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) throw new Error(`not a date: ${iso}`);
  return iso;
}

function convert(raw: string, as: Convert): string | number {
  const s = raw.trim();
  const fail = (): never => { throw new Error(`cannot read ${JSON.stringify(s.slice(0, 40))} as ${as}`); };
  switch (as) {
    case "text": return s;
    case "money": return parseMoney(s);
    case "cents": {
      if (!/^-?\d+$/.test(s)) fail();
      const n = Number(s);
      return Number.isSafeInteger(n) ? n : fail();
    }
    case "number": return /^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : fail();
    case "iso_date": { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) ?? fail(); return isoDate(m[1]!, m[2]!, m[3]!); }
    case "us_date": { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s) ?? fail(); return isoDate(m[3]!, m[1]!, m[2]!); }
    case "compact_date": { const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s) ?? fail(); return isoDate(m[1]!, m[2]!, m[3]!); }
    case "long_date": {
      const m = /^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/.exec(s) ?? fail();
      const month = MONTHS.findIndex((name) => name.startsWith(m[1]!.toLowerCase()) && m[1]!.length >= 3);
      return month < 0 ? fail() : isoDate(m[3]!, String(month + 1), m[2]!);
    }
  }
}

/** Apply a validated spec to a document. Throws on anything it can't read; never guesses. */
export function applySpec(spec: ParserSpec, text: string): ParsedInvoice {
  if (text.length > MAX_DOCUMENT_CHARS) throw new Error(`document too large for a parser spec (${text.length} chars)`);
  const field = (name: keyof ParserSpec["fields"]) => {
    const f = spec.fields[name];
    if (!f) return null;
    const value = new RegExp(f.pattern, f.flags).exec(text)?.[f.group];
    if (value === undefined || value.trim() === "") {
      if (f.optional) return null;
      if (value === undefined) throw new Error(`${name}: pattern did not match`);
    }
    return convert(value!, f.as);
  };
  const l = spec.lines;
  const lines = [];
  for (const m of text.matchAll(new RegExp(l.pattern, `${l.flags}g`))) {
    if (m[0] === "") throw new Error("line pattern matched an empty string");
    if (lines.length >= MAX_LINES) throw new Error(`more than ${MAX_LINES} line items`);
    const col = (c: { group: number; as: Convert }) => convert(m[c.group] ?? "", c.as);
    lines.push({ sku: col(l.sku), description: col(l.description), quantity: col(l.quantity), unitCents: col(l.unitCents), amountCents: col(l.amountCents) });
  }
  // Shape errors (a date read as text, a number as a string) are caught by ParsedInvoice in parseWith.
  return {
    vendorName: field("vendorName"), invoiceNumber: field("invoiceNumber"), invoiceDate: field("invoiceDate"), dueDate: field("dueDate"),
    storeId: field("storeId"), deliveryId: field("deliveryId"), lines, totalCents: field("totalCents"),
    remitBank: field("remitBank"), remitLast4: field("remitLast4"), note: field("note"),
  } as unknown as ParsedInvoice;
}

/** What the codegen prompt tells the model about the spec format. */
export const SPEC_FORMAT = `A JSON parser spec has two keys.
"fields": one entry per invoice field: vendorName, invoiceNumber, invoiceDate, dueDate, storeId, deliveryId,
  totalCents, remitBank, remitLast4, note. Each is null (the layout never has it) or
  { "pattern": JavaScript regex source, "flags": "", "i", "m" or "im" (usually "m"), "group": capture group 1-9,
    "as": conversion, "optional": true to give null when nothing matches or the capture is empty }.
  The first match in the whole document is used.
"lines": { "pattern", "flags", and for each of sku, description, quantity, unitCents, amountCents:
  { "group", "as" } }. Every match of the pattern is one line item, in document order.
Conversions ("as"): "text" (trimmed string), "money" ("$1,234.56" or "1234.56" to integer cents),
  "cents" (an integer that is already cents), "number" (a plain decimal quantity),
  "iso_date" (2026-01-31), "us_date" (01/31/2026), "compact_date" (20260131), "long_date" (January 31, 2026).
  Dates always come out as YYYY-MM-DD. Amounts must come out as integer cents.
Regex rules: no backreferences, and no repeated group that contains a quantifier or "|"
  (write "[^|]*\\|[^|]*\\|" instead of "(?:[^|]*\\|){2}"). Patterns are at most ${MAX_PATTERN_CHARS} characters.`;
