import { describe, expect, it } from "vitest";
import { emptyUsage } from "../../agents/llm";
import { customerRows, moneyCents, scoreInvoiceSandbox } from "./invoice-sandbox";
import { gradeAnswer } from "./score";
import type { BenchmarkTask, CustomerTotals, Gold } from "./types";

const row = (net: string, count = "1"): CustomerTotals => ({ customer_name: "x", valid_invoice_count: count, gross_invoice_spend_usd: net, credit_memo_total_usd: "0.00", net_spend_usd: net });
const key: Record<string, CustomerTotals> = { C001: row("100.00"), C002: row("250.50", "2"), C003: row("0.00", "0") };
const header = "customer_id,customer_name,valid_invoice_count,gross_invoice_spend_usd,credit_memo_total_usd,net_spend_usd";
const answer = (...rows: string[]) => ["CUSTOMER TOTALS", header, ...rows, "", "EXCLUDED OR SUSPICIOUS DOCUMENTS", "path,document_id,customer_id,category,treatment,reason", 'invoices/x.pdf,X,C001,void,excluded_from_spend,"Void, do not count"'].join("\n");

describe("Invoice Sandbox official metric", () => {
  it("scores the share of CRM customers whose net spend is within $0.01", () => {
    const result = scoreInvoiceSandbox(answer("C001,A,1,100.00,0.00,100.00", "C002,B,2,250.50,0.00,250.51", "C003,C,0,0.00,0.00,0.00"), key);
    expect(result).toMatchObject({ score: 1, passed: true });
    const off = scoreInvoiceSandbox(answer("C001,A,1,100.00,0.00,100.02", "C002,B,2,250.50,0.00,250.50", "C003,C,0,0.00,0.00,0.00"), key);
    expect(off.score).toBeCloseTo(2 / 3);
    expect(off.passed).toBe(false);
    expect(off.metrics).toMatchObject({ customers_exact: 2, total_absolute_error_usd: "0.02" });
  });
  it("counts missing customers as misses with their full net as error and ignores unexpected ones", () => {
    const result = scoreInvoiceSandbox(answer("C001,A,1,100.00,0.00,100.00", "C999,Z,1,5.00,0.00,5.00", "C003,C,0,0.00,0.00,0.00"), key);
    expect(result.metrics).toMatchObject({ customers_exact: 2, missing_customers: ["C002"], unexpected_customers: ["C999"], total_absolute_error_usd: "250.50" });
  });
  it("accepts $ and thousands separators, quoted cells, a code fence and a plain CSV file", () => {
    const fenced = "```csv\n" + [header, 'C001,"Aster, North",1,"$100.00",0.00,"$100.00"', "C002,B,2,250.50,0.00,\"$250.50\"", "C003,C,0,0,0,0"].join("\n") + "\n```";
    expect(scoreInvoiceSandbox(fenced, key).passed).toBe(true);
    expect(customerRows([header, 'C001,"Aster, North",1,1,0,1'].join("\n"))!.get("C001")!.customer_name).toBe("Aster, North");
  });
  it("fails the whole answer when a money value is unparseable, as the official scorer exits", () => {
    const result = scoreInvoiceSandbox(answer("C001,A,1,100.00,0.00,about 100", "C002,B,2,250.50,0.00,250.50", "C003,C,0,0.00,0.00,0.00"), key);
    expect(result).toMatchObject({ score: 0, passed: false });
    expect(result.reason).toContain("Invalid money value for C001");
    expect(scoreInvoiceSandbox("Net spend looks fine overall.", key)).toMatchObject({ score: 0, passed: false });
  });
  it("quantizes like Decimal with half-even rounding", () => {
    expect([moneyCents("1.005"), moneyCents("1.015"), moneyCents("-2.675"), moneyCents("$1,234.5"), moneyCents("7."), moneyCents(""), moneyCents("1e3")]).toEqual([100, 102, -268, 123450, 700, null, null]);
  });
  it("is wired into gradeAnswer with field diagnostics", async () => {
    const gold: Gold = { kind: "customer-net-spend", answer: "", customers: key };
    const grade = await gradeAnswer({ id: "invoice-sandbox-net-spend" } as BenchmarkTask, { status: "answered", answer: answer("C001,A,1,100.00,0.00,100.00", "C002,B,2,250.50,0.00,250.50", "C003,C,0,0.00,0.00,0.00"), usage: emptyUsage(), trace: [] }, gold, false);
    expect(grade).toMatchObject({ status: "graded", score: 1, passed: true, method: "invoice-sandbox-official-v1" });
    expect(grade.metrics?.field_exact).toEqual({ valid_invoice_count: 3, gross_invoice_spend_usd: 3, credit_memo_total_usd: 3, net_spend_usd: 3 });
  });
});
