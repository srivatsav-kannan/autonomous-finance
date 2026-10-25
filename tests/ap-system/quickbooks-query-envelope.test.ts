import { describe, it, expect } from "vitest";
import { QboClient } from "../../src/ap-system/quickbooks/client";
import type { OAuth } from "../../src/ap-system/quickbooks/oauth";
import type { Operation, Plan } from "../../src/ap-system/quickbooks/types";
const plan: Plan = {
  version: "ap-qbo-operation-v1",
  realmId: "123",
  minorVersion: 75,
  identity: "query-envelope-test",
  mappingHash: "a".repeat(64),
  entity: "JournalEntry",
  payload: { DocNumber: "AP" + "a".repeat(18) },
  links: {
    caseId: null,
    billId: null,
    recognitionJournalId: "journal",
    paymentVersionId: null,
    commandId: null,
    bankTransactionId: null,
    settlementJournalId: null,
    creditId: null,
  },
};
const op = { entity: "JournalEntry", externalId: "90" } as Operation;
function client(data: unknown) {
  return new QboClient({
    config: { realmId: "123" },
    access: async () => "mock",
    transport: async () =>
      new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      }),
  } as unknown as OAuth);
}
describe("QBO query envelopes fail closed", () => {
  it("distinguishes valid empty Intuit results from missing, invalid or unrelated query bodies", async () => {
    for (const bad of [
      { time: "no-query" },
      { QueryResponse: null },
      { QueryResponse: [] },
      { QueryResponse: "" },
      { QueryResponse: { Fault: {} } },
    ]) {
      await expect(client(bad).find(plan)).rejects.toThrow(
        "qbo_query_envelope_invalid",
      );
      await expect(client(bad).journalAppliedCents(op, "5")).rejects.toThrow(
        "qbo_query_envelope_invalid",
      );
    }
    expect(await client({ QueryResponse: {} }).find(plan)).toBeUndefined();
    expect(
      await client({ QueryResponse: {} }).journalAppliedCents(op, "5"),
    ).toBe(0);
    expect(
      await client({ QueryResponse: { BillPayment: [] } }).journalAppliedCents(
        op,
        "5",
      ),
    ).toBe(0);
  });
  it("rejects explicit null rows, invalid identities and incomplete pagination metadata", async () => {
    for (const body of [
      { JournalEntry: null },
      { JournalEntry: {} },
      { JournalEntry: [{ DocNumber: plan.payload.DocNumber }] },
      { JournalEntry: [], startPosition: 2 },
      { JournalEntry: [], totalCount: 1 },
    ])
      await expect(client({ QueryResponse: body }).find(plan)).rejects.toThrow(
        /qbo_query_envelope_invalid|qbo_query_incomplete/,
      );
    for (const body of [
      { BillPayment: null },
      { BillPayment: [{ VendorRef: { value: "5" }, Line: [] }] },
      { BillPayment: [], maxResults: -1 },
      { BillPayment: [], totalCount: 1 },
    ])
      await expect(
        client({ QueryResponse: body }).journalAppliedCents(op, "5"),
      ).rejects.toThrow(/qbo_query_envelope_invalid|qbo_query_incomplete/);
  });
  it("retains valid exact query economics for operation reconciliation and restored principal", async () => {
    const record = {
      Id: "90",
      SyncToken: "0",
      DocNumber: plan.payload.DocNumber,
    };
    expect(
      await client({
        QueryResponse: {
          JournalEntry: [record],
          startPosition: 1,
          maxResults: 1,
        },
      }).find(plan),
    ).toEqual(record);
    const payment = {
      Id: "91",
      VendorRef: { value: "5" },
      Line: [
        { Amount: 20, LinkedTxn: [{ TxnType: "JournalEntry", TxnId: "90" }] },
      ],
    };
    expect(
      await client({
        QueryResponse: { BillPayment: [payment] },
      }).journalAppliedCents(op, "5"),
    ).toBe(2000);
  });
});
