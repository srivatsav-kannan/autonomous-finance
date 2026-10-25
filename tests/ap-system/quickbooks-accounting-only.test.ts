import { describe, expect, it } from "vitest";
import { matches, QboClient } from "../../src/ap-system/quickbooks/client";
import type { OAuth } from "../../src/ap-system/quickbooks/oauth";
import type { Operation } from "../../src/ap-system/quickbooks/types";
const payload = {
  DocNumber: "AP" + "a".repeat(18),
  VendorRef: { value: "5" },
  APAccountRef: { value: "33" },
  TxnDate: "2026-10-25",
  PayType: "Check",
  CheckPayment: { BankAccountRef: { value: "35" }, PrintStatus: "NotSet" },
  TotalAmt: 20,
  Line: [{ Amount: 20, LinkedTxn: [{ TxnId: "1", TxnType: "Bill" }] }],
};
function protocol(actual: Record<string, unknown> = payload) {
  const calls: RequestInit[] = [];
  let access = 0;
  const client = new QboClient({
    config: { realmId: "123" },
    access: async () => {
      access++;
      return "synthetic";
    },
    transport: async (url: URL, init: RequestInit) => {
      calls.push(init);
      const row = { Id: "90", SyncToken: "0", ...actual };
      return new Response(
        JSON.stringify(
          url.pathname.endsWith("/query")
            ? { QueryResponse: { BillPayment: [row] } }
            : { BillPayment: row },
        ),
      );
    },
  } as unknown as OAuth);
  const op: Operation = {
    version: "ap-qbo-operation-v1",
    realmId: "123",
    minorVersion: 75,
    identity: "synthetic-accounting-only",
    mappingHash: "a".repeat(64),
    payloadHash: "b".repeat(64),
    state: "succeeded",
    createdAt: 1,
    updatedAt: 1,
    attempts: 1,
    lastError: null,
    responseHash: "c".repeat(64),
    links: {
      caseId: "case",
      billId: "bill",
      recognitionJournalId: "recognition",
      paymentVersionId: "version",
      commandId: "command",
      bankTransactionId: "bank",
      settlementJournalId: "settlement",
      creditId: null,
    },
    entity: "BillPayment",
    externalId: "90",
    syncToken: "0",
    requestId: "stable",
    payload,
  };
  return { client, op, calls, access: () => access };
}
describe("QBO accounting-only merchant-processing boundary", () => {
  it("rejects true and malformed processing flags before token lookup or HTTP", async () => {
    const p = protocol();
    for (const flag of [true, null, "false", 0]) {
      await expect(
        p.client.create({
          ...p.op,
          payload: { ...payload, ProcessBillPayment: flag },
        }),
      ).rejects.toThrow("merchant_processing_forbidden");
    }
    await expect(
      p.client.request("billpayment", "POST", "not-json", "stable"),
    ).rejects.toThrow("merchant_processing_forbidden");
    expect(p.access()).toBe(0);
    expect(p.calls).toHaveLength(0);
  });
  it("preserves legacy payload bytes and accepts explicitly disabled processing", async () => {
    const p = protocol({
      ...payload,
      ProcessBillPayment: false,
      MetaData: { providerAdded: true },
    });
    const saved = JSON.stringify(payload);
    await p.client.request("billpayment", "POST", saved, "stable");
    expect(p.calls[0]!.body).toBe(saved);
    expect(JSON.parse(String(p.calls[0]!.body))).not.toHaveProperty(
      "ProcessBillPayment",
    );
    await p.client.create({
      ...p.op,
      payload: { ...payload, ProcessBillPayment: false },
    });
    expect(JSON.parse(String(p.calls[1]!.body)).ProcessBillPayment).toBe(false);
    await expect(p.client.verify(p.op)).resolves.toBeDefined();
  });
  it("rejects merchant processing during read verification, recovery and initial response", async () => {
    for (const flag of [true, null, "false", 0]) {
      const p = protocol({ ...payload, ProcessBillPayment: flag });
      await expect(p.client.verify(p.op)).rejects.toThrow(
        "external_stale_or_changed",
      );
      await expect(p.client.find(p.op)).rejects.toThrow(
        "external_mapping_conflict",
      );
      await expect(p.client.create(p.op)).rejects.toThrow(
        "external_response_mismatch",
      );
    }
  });
  it("does not certify a processing request even if provider echoes it, while metadata remains additive", () => {
    expect(
      matches({ ProcessBillPayment: true }, { ProcessBillPayment: true }),
    ).toBe(false);
    expect(
      matches(payload, {
        ...payload,
        ProcessBillPayment: false,
        MetaData: { added: true },
      }),
    ).toBe(true);
  });
});
