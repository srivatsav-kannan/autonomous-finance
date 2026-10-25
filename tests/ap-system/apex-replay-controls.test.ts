import { describe, expect, it } from "vitest";
import { historicalPaymentChecks, statementPaymentMatches, withApexHistoricalPaymentHold, APEX_FILES, type ApexWorld } from "../../src/ap-system/replay/apex-sources";
import { assertMissingServiceEvidence } from "../../src/ap-system/replay/assertions";
import { packet } from "./accounting-fixture";

const row = "04/19    CHECK - MARCUS AVILA, ESQ.    CHK-2024327    $3,500.00    $465,666.57";
const match = (text: string) => statementPaymentMatches(text, "CHK-2024327", "2024-04-19", "Marcus Avila, Esq.", 350000);
const world = { apLedger: [{ bill_id: "BILL-2024-00327", payment_status: "Paid", outstanding_balance: "0", vendor_name: "Marcus Avila, Esq.", bill_amount: "3500", amount_paid: "3500", payment_date: "2024-04-19" }],
  bank: [{ transaction_id: "OBT-000200", type: "ap_payment", payor_payee: "Marcus Avila, Esq.", amount_out: "3500", txn_date: "2024-04-19", reference: "CHK-2024327", gl_offset_account: "2000 AP" }],
  gl: [{ "JE #": "JE-BILL-2024-00327", "Account #": "2000", Credit: "3500" }, { "JE #": "JE-OB-000200", "Account #": "2000", Debit: "3500" }, { "JE #": "JE-OB-000200", "Account #": "1000", Credit: "3500" }], openBills: [], hashes: { [APEX_FILES.apLedger]: "a".repeat(64) } } as unknown as ApexWorld;

describe("historical statement transaction matching", () => {
  it("matches the debit on exactly one dated check row", () => expect(match(row)).toBe(true));
  it.each([
    row.replace("$3,500.00", "$1.00") + "\n04/20    OTHER    OTHER-REF    $3,500.00",
    row + "\n" + row, row.replace("CHK-2024327", "CHK-20243270"), row.replace("04/19", "04/20"),
    row.replace("MARCUS AVILA", "OTHER VENDOR"), row.replace("CHECK", "DEPOSIT"),
    row.replace("$3,500.00    $465,666.57", "$1.00    $3,500.00"),
    row.replace("$3,500.00", "\n$3,500.00"),
  ])("rejects unrelated, ambiguous or malformed statement evidence: %s", text => expect(match(text)).toBe(false));
  it("cannot report all 12 checks passed on the cross-row false positive", () => {
    const check = (statementText: string) => historicalPaymentChecks(world, { billId: "BILL-2024-00327", bankTransactionId: "OBT-000200", reference: "CHK-2024327", statementText });
    expect(check(row).passed).toBe(true);
    const bad = check(row.replace("$3,500.00", "$1.00") + "\nOTHER TRANSACTION $3,500.00");
    expect(bad.passed).toBe(false); expect(bad.checks.filter(c => c.passed)).toHaveLength(11);
  });
});

it("adds a source-bound restriction after parsing a paid invoice but leaves an open invoice untouched", () => {
  const input = packet(), c = input.candidate!;
  const source = { ...world, apLedger: [{ ...world.apLedger[0]!, docnumber: c.invoiceNumber, vendor_name: c.extractedSupplierName, bill_amount: "77", amount_paid: "77" }] };
  const held = withApexHistoricalPaymentHold(input, source);
  expect(held.historicalPaymentHold).toMatchObject({ invoiceNumber: c.invoiceNumber, supplierId: c.supplierId, amountCents: 7700, invoiceSourceSha256: input.documents[0]!.sha256 });
  expect(held.candidate).toEqual(input.candidate);
  expect(withApexHistoricalPaymentHold(input, { ...source, apLedger: source.apLedger.map(r => ({ ...r, payment_status: "Open" })) })).toBe(input);
  expect(() => withApexHistoricalPaymentHold(input, { ...source, apLedger: [...source.apLedger, ...source.apLedger] })).toThrow(/ambiguous/);
  expect(() => withApexHistoricalPaymentHold(input, { ...source, apLedger: source.apLedger.map(r => ({ ...r, amount_paid: "1" })) })).toThrow(/ambiguous/);
});

describe("missing service evidence rehearsal", () => {
  const good = { status: 409, body: { error: { code: "business_policy_hold", reason: "missing_contract: Agreement required; missing_receipt: Acceptance required" } } };
  const unposted = { journals: [], links: { billId: null } } as any;
  it("accepts only the explicit pair of policy holds with no recognition", () => expect(() => assertMissingServiceEvidence(good, unposted)).not.toThrow());
  it.each([
    { ...good, status: 500 }, { ...good, status: 200 },
    { status: 409, body: { error: { code: "backend_rejected", reason: "missing_contract: missing_receipt:" } } },
    { status: 409, body: { error: { code: "business_policy_hold", reason: "missing_contract: Agreement required" } } },
    { status: 409, body: { error: { code: "business_policy_hold", reason: "missing_receipt: Acceptance required" } } },
  ])("refuses unrelated failures or incomplete hold evidence", response => expect(() => assertMissingServiceEvidence(response, unposted)).toThrow());
  it("refuses a policy rejection if recognition occurred", () => {
    expect(() => assertMissingServiceEvidence(good, { ...unposted, journals: [{}] })).toThrow();
    expect(() => assertMissingServiceEvidence(good, { ...unposted, links: { billId: "bill" } })).toThrow();
  });
});
