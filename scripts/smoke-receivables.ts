// End-to-end receivables smoke against the local Convex backend, with a fake Anthropic API on localhost,
// so the Claude path (extraction -> parser written -> controller review -> merge -> deferred documents
// resume) runs for free. Synthetic documents only: nothing from any benchmark.
//   npx tsx scripts/smoke-receivables.ts
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// The parser the fake model "writes", and the transcription the fake model "extracts" (same logic).
const PARSER_BODY = `
const get = (label) => { const m = new RegExp("^" + label + ":\\\\s*(.+)$", "m").exec(text); return m ? m[1].trim() : null; };
const header = text.split("\\n").find((l) => l.includes("|")) || "";
const titleLine = text.split("\\n").find((l) => /^(INVOICE|CREDIT MEMO|CUSTOMER STATEMENT)\\b/.test(l)) || "";
const lines = [];
const re = /^(\\S+) \\| (.+?) \\| (-?[\\d.]+) \\| (\\S+) \\| (\\S+)$/gm;
let m;
while ((m = re.exec(text))) lines.push({ sku: m[1], description: m[2], quantity: Number(m[3]), unitCents: helpers.parseMoney(m[4]), amountCents: helpers.parseMoney(m[5]) });
return {
  issuerName: header.split("|")[0].trim(),
  documentTitle: titleLine.replace(/\\s+\\S+$/, "").trim(),
  documentNumber: (header.split("|")[2] || "").trim(),
  customerName: get("Customer"),
  customerId: get("Customer ID"),
  documentDate: get("Date"),
  dueDate: get("Due"),
  printedStatus: get("Status"),
  lines,
  subtotalCents: helpers.parseMoney(get("Subtotal")),
  discountCents: helpers.parseMoney(get("Discount")),
  taxCents: helpers.parseMoney(get("Tax")),
  totalCents: helpers.parseMoney(get("Total")),
  notes: get("Notes"),
};`;

let calls = { extract: 0, codegen: 0 };
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body || "{}") as { system?: { text: string }[]; messages?: { content: string }[] };
  const system = request.system?.[0]?.text ?? "";
  const { parseMoney } = await import("../src/core/money");
  let output: unknown;
  if (system.startsWith("You write parsers for customer billing documents")) {
    calls.codegen++;
    output = { description: "label: value layout with pipe-separated line table", code: PARSER_BODY };
  } else if (system.startsWith("You transcribe customer billing documents")) {
    calls.extract++;
    output = new Function("text", "helpers", PARSER_BODY)(String(request.messages?.[0]?.content ?? ""), { parseMoney });
  } else {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "smoke fake: unexpected request" } }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: `msg_fake_${Date.now()}`, type: "message", role: "assistant", model: "claude-opus-5-5",
    content: [{ type: "text", text: JSON.stringify(output) }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-receivables-"));
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  ANTHROPIC_API_KEY: "fake-key-for-local-smoke",
  AGENT_FALLBACKS: "0",
  AGENT_LLM: "on",
  INVOICE_SANDBOX_LEDGER: path.join(tmp, "ledger.jsonl"),
});

// Synthetic workspace: PDFs are represented by their extracted text in the text cache.
const ws = path.join(tmp, "workspace");
const cache = path.join(tmp, "text_cache");
const write = (rel: string, text: string, pdf = false) => {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), pdf ? "%PDF-1.4 placeholder" : text);
  if (pdf) {
    fs.mkdirSync(path.dirname(path.join(cache, `${rel}.txt`)), { recursive: true });
    fs.writeFileSync(path.join(cache, `${rel}.txt`), text);
  }
};
const doc = (o: { title: string; number: string; cid: string; name: string; status: string; lines: [string, string, number, string, string][]; sub: string; disc?: string; tax?: string; total: string; date?: string }) =>
  [`=== Page 1 of 2 ===`, `Acme Billing Co | ${o.cid} | ${o.number}`, `${o.title} ${o.number}`, `Customer: ${o.name}`, `Customer ID: ${o.cid}`, `Date: ${o.date ?? "2025-04-01"}`, `Due: 2025-05-01`, `Status: ${o.status}`,
    ...o.lines.map((l) => l.join(" | ")), `Subtotal: ${o.sub}`, `Discount: ${o.disc ?? "$0.00"}`, `Tax: ${o.tax ?? "$0.00"}`, `Total: ${o.total}`, ``, `=== Page 2 of 2 ===`, `Service log (backup)`].join("\n");

write("crm/customer_master.csv", "customer_id,customer_name,aliases,email_domain\nC100,Blue Harbor,BH|Blue Harbor Co,blueharbor.example\nC200,Red Pine,RP,redpine.example\n");
write("invoices/cm-1.pdf", doc({ title: "CREDIT MEMO", number: "CM-1", cid: "C100", name: "Blue Harbor", status: "CREDIT", lines: [["CREDIT", "Credit for duplicate hours", 1, "$-100.00", "$-100.00"]], sub: "$-100.00", total: "$-100.00" }), true);
write("invoices/inv-1.pdf", doc({ title: "INVOICE", number: "INV-1", cid: "C100", name: "Blue Harbor", status: "OPEN", lines: [["SVC-A", "Setup", 1, "$1000.00", "$1000.00"]], sub: "$1000.00", tax: "$60.00", total: "$1060.00" }), true);
write("invoices/inv-1-copy.pdf", doc({ title: "INVOICE", number: "INV-1", cid: "C100", name: "Blue Harbor", status: "OPEN", lines: [["SVC-A", "Setup", 1, "$1000.00", "$1000.00"]], sub: "$1000.00", tax: "$60.00", total: "$1060.00" }), true);
write("invoices/inv-1-scan.pdf", doc({ title: "INVOICE", number: "INV-1", cid: "C100", name: "Blue Harbor", status: "DUPLICATE_SCAN", lines: [["SVC-A", "Setup", 1, "$1000.00", "$1000.00"]], sub: "$1000.00", tax: "$60.00", total: "$1060.00" }), true);
write("invoices/inv-2.pdf", doc({ title: "INVOICE", number: "INV-2", cid: "C100", name: "BH", status: "PAID", lines: [["SVC-B", "Travel", 3, "$100.00", "$250.00"]], sub: "$250.00", total: "$250.00" }), true);
write("invoices/inv-3-void.pdf", doc({ title: "INVOICE", number: "INV-3", cid: "C200", name: "Red Pine", status: "VOID", lines: [["SVC-A", "Setup", 1, "$700.00", "$700.00"]], sub: "$700.00", total: "$700.00" }), true);
write("invoices/inv-4.pdf", doc({ title: "INVOICE", number: "INV-4", cid: "C200", name: "Red Pine", status: "SUPERSEDED", lines: [["SVC-A", "Setup", 1, "$450.00", "$450.00"]], sub: "$450.00", total: "$450.00" }), true);
write("invoices/inv-4-r1.pdf", doc({ title: "INVOICE", number: "INV-4-R1", cid: "C200", name: "Red Pine", status: "OPEN", lines: [["SVC-A", "Setup", 1, "$500.00", "$500.00"]], sub: "$500.00", total: "$500.00" }), true);
write("invoices/inv-5.pdf", doc({ title: "INVOICE", number: "INV-5", cid: "C200", name: "Red Pine", status: "OPEN", lines: [["SVC-C", "Support", 1, "$280.00", "$280.00"]], sub: "$280.00", total: "$280.00" }), true);
write("invoices/inv-5-r1.pdf", doc({ title: "INVOICE", number: "INV-5-R1", cid: "C200", name: "Red Pine", status: "OPEN", lines: [["SVC-C", "Support", 1, "$300.00", "$300.00"]], sub: "$300.00", total: "$300.00", date: "2025-04-03" }), true);
write("invoices/inv-6.pdf", doc({ title: "INVOICE", number: "INV-6", cid: "C100", name: "Blue Harbor", status: "DISPUTED", lines: [["SVC-A", "Setup", 1, "$90.00", "$90.00"]], sub: "$90.00", total: "$90.00" }), true);
write("invoices/stmt-q1.pdf", doc({ title: "CUSTOMER STATEMENT", number: "STMT-Q1", cid: "C100", name: "Blue Harbor", status: "STATEMENT", lines: [["STATEMENT", "Balance summary", 1, "$1210.00", "$1210.00"]], sub: "$1210.00", total: "$1210.00" }), true);
write("email/eml/001.eml", "From: billing@acme.example\nSubject: Invoice INV-1\n\nAttached is INV-1 for $1,060.00.\n");
write("email/eml/002.eml", "From: ops@acme.example\nSubject: Please pay\n\nPlease pay INV-9 total $4,000.00 by Friday.\n");
write("bank_exports/deposits.csv", "date,payer,memo,amount\n2025-04-20,Blue Harbor,INV-1,1060.00\n");
write("notes/close.txt", "Close notes: nothing unusual.\n");

const { Workspace } = await import("../evals/external/invoice-sandbox/lib/workspace");
const { runSystemC } = await import("../evals/external/invoice-sandbox/system-c");
const { api, convex } = await import("../src/core/kernel-client");
const out = path.join(tmp, "out");
const r = await runSystemC({ runId: `smoke-${Date.now().toString(36)}`, ws: new Workspace(ws, cache), outDir: out, runCapUsd: 1, timeoutMs: 5 * 60_000 });
server.close();

const sub = JSON.parse(fs.readFileSync(path.join(out, "submission.json"), "utf8")) as { customers: Record<string, string | number>[]; suspicious_documents: { path: string; category: string; treatment: string }[] };
const docs = await convex().query(api.receivables.dispositions, { runId: r.kernel_run_id });
const byPath = Object.fromEntries(docs.map((d) => [d.path, `${d.category}/${d.treatment}`]));
const expect = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) process.exitCode = 1;
};
const c = (id: string) => sub.customers.find((x) => x.customer_id === id);
expect("C100 totals", [c("C100")?.valid_invoice_count, c("C100")?.gross_invoice_spend_usd, c("C100")?.credit_memo_total_usd, c("C100")?.net_spend_usd], [2, "1310.00", "100.00", "1210.00"]);
expect("C200 totals", [c("C200")?.valid_invoice_count, c("C200")?.gross_invoice_spend_usd, c("C200")?.net_spend_usd], [2, "800.00", "800.00"]);
// Whichever copy of INV-1 is processed first counts; the kernel refuses the other.
expect("one copy of INV-1 counted, the other refused", [byPath["invoices/inv-1.pdf"], byPath["invoices/inv-1-copy.pdf"]].sort(), ["counted/counted", "duplicate_scan/excluded_from_spend"]);
expect("duplicate scan", byPath["invoices/inv-1-scan.pdf"], "duplicate_scan/excluded_from_spend");
expect("line-math invoice", byPath["invoices/inv-2.pdf"], "data_quality/counted_with_flag");
expect("void", byPath["invoices/inv-3-void.pdf"], "void/excluded_from_spend");
expect("superseded (marked)", byPath["invoices/inv-4.pdf"], "superseded_original/excluded_from_spend");
expect("superseded (unmarked)", byPath["invoices/inv-5.pdf"], "superseded_original/excluded_from_spend");
expect("unknown status held", byPath["invoices/inv-6.pdf"], "other/held");
expect("statement", byPath["invoices/stmt-q1.pdf"], "statement_summary/excluded_from_spend");
expect("credit memo", byPath["invoices/cm-1.pdf"], "credit_memo/subtracted_as_credit");
expect("email reference", byPath["email/eml/001.eml"], "reference_only/excluded_from_spend");
expect("email quoting a missing invoice", byPath["email/eml/002.eml"], "email_quoted_total/excluded_from_spend");
expect("bank export", byPath["bank_exports/deposits.csv"], "bank_deposit/excluded_from_spend");
expect("every document has a disposition", r.undisposed_documents, 0);
expect("parsers learned", r.parsers_learned, 1);
expect("Claude calls (1 extraction + 1 parser)", [calls.extract, calls.codegen], [1, 1]);
console.log(`\n${r.tasks} agent tasks, ${r.llm_tasks} used the (fake) model, ${r.kernel_blocks} kernel blocks, ${r.memory_commits} memory commits, ${(r.wall_ms / 1000).toFixed(0)} s`);
