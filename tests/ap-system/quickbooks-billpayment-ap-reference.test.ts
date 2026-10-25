import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QboClient } from "../../src/ap-system/quickbooks/client";
import type { OAuth } from "../../src/ap-system/quickbooks/oauth";
import { PrivateStore, QboError, hash } from "../../src/ap-system/quickbooks/private-store";
import { SyncJournal } from "../../src/ap-system/quickbooks/sync";
import type { Mappings, Operation, Plan } from "../../src/ap-system/quickbooks/types";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const mappings: Mappings = { version: "operator-reviewed-v1", realmId: "123", country: "US", vendors: { supplier: { id: "5", displayName: "Supplier" } }, accounts: { "2000": { id: "33", name: "AP", type: "Accounts Payable" }, "1000": { id: "35", name: "Bank", type: "Bank" } }, apAccount: "2000", bankAccount: "1000" };
function fixture() {
  const plan: Plan = { version: "ap-qbo-operation-v1", realmId: "123", minorVersion: 75, entity: "BillPayment", identity: "BillPayment:org:run:payment:debit", mappingHash: hash(mappings), links: { caseId: "case", billId: "bill", recognitionJournalId: "recognition", paymentVersionId: "payment", commandId: "command", bankTransactionId: "debit", settlementJournalId: "settlement", creditId: null }, payload: { DocNumber: "AP" + "a".repeat(18), PrivateNote: "ap-sync:test", APAccountRef: { value: "33" }, VendorRef: { value: "5" }, CurrencyRef: { value: "USD" }, TxnDate: "2026-10-25", PayType: "Check", CheckPayment: { BankAccountRef: { value: "35" }, PrintStatus: "NotSet" }, TotalAmt: 678.6, Line: [{ Amount: 678.6, LinkedTxn: [{ TxnType: "Bill", TxnId: "145" }] }] } };
  const op: Operation = { ...plan, requestId: `ap-${hash({ realm: plan.realmId, identity: plan.identity }).slice(0, 44)}`, payloadHash: hash(plan), state: "unknown", createdAt: Date.now(), updatedAt: Date.now(), attempts: 1, externalId: null, syncToken: null, lastError: "external_response_mismatch", responseHash: null };
  const { APAccountRef: omitted, ...payload } = structuredClone(plan.payload);
  const actual: Record<string, any> = { ...payload, Id: "146", SyncToken: "0" };
  const bill: Record<string, any> = { Id: "145", SyncToken: "1", Balance: 0, APAccountRef: { value: "33" }, VendorRef: { value: "5" }, CurrencyRef: { value: "USD" } };
  const client = new QboClient({ config: { realmId: "123" } } as OAuth);
  const request = vi.spyOn(client, "request").mockImplementation(async (path, method) => {
    if (path === "query") return { QueryResponse: { BillPayment: [actual], startPosition: 1, maxResults: 1 } };
    if (path === "bill/145") return { Bill: bill };
    if (path === "billpayment/146" || (path === "billpayment" && method === "POST")) return { BillPayment: actual };
    throw new Error("Unexpected request");
  });
  return { plan, op, actual, bill, client, request };
}
describe("QBO BillPayment optional AP account response", () => {
  it("accepts create, lookup and readback only after the linked paid bill proves the AP account", async () => {
    const f = fixture();
    expect(await f.client.create(f.op)).toEqual(f.actual);
    expect(await f.client.find(f.plan)).toEqual(f.actual);
    expect(await f.client.verify({ ...f.op, externalId: "146", syncToken: "0" })).toEqual(f.actual);
    expect(f.request.mock.calls.filter(([path]) => path === "bill/145")).toHaveLength(3);
  });
  it.each(["missing AP", "different AP", "different vendor", "different currency"])("rejects %s on the linked bill", async mode => {
    const f = fixture();
    if (mode === "missing AP") delete f.bill.APAccountRef;
    if (mode === "different AP") f.bill.APAccountRef = { value: "34" };
    if (mode === "different vendor") f.bill.VendorRef = { value: "6" };
    if (mode === "different currency") f.bill.CurrencyRef = { value: "EUR" };
    await expect(f.client.create(f.op)).rejects.toThrow("external_response_mismatch");
    await expect(f.client.find(f.plan)).rejects.toThrow("external_mapping_conflict");
  });
  it("never ignores a present conflicting AP account or a changed payment amount/bank/link", async () => {
    for (const change of [
      (r: any) => { r.APAccountRef = { value: "34" }; },
      (r: any) => { r.TotalAmt = 1; },
      (r: any) => { r.CheckPayment.BankAccountRef.value = "36"; },
      (r: any) => { r.Line[0].LinkedTxn[0].TxnId = "144"; },
      (r: any) => { r.ClassRef = { value: "9" }; },
    ]) {
      const f = fixture(); change(f.actual);
      await expect(f.client.create(f.op)).rejects.toThrow("external_response_mismatch");
      expect(f.request.mock.calls.some(([path]) => path === "bill/145")).toBe(false);
    }
  });
  it("fails closed for unsupported JournalEntry links instead of inventing an AP proof", async () => {
    const f = fixture(); (f.plan.payload.Line as any[])[0].LinkedTxn[0].TxnType = "JournalEntry";
    f.actual.Line[0].LinkedTxn[0].TxnType = "JournalEntry";
    await expect(f.client.create(f.op)).rejects.toThrow("external_response_mismatch");
  });
  it("requires every linked payable to prove the same AP, vendor and currency", async () => {
    const f = fixture();
    const creditLink = { TxnType: "VendorCredit", TxnId: "147" };
    (f.plan.payload.Line as any[])[0].LinkedTxn.push(creditLink);
    f.actual.Line[0].LinkedTxn.push(creditLink);
    const credit: Record<string, any> = { ...f.bill, Id: "147" };
    const previous = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => args[0] === "vendorcredit/147" ? { VendorCredit: credit } : previous(...args));
    expect(await f.client.verify({ ...f.op, externalId: "146", syncToken: "0" })).toEqual(f.actual);
    credit.APAccountRef = { value: "34" };
    await expect(f.client.verify({ ...f.op, externalId: "146", syncToken: "0" })).rejects.toThrow("external_stale_or_changed");
  });
  it("preserves stale-token rejection even when linked accounting agrees", async () => {
    const f = fixture(); f.actual.SyncToken = "1";
    await expect(f.client.verify({ ...f.op, externalId: "146", syncToken: "0" })).rejects.toThrow("external_stale_or_changed");
    expect(f.request.mock.calls.some(([path]) => path === "bill/145")).toBe(false);
  });
  it("keeps a successful POST unknown if its linked-bill proof fails, and never reposts it", async () => {
    const f = fixture(), root = await mkdtemp(join(tmpdir(), "qbo-ap-proof-")); roots.push(root);
    const journal = new SyncJournal(new PrivateStore(root), f.client);
    vi.spyOn(f.client, "verifyMappings").mockResolvedValue({ realmId: "123", country: "US", mappingHash: hash(mappings) });
    let sent = false, readable = false;
    const previous = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[0] === "query" && !sent) return { QueryResponse: {} };
      if (args[0] === "billpayment" && args[1] === "POST") sent = true;
      if (args[0] === "bill/145" && !readable) throw new QboError("qbo_retry_later");
      return previous(...args);
    });
    await expect(journal.execute(f.plan, mappings, undefined, { subject: "reviewer", planHash: hash(f.plan), decidedAt: Date.now() })).rejects.toThrow("external_response_unverified");
    expect(await journal.get(f.plan)).toMatchObject({ state: "unknown", attempts: 1 });
    await expect(journal.execute(f.plan, mappings)).rejects.toThrow("qbo_retry_later");
    expect(await journal.get(f.plan)).toMatchObject({ state: "unknown", attempts: 1 });
    readable = true;
    expect(await journal.execute(f.plan, mappings)).toMatchObject({ state: "succeeded", externalId: "146", attempts: 1 });
    expect(f.request.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
  });
  it("reconciles an unknown operation by read-only lookup, preserving its one POST attempt and authorization", async () => {
    const f = fixture(), root = await mkdtemp(join(tmpdir(), "qbo-ap-reference-")); roots.push(root);
    const store = new PrivateStore(root), journal = new SyncJournal(store, f.client);
    f.op.submissionAuthorization = { subject: "original-human", planHash: f.op.payloadHash, decidedAt: f.op.createdAt };
    await store.write(journal.key(f.plan), f.op);
    const beforeWrite = vi.fn();
    const recovered = await journal.execute(f.plan, mappings, beforeWrite);
    expect(recovered).toMatchObject({ state: "succeeded", externalId: "146", syncToken: "0", attempts: 1, requestId: f.op.requestId, submissionAuthorization: f.op.submissionAuthorization });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(f.request.mock.calls.every(([, method]) => method === "GET")).toBe(true);
    expect(await journal.execute(f.plan, mappings)).toMatchObject({ state: "succeeded", externalId: "146", attempts: 1 });
  });
});
