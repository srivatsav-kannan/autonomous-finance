/** Read-only access to the git-ignored APEX World 9 files. Historical source outcomes stay here, apart from new observations. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

export const APEX_SOURCE = {
  dataset: "mercor/apex-accounting-harbor",
  revision: "1662b7e4c3b04b8717f2f723df823e7b6cbe2118",
  license: "CC-BY-4.0",
  world: "worlds/world-9--(world_0645ad7c997c415e8c43f8de7cee2008)",
  label: "Synthetic company dataset authored for an accounting benchmark (Mercor/Ramp APEX-Accounting). Not a real customer's books and not Sweetgreen data.",
} as const;
export const APEX_FILES = {
  invoices: "filesystem/contract_attorney_invoices",
  apLedger: "apps_data/quickbooks/ap_bill_ledger_2024.csv",
  bank: "apps_data/quickbooks/operating_bank_transactions_2024.csv",
  vendors: "apps_data/quickbooks/vendor_master_list.xlsx",
  gl: "filesystem/qbo_general_ledger_detail_2024.xlsx",
  aging: "filesystem/ap_aging_2024_12_31.xlsx",
  statements: "filesystem/operating_bank_statements",
} as const;
export const sha256File = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** RFC 4180 subset: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter(r => r.some(Boolean));
  return body.map(r => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ""])));
}
const cellText = (v: ExcelJS.CellValue): string =>
  v === null || v === undefined ? "" : typeof v === "object" ? ("result" in v ? String(v.result) : "text" in v ? String(v.text) : v instanceof Date ? v.toISOString() : JSON.stringify(v)) : String(v);
async function sheetRows(file: string, sheet: string, headerCell: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(sheet);
  if (!ws) throw new Error(`APEX sheet missing: ${sheet}`);
  const raw: string[][] = [];
  ws.eachRow(r => raw.push((r.values as ExcelJS.CellValue[]).slice(1).map(cellText)));
  const h = raw.findIndex(r => r[0] === headerCell);
  if (h < 0) throw new Error(`APEX header missing: ${sheet}`);
  return raw.slice(h + 1).map(r => Object.fromEntries(raw[h]!.map((k, i) => [k, r[i] ?? ""])));
}

export async function loadApexWorld(root: string) {
  const file = (rel: string) => path.join(root, rel);
  const invoiceFiles = readdirSync(file(APEX_FILES.invoices)).filter(f => f.endsWith(".pdf")).sort();
  const statementFiles = readdirSync(file(APEX_FILES.statements)).filter(f => f.endsWith(".pdf")).sort();
  const hashes = Object.fromEntries([
    ...invoiceFiles.map(f => `${APEX_FILES.invoices}/${f}`),
    ...statementFiles.map(f => `${APEX_FILES.statements}/${f}`),
    APEX_FILES.apLedger, APEX_FILES.bank, APEX_FILES.vendors, APEX_FILES.gl, APEX_FILES.aging,
  ].map(rel => [rel, sha256File(file(rel))]));
  return {
    root, hashes, invoiceFiles,
    invoicePath: (name: string) => file(`${APEX_FILES.invoices}/${name}`),
    statementPath: (name: string) => file(`${APEX_FILES.statements}/${name}`),
    apLedger: parseCsv(readFileSync(file(APEX_FILES.apLedger), "utf8")),
    bank: parseCsv(readFileSync(file(APEX_FILES.bank), "utf8")),
    vendors: await sheetRows(file(APEX_FILES.vendors), "Vendor Master", "Vendor ID"),
    gl: await sheetRows(file(APEX_FILES.gl), "GL Detail", "Account #"),
    openBills: await sheetRows(file(APEX_FILES.aging), "Open Bills Detail", "Bill ID"),
  };
}
export type ApexWorld = Awaited<ReturnType<typeof loadApexWorld>>;
export const cents = (amount: string | undefined) => {
  if (amount === undefined || !/^-?\d+(\.\d{1,2})?$/.test(amount.trim())) throw new Error(`Unsupported APEX amount ${amount}`);
  const [whole, frac = ""] = amount.trim().replace("-", "").split(".");
  return (amount.trim().startsWith("-") ? -1 : 1) * (Number(whole) * 100 + Number(frac.padEnd(2, "0")));
};
/** GL amounts are stored as floats in the workbook; compare to the cent. */
export const glCents = (amount: string | undefined) => (amount?.trim() ? Math.round(Number(amount) * 100) : 0);

/** Fail closed unless a single printed transaction binds reference, date, payee and one debit amount.
 * Layouts with multiple money columns require a reviewed adapter; a page-level search is never proof. */
export function statementPaymentMatches(text:string, expected:{reference:string;date:string;payee:string;amountCents:number}) {
  const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const ref=new RegExp(`(?<![A-Za-z0-9_-])${escape(expected.reference)}(?![A-Za-z0-9_-])`);
  const [year,month,day]=expected.date.split("-");
  const dates=[expected.date,`${month}/${day}/${year}`,`${Number(month)}/${Number(day)}/${year}`];
  const rows=text.split(/\r?\n/).filter(line=>ref.test(line));
  if(rows.length!==1)return false;
  const line=rows[0]!, money=[...line.matchAll(/\$([0-9]+(?:,[0-9]{3})*\.[0-9]{2})\b/g)];
  return dates.some(date=>new RegExp(`(?<![0-9/-])${escape(date)}(?![0-9/-])`).test(line))&&line.normalize("NFC").includes(expected.payee.normalize("NFC"))&&money.length===1&&cents(money[0]![1]!.replaceAll(",",""))===expected.amountCents;
}
/** Checks a source-paid bill against the bank export, GL detail, AP aging and bank statement text. Read-only. */
export function historicalPaymentChecks(world: ApexWorld, input: { billId: string; bankTransactionId: string; reference: string; statementText: string }) {
  const bill = world.apLedger.filter(r => r.bill_id === input.billId);
  const bank = world.bank.filter(r => r.transaction_id === input.bankTransactionId);
  const b = bill[0], t = bank[0];
  const glBill = world.gl.filter(r => r["JE #"] === `JE-${input.billId}` && r["Account #"] === "2000");
  const glPayment = world.gl.filter(r => r["JE #"] === `JE-OB-${input.bankTransactionId.replace("OBT-", "")}`);
  const sameVendorAmount = b ? world.bank.filter(r => r.type === "ap_payment" && r.payor_payee === b.vendor_name && cents(r.amount_out) === cents(b.bill_amount)) : [];
  const checks = [
    { check: "Exactly one AP ledger row for the bill", passed: bill.length === 1 },
    { check: "Exactly one bank row for the candidate transaction", passed: bank.length === 1 },
    { check: "Ledger status is Paid with zero outstanding", passed: !!b && b.payment_status === "Paid" && cents(b.outstanding_balance) === 0 },
    { check: "Bank row is an AP payment to the same payee", passed: !!b && !!t && t.type === "ap_payment" && t.payor_payee === b.vendor_name },
    { check: "Bank amount out equals bill amount and amount paid", passed: !!b && !!t && cents(t.amount_out) === cents(b.bill_amount) && cents(b.amount_paid) === cents(b.bill_amount) },
    { check: "Bank date equals ledger payment date", passed: !!b && !!t && t.txn_date === b.payment_date },
    { check: "Bank reference equals the expected reference", passed: !!t && t.reference === input.reference },
    { check: "Bank row offsets AP (2000)", passed: !!t && t.gl_offset_account === "2000 AP" },
    { check: "GL has one AP credit for the bill", passed: glBill.length === 1 && glCents(glBill[0]!.Credit) === (b ? cents(b.bill_amount) : -1) },
    { check: "GL payment entry debits AP and credits operating cash by the bill amount", passed: glPayment.some(r => r["Account #"] === "2000" && glCents(r.Debit) === (b ? cents(b.bill_amount) : -1)) && glPayment.some(r => r["Account #"] === "1000" && glCents(r.Credit) === (b ? cents(b.bill_amount) : -1)) },
    { check: "Bill is absent from the Dec 31, 2024 AP aging open bills", passed: !world.openBills.some(r => r["Bill ID"] === input.billId) },
    { check: "Exactly one statement transaction binds reference, date, payee and debit amount", passed: !!b && !!t && statementPaymentMatches(input.statementText,{reference:input.reference,date:t.txn_date!,payee:b.vendor_name!,amountCents:cents(b.bill_amount)}) },
  ];
  return {
    billId: input.billId, bankTransactionId: input.bankTransactionId, reference: input.reference, checks,
    passed: checks.every(c => c.passed),
    ledger: b ? { vendorId: b.vendorref_value, vendor: b.vendor_name, invoiceNumber: b.docnumber, billDate: b.txndate, dueDate: b.due_date, amount: b.bill_amount, status: b.payment_status, paymentDate: b.payment_date, amountPaid: b.amount_paid, outstanding: b.outstanding_balance, glAccount: `${b.gl_account_number} ${b.gl_account_name}`, matter: b.matter_number } : null,
    bank: t ? { transactionId: t.transaction_id, date: t.txn_date, clearDate: t.clear_date, type: t.type, payee: t.payor_payee, reference: t.reference, amountOut: t.amount_out, glOffset: t.gl_offset_account, source: t.payment_source } : null,
    glEntries: [...glBill, ...glPayment].map(r => ({ account: r["Account #"], date: r.Date, je: r["JE #"], debit: r.Debit, credit: r.Credit })),
    sameVendorSameAmountPayments: sameVendorAmount.map(r => ({ transactionId: r.transaction_id, date: r.txn_date, reference: r.reference })),
    limits: "These are field matches inside one synthetic dataset. They are consistent with one payment of this bill. They do not independently prove the invoice-to-bank link.",
  };
}
