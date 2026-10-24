import vm from "node:vm";
import { parseMoney } from "../core/money";
import type { MemoryStore } from "../memory/store";
import { ParsedInvoice, checkInvoiceMath, layoutSignature } from "./invoice";

export interface Parser {
  id: string;
  /** Where it came from: built in, or written by an agent and approved into memory. */
  origin: "builtin" | "memory";
  detect: (text: string) => boolean;
  parse: (text: string) => ParsedInvoice;
}

function usToIso(d: string): string {
  const [m, day, y] = d.split("/");
  return `${y}-${m!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
}

const columnar: Parser = {
  id: "columnar-v1",
  origin: "builtin",
  detect: (t) => /INVOICE\s+Invoice #:/.test(t),
  parse: (t) => {
    const get = (re: RegExp) => re.exec(t)?.[1]?.trim() ?? null;
    const lines = [...t.matchAll(/^(\S+)\s{2,}(.+?)\s{2,}(\d+(?:\.\d+)?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/gm)].map((m) => ({
      sku: m[1]!,
      description: m[2]!.trim(),
      quantity: Number(m[3]),
      unitCents: parseMoney(m[4]!),
      amountCents: parseMoney(m[5]!),
    }));
    const remit = /Remit to: (.+?)\s+acct \*{4}(\d{4})/.exec(t);
    return {
      vendorName: t.split("\n")[0]!.trim(),
      invoiceNumber: get(/Invoice #: (\S+)/) ?? "",
      invoiceDate: get(/Invoice Date: (\d{4}-\d{2}-\d{2})/) ?? "",
      dueDate: get(/Due Date: (\d{4}-\d{2}-\d{2})/),
      storeId: get(/Bill To: .*\(([a-z0-9-]+)\)/) ?? "",
      deliveryId: get(/Delivery: (\S+)/),
      lines,
      totalCents: parseMoney(get(/TOTAL DUE\s+([\d,]+\.\d{2})/) ?? "0"),
      remitBank: remit?.[1] ?? null,
      remitLast4: remit?.[2] ?? null,
      note: get(/^(Balance forward:.*)$/m),
    };
  },
};

const keyvalue: Parser = {
  id: "keyvalue-v1",
  origin: "builtin",
  detect: (t) => /^Vendor: /m.test(t) && /^Invoice Number: /m.test(t),
  parse: (t) => {
    const get = (re: RegExp) => re.exec(t)?.[1]?.trim() ?? null;
    const lines = [...t.matchAll(/^Item \d+: (\S+) \| (.+?) \| qty (\d+(?:\.\d+)?) \| (\$[\d,]+\.\d{2}) \| (\$[\d,]+\.\d{2})$/gm)].map((m) => ({
      sku: m[1]!,
      description: m[2]!,
      quantity: Number(m[3]),
      unitCents: parseMoney(m[4]!),
      amountCents: parseMoney(m[5]!),
    }));
    const pay = /Pay to: (.+?) account ending (\d{4})/.exec(t);
    const date = get(/Invoice Date: (\d{2}\/\d{2}\/\d{4})/);
    return {
      vendorName: get(/^Vendor: (.+)$/m) ?? "",
      invoiceNumber: get(/^Invoice Number: (\S+)$/m) ?? "",
      invoiceDate: date ? usToIso(date) : "",
      dueDate: null,
      storeId: get(/Ship To: Sweetgreen #(\S+)/) ?? "",
      deliveryId: get(/Delivery Ref: (\S+)/),
      lines,
      totalCents: parseMoney(get(/Amount Due: (\$[\d,]+\.\d{2})/) ?? "0"),
      remitBank: pay?.[1] ?? null,
      remitLast4: pay?.[2] ?? null,
      note: null,
    };
  },
};

export const BUILTIN_PARSERS: Parser[] = [columnar, keyvalue];

export interface ParserRecord {
  id: string;
  signature: string;
  description: string;
  /** Body of `function parse(text, helpers)`; must return a ParsedInvoice-shaped object. */
  code: string;
  tests: { input: string; expected: unknown }[];
  author: string;
}

/**
 * Agent-written parsers run in an isolated VM context: no require, no process, no network,
 * a 50 ms CPU budget, and their output still has to pass the schema and arithmetic checks.
 */
export function compileParser(rec: ParserRecord): Parser {
  const script = new vm.Script(`(function parse(text, helpers) {\n${rec.code}\n})`);
  const context = vm.createContext(Object.freeze({}), { codeGeneration: { strings: false, wasm: false } });
  const fn = script.runInContext(context, { timeout: 50 }) as (text: string, helpers: unknown) => unknown;
  const helpers = Object.freeze({ parseMoney });
  return {
    id: rec.id,
    origin: "memory",
    detect: (t) => layoutSignature(t) === rec.signature,
    parse: (t) => {
      const out = vm.runInContext("fn(text, helpers)", vm.createContext({ fn, text: t, helpers }), { timeout: 50 });
      return ParsedInvoice.parse(JSON.parse(JSON.stringify(out)));
    },
  };
}

export async function loadMemoryParsers(mem: MemoryStore, sha?: string): Promise<Parser[]> {
  const snapshot = sha ?? (await mem.head());
  const files = await mem.list("integrations/parsers/", snapshot);
  const parsers: Parser[] = [];
  for (const f of files) {
    const rec = await mem.read<ParserRecord>(f, snapshot);
    if (!rec) continue;
    try {
      parsers.push(compileParser(rec));
    } catch {
      // A broken parser in memory is skipped; the extraction fallback still works.
    }
  }
  return parsers;
}

export type ParseOutcome =
  | { ok: true; invoice: ParsedInvoice; parser: string; origin: Parser["origin"] }
  | { ok: false; signature: string; reason: string };

/** Deterministic parsing only. A miss tells the caller to fall back to extraction. */
export function parseWith(parsers: Parser[], text: string): ParseOutcome {
  for (const p of parsers) {
    if (!p.detect(text)) continue;
    try {
      const inv = ParsedInvoice.parse(p.parse(text));
      const problem = checkInvoiceMath(inv);
      if (problem) return { ok: false, signature: layoutSignature(text), reason: `${p.id}: ${problem}` };
      return { ok: true, invoice: inv, parser: p.id, origin: p.origin };
    } catch (e) {
      return { ok: false, signature: layoutSignature(text), reason: `${p.id} failed: ${e instanceof Error ? e.message.slice(0, 200) : e}` };
    }
  }
  return { ok: false, signature: layoutSignature(text), reason: "no parser recognizes this layout" };
}
