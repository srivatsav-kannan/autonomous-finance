import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import fixtures from "../fixtures/increase/lifecycle.json";
import provenance from "../fixtures/increase/provenance.json";
import { buildIncreaseRequestBody, commandRequestHash, type BankCommand, type BankScope } from "../contracts.js";
import { IncreaseSandboxBank, increaseRequestBody, verifyIncreaseWebhook } from "./increase.js";
import { IncreaseSandboxHarness, sandboxConfiguration } from "../../../scripts/testing/increase-sandbox-harness.js";

const scope: BankScope = { organizationId: "org", runId: "run", provider: "increase", environment: "sandbox", accountId: "account_demo" };
async function command(): Promise<BankCommand> {
  const c: BankCommand = { scope, commandId: "cmd_demo", amountCents: 2500, currency: "USD" as const, destination: { externalAccountId: "external_account_vendor", version: "v1" }, approvalVersion: "approved-v1", idempotencyKey: "ap-demo-key-1", requestHash: "" };
  c.providerRequest = buildIncreaseRequestBody(c);
  c.requestHash = await commandRequestHash(c);
  return c;
}
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
async function bank(routes: Record<string, unknown>, overrides: { fetch?: typeof fetch } = {}) {
  const saved = await command();
  const http = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const body = routes[url.pathname];
    return body === undefined ? response({ status: 404 }, 404) : response(body);
  });
  return { saved, http, provider: new IncreaseSandboxBank({ scope, apiKey: "test-private-key", resolveCommand: async key => key === saved.idempotencyKey ? saved : null, fetch: overrides.fetch ?? http }) };
}

describe("Increase sandbox adapter contracts", () => {
  it("preserves exact sandbox-prefixed identities through submission and read-only recovery", async () => {
    const scoped={...scope,accountId:"sandbox_account_fixture"};
    const saved=await command();saved.scope=scoped;saved.destination={...saved.destination,externalAccountId:"sandbox_external_account_fixture"};
    saved.providerRequest=buildIncreaseRequestBody(saved);saved.requestHash=await commandRequestHash(saved);
    const transfer={...fixtures.pending,id:"sandbox_ach_transfer_fixture",account_id:scoped.accountId,external_account_id:saved.destination.externalAccountId};
    const http=vi.fn<typeof fetch>(async()=>response(transfer));
    const provider=new IncreaseSandboxBank({scope:scoped,apiKey:"synthetic",resolveCommand:async()=>saved,fetch:http});
    expect(await provider.createTransfer(saved)).toMatchObject({id:transfer.id,scope:scoped,destination:saved.destination});
    expect(http.mock.calls[0]?.[1]?.body).toBe(saved.providerRequest);
    expect(await provider.lookupTransfer(saved,transfer.id)).toMatchObject({kind:"found",observation:{id:transfer.id}});
    expect(http.mock.calls.map(([url])=>new URL(String(url)).origin)).toEqual(["https://sandbox.increase.com","https://sandbox.increase.com"]);
    for(const id of ["sandbox_ach_transfer_fixture/other","sandbox_ach_transfer_fixture?key=1","sandbox_ach_transfer_fixture%2fother","sandbox_transaction_fixture"]){
      await expect(provider.getTransfer(scoped,id)).rejects.toThrow();
    }
    expect(http).toHaveBeenCalledTimes(2);
    expect(()=>new IncreaseSandboxBank({scope:{...scoped,environment:"production"} as unknown as BankScope,apiKey:"synthetic",resolveCommand:async()=>saved,fetch:http})).toThrow();
  });
  it("verifies sandbox-prefixed signed events without accepting altered signatures", () => {
    const event={id:"sandbox_event_fixture",type:"event",associated_object_id:"sandbox_ach_transfer_fixture",associated_object_type:"ach_transfer",category:"ach_transfer.updated",created_at:"2026-10-25T00:00:00Z"};
    const rawBody=Buffer.from(JSON.stringify(event)),timestamp="1792886400",secret="fixture-only-secret";
    const signature=createHmac("sha256",secret).update(`${event.id}.${timestamp}.`).update(rawBody).digest("base64");
    const headers={"webhook-id":event.id,"webhook-timestamp":timestamp,"webhook-signature":`v1,${signature}`};
    expect(verifyIncreaseWebhook({rawBody,headers,scope,signingSecret:secret,now:Number(timestamp)*1000})).toMatchObject({id:event.id,transferId:event.associated_object_id});
    expect(()=>verifyIncreaseWebhook({rawBody:Buffer.from(JSON.stringify({...event,category:"changed"})),headers,scope,signingSecret:secret,now:Number(timestamp)*1000})).toThrow();
  });

  it("finds the original transfer by scoped operation key with GET and no resend authority", async () => {
    const { provider, saved, http } = await bank({ "/ach_transfers": { data: [fixtures.pending], next_cursor: null } });
    expect(await provider.lookupTransfer(saved)).toMatchObject({ kind: "found", scope, commandId: saved.commandId,
      idempotencyKey: saved.idempotencyKey, requestHash: saved.requestHash, observation: { id: "ach_transfer_demo", status: "pending" } });
    const [input, init] = http.mock.calls[0]!; const url = new URL(String(input));
    expect(url.pathname).toBe("/ach_transfers");
    expect(url.searchParams.get("account_id")).toBe(scope.accountId);
    expect(url.searchParams.get("idempotency_key")).toBe(saved.idempotencyKey);
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
    expect(provider.recovery).toMatchObject({ lookup: "operation_key", sameKeyResend: { kind: "never" } });
  });

  it("finds a known transfer using the original command even without an evidence-service resolver", async () => {
    const saved = await command();
    const http = vi.fn<typeof fetch>(async () => response(fixtures.pending));
    const provider = new IncreaseSandboxBank({ scope, apiKey: "private", resolveCommand: async () => null, fetch: http });
    expect(await provider.lookupTransfer(saved, "ach_transfer_demo")).toMatchObject({ kind: "found", observation: { id: "ach_transfer_demo" } });
    expect(http.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init?.method])).toEqual([["/ach_transfers/ach_transfer_demo", "GET"]]);
  });

  it("keeps missing known identity and incomplete key scans unresolved", async () => {
    const missing = await bank({});
    expect(await missing.provider.lookupTransfer(missing.saved, "ach_transfer_demo")).toMatchObject({ kind: "unknown" });
    for (const result of [{ data: [], next_cursor: "more" }, { data: [fixtures.pending, fixtures.pending], next_cursor: null }]) {
      const { provider, saved, http } = await bank({ "/ach_transfers": result });
      expect(await provider.lookupTransfer(saved)).toMatchObject({ kind: "unknown" });
      expect(http.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    }
    const absent = await bank({ "/ach_transfers": { data: [], next_cursor: null } });
    expect(await absent.provider.lookupTransfer(absent.saved)).toMatchObject({ kind: "not_found", searchedBy: "operation_key" });
  });

  it("rejects malformed or conflicting lookup evidence for operator review", async () => {
    for (const row of [{ ...fixtures.pending, amount: 1 }, { ...fixtures.pending, external_account_id: "external_account_other" },
      { ...fixtures.pending, account_id: "account_other" }, { ...fixtures.pending, idempotency_key: "wrong" }, { id: "malformed" }]) {
      const { provider, saved } = await bank({ "/ach_transfers": { data: [row], next_cursor: null } });
      await expect(provider.lookupTransfer(saved)).rejects.toMatchObject({ errorClass: "configuration" });
    }
  });

  it("validates every scope dimension before recovery HTTP and preserves failed reads", async () => {
    const { provider, saved, http } = await bank({});
    for (const field of ["organizationId", "runId", "accountId", "provider", "environment"] as const) {
      await expect(provider.lookupTransfer({ ...saved, scope: { ...scope, [field]: "foreign" } as BankScope })).rejects.toThrow();
    }
    expect(http).not.toHaveBeenCalled();
    for (const status of [429, 503]) {
      const failed = await bank({}, { fetch: async () => response({}, status) });
      await expect(failed.provider.lookupTransfer(failed.saved)).rejects.toMatchObject({ errorClass: status === 429 ? "rate_limit" : "unknown" });
    }
  });

  it("pins exact upstream subset and fixture hashes", () => {
    for (const [name, expected] of [["openapi.json", provenance.subsetSha256], ["lifecycle.json", provenance.fixtureSha256]]) {
      expect(createHash("sha256").update(readFileSync(new URL(`../fixtures/increase/${name}`, import.meta.url))).digest("hex")).toBe(expected);
    }
  });
  it("replays exactly the original POST and key after a lost acceptance response and fresh worker", async () => {
    let attempts = 0;
    const calls: RequestInit[] = [];
    const http: typeof fetch = async (_input, init) => { calls.push(init!); if (++attempts === 1) throw new Error("lost response after accept"); return response(fixtures.pending); };
    const first = await bank({}, { fetch: http });
    await expect(first.provider.createTransfer(first.saved)).rejects.toMatchObject({ errorClass: "transport", outcomeUnknown: true });
    const restarted = await bank({}, { fetch: http });
    expect((await restarted.provider.createTransfer(first.saved)).id).toBe("ach_transfer_demo");
    expect(calls[0]!.body).toBe(calls[1]!.body);
    expect(calls[1]!.body).toBe(increaseRequestBody(first.saved));
    expect(new Headers(calls[0]!.headers).get("Idempotency-Key")).toBe(first.saved.idempotencyKey);
    expect(new Headers(calls[1]!.headers).get("Idempotency-Key")).toBe(first.saved.idempotencyKey);
    expect(JSON.stringify(restarted.provider)).not.toContain("test-private-key");
  });
  it("sends saved noncanonical whitespace/key-order bytes and refuses missing or altered saved requests", async () => {
    const { provider, saved, http } = await bank({ "/ach_transfers": fixtures.pending });
    const original = JSON.parse(saved.providerRequest!);
    saved.providerRequest = JSON.stringify(Object.fromEntries(Object.entries(original).reverse()), null, 3);
    saved.requestHash = await commandRequestHash(saved);
    await provider.createTransfer(saved);
    expect(http.mock.calls[0]![1]!.body).toBe(saved.providerRequest);
    const missing = { ...saved }; delete missing.providerRequest;
    missing.requestHash = await commandRequestHash(missing);
    await expect(provider.createTransfer(missing)).rejects.toMatchObject({ errorClass: "configuration" });
    const changed = { ...saved, providerRequest: JSON.stringify({ ...original, amount: 1 }) };
    changed.requestHash = await commandRequestHash(changed);
    await expect(provider.createTransfer(changed)).rejects.toMatchObject({ errorClass: "idempotency_conflict" });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("rejects changed hash, organization, run, account, environment, amount and destination before HTTP", async () => {
    const { provider, saved, http } = await bank({});
    const changes = [ { amountCents: 2501 }, { amountCents: -2500 }, { currency: "EUR" }, { scope: { ...scope, accountId: "account_elsewhere" } },
      { scope: { ...scope, runId: "other" } }, { scope: { ...scope, organizationId: "other" } }, { scope: { ...scope, environment: "local" } },
      { destination: { externalAccountId: "https://evil.invalid", version: "v1" } } ];
    for (const change of changes) await expect(provider.createTransfer({ ...saved, ...change } as BankCommand)).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 409, 500, 503])("normalizes HTTP %s without exposing credentials or bank details", async status => {
    const http: typeof fetch = async () => response({ detail: "secret-details" }, status, { "Retry-After": "7" });
    const { provider, saved } = await bank({}, { fetch: http });
    const error = await provider.createTransfer(saved).catch(e => e);
    expect(error.errorClass).toBe(status === 429 ? "rate_limit" : status === 409 ? "idempotency_conflict" : status >= 500 ? "unknown" : "authentication");
    if (status === 429) expect(error.retryAfterMs).toBe(7000);
    if (status >= 500 || status === 409) expect(error.outcomeUnknown).toBe(true);
    expect(error.message).not.toContain("secret-details");
  });
  it("does not post submitted status without settlement evidence", async () => {
    const { provider } = await bank({ "/ach_transfers/ach_transfer_demo": { ...fixtures.pending, status: "submitted" } });
    expect((await provider.getTransfer(scope, "ach_transfer_demo")).status).toBe("pending");
  });
  it("maps submitted plus settlement and a verified posted debit to settled", async () => {
    const { provider } = await bank({ "/ach_transfers/ach_transfer_demo": fixtures.settled, "/transactions/transaction_debit": fixtures.debit });
    expect(await provider.getTransfer(scope, "ach_transfer_demo")).toMatchObject({ status: "settled", originalTransactionId: "transaction_debit" });
    expect(await provider.getTransaction(scope, "transaction_debit")).toMatchObject({ amountCents: -2500, status: "posted", purpose: "debit", commandId: "cmd_demo" });
  });
  it.each([
    { ...fixtures.debit, account_id: "account_elsewhere" },
    { ...fixtures.debit, amount: 2500 },
    { ...fixtures.debit, source: { category: "ach_transfer_intention", ach_transfer_intention: { transfer_id: "ach_transfer_wrong" } } },
  ])("fails closed for inconsistent bank transaction evidence %#", async debit => {
    const { provider } = await bank({ "/ach_transfers/ach_transfer_demo": fixtures.settled, "/transactions/transaction_debit": debit });
    await expect(provider.getTransfer(scope, "ach_transfer_demo")).rejects.toThrow();
  });
  it("requires both original and distinct return transaction when return is seen first", async () => {
    const routes: Record<string, unknown> = { "/ach_transfers/ach_transfer_demo": fixtures.returned, "/transactions/transaction_debit": fixtures.debit, "/transactions/transaction_return": fixtures.credit };
    const { provider } = await bank(routes);
    expect(await provider.getTransfer(scope, "ach_transfer_demo")).toMatchObject({ status: "returned", originalTransactionId: "transaction_debit", returnTransactionId: "transaction_return" });
    expect(await provider.getTransaction(scope, "transaction_return")).toMatchObject({ amountCents: 2500, purpose: "return", originalTransactionId: "transaction_debit" });
    delete routes["/transactions/transaction_debit"];
    await expect(provider.getTransfer(scope, "ach_transfer_demo")).rejects.toMatchObject({ errorClass: "not_found" });
  });
  it("rejects response linked to another beneficiary or account", async () => {
    for (const change of [{ external_account_id: "external_account_other" }, { account_id: "account_other" }]) {
      const { provider, saved } = await bank({ "/ach_transfers": { ...fixtures.pending, ...change } });
      await expect(provider.createTransfer(saved)).rejects.toThrow();
    }
  });
  it("preserves unmatched account activity and performs account-filtered paginated full scans", async () => {
    const { provider, http } = await bank({ "/transactions": { data: [fixtures.unknown], next_cursor: null } });
    expect(await provider.listTransactions(scope, { cursor: "opaque cursor", limit: 1 })).toMatchObject({ items: [{ id: "transaction_unmatched", commandId: "", amountCents: -100 }], nextCursor: null, cursor: null });
    const url = new URL(String(http.mock.calls[0]![0]));
    expect(url.searchParams.get("account_id")).toBe(scope.accountId);
    expect(url.searchParams.get("cursor")).toBe("opaque cursor");
  });
  it("returns failed rows separately, bounds lookup concurrency and stops new lookups after a rate limit", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ ...fixtures.debit, id: `transaction_${i}`,
      source: { category: "ach_transfer_intention", ach_transfer_intention: { transfer_id: `ach_transfer_${i}` } } }));
    let inFlight = 0, peak = 0;
    const http = vi.fn<typeof fetch>(async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/transactions") return response({ data: rows, next_cursor: null });
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      const index = Number(path.split("_").at(-1));
      if (index === 6) return response({}, 429, { "Retry-After": "3" });
      return response({ ...fixtures.settled, id: `ach_transfer_${index}`, idempotency_key: `other-${index}`, transaction_id: `transaction_${index}` });
    });
    const { provider } = await bank({}, { fetch: http });
    const page = await provider.listTransactions(scope, { createdOnOrAfter: "2026-10-24T00:00:00Z" });
    expect(new URL(String(http.mock.calls[0]![0])).searchParams.get("created_at.on_or_after")).toBe("2026-10-24T00:00:00Z");
    expect(peak).toBeLessThanOrEqual(5);
    expect(page.failures).toContainEqual({ id: "transaction_6", errorClass: "rate_limit", error: "Increase rate limit", retryAfterMs: 3000 });
    // Every row is either verified or reported; nothing is silently dropped.
    expect(page.items.length + page.failures!.length).toBe(12);
    expect(page.items.map(item => item.id)).toContain("transaction_0");
    expect(page.failures!.every(failure => failure.errorClass === "rate_limit")).toBe(true);
    expect(http.mock.calls.length - 1).toBeLessThan(12); // Throttled rows were not fetched.
    await expect(provider.listTransactions(scope, { createdOnOrAfter: "not-a-time" })).rejects.toMatchObject({ errorClass: "validation" });
  });
  it("scans the account for possible sends before an operator release, read-only and filtered from the first attempt", async () => {
    const since = Date.parse("2026-10-22T00:00:00Z");
    const other = { ...fixtures.pending, id: "ach_transfer_other", idempotency_key: "someone-else", amount: 999 };
    const { provider, saved, http } = await bank({ "/ach_transfers": { data: [other], next_cursor: null }, "/transactions": { data: [fixtures.unknown], next_cursor: null } });
    expect(await provider.scanForPossibleSend(saved, since)).toEqual({ complete: true, transfersScanned: 1, transactionsScanned: 1, matchingTransferIds: [], matchingTransactionIds: [] });
    const transfers = new URL(String(http.mock.calls[0]![0]));
    expect(transfers.searchParams.get("external_account_id")).toBe(saved.destination.externalAccountId);
    expect(transfers.searchParams.get("created_at.on_or_after")).toBe("2026-10-22T00:00:00.000Z");
    expect(http.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    const matched = await bank({ "/ach_transfers": { data: [{ ...other, amount: 2500, id: "ach_transfer_same" }], next_cursor: null }, "/transactions": { data: [fixtures.debit], next_cursor: null } });
    expect(await matched.provider.scanForPossibleSend(matched.saved, since)).toMatchObject({ matchingTransferIds: ["ach_transfer_same"], matchingTransactionIds: ["transaction_debit"] });
    const endless = await bank({ "/ach_transfers": { data: [], next_cursor: "more" }, "/transactions": { data: [], next_cursor: null } });
    expect((await endless.provider.scanForPossibleSend(endless.saved, since)).complete).toBe(false);
  });
  it("preserves event tail cursor after empty page and polls oldest first", async () => {
    const { provider, http } = await bank({ "/events": { data: [], next_cursor: "tail2" } });
    expect(await provider.listEvents(scope, { cursor: "tail1" })).toEqual({ items: [], nextCursor: null, cursor: "tail2" });
    expect(new URL(String(http.mock.calls[0]![0])).searchParams.get("order_by.direction")).toBe("ascending");
  });
  it("reads balance from the documented balance_lookup object (which has no currency field)", async () => {
    const { provider } = await bank({ "/accounts/account_demo/balance": { type: "balance_lookup", account_id: "account_demo", current_balance: 10000, available_balance: 7500 } });
    expect(await provider.getBalance(scope)).toMatchObject({ currentCents: 10000, availableCents: 7500, currency: "USD" });
  });
  it("reports missing sandbox credentials as not run and keeps controls off provider", async () => {
    expect(sandboxConfiguration({})).toMatchObject({ status: "not_run", missing: ["INCREASE_SANDBOX_API_KEY", "INCREASE_SANDBOX_ACCOUNT_ID", "INCREASE_SANDBOX_EXTERNAL_ACCOUNT_ID"] });
    const { provider } = await bank({});
    expect("settle" in provider).toBe(false);
    expect("return" in provider).toBe(false);
  });
  it("harness submits only a pending submission and skips an already submitted transfer", async () => {
    for (const status of ["pending_submission", "submitted"] as const) {
      const http = vi.fn<typeof fetch>(async (_url, init) => response({ id: "ach_transfer_demo", account_id: scope.accountId, status: init?.method === "POST" ? "submitted" : status }));
      const harness = new IncreaseSandboxHarness({ scope, apiKey: "private", fetch: http });
      expect(await harness.submit("ach_transfer_demo")).toMatchObject({status:"submitted"});
      expect(http.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(status === "pending_submission" ? 1 : 0);
      expect(String(http.mock.calls[0]![0])).toBe("https://sandbox.increase.com/ach_transfers/ach_transfer_demo");
      expect(JSON.stringify(harness)).not.toContain("private");
    }
  });
  it("harness fails closed on review, terminal or unknown submission states", async () => {
    for (const status of ["pending_approval", "pending_reviewing", "returned", "rejected", "canceled", "requires_attention", undefined]) {
      const http = vi.fn<typeof fetch>(async () => response({ id: "ach_transfer_demo", account_id: scope.accountId, status }));
      const harness = new IncreaseSandboxHarness({scope,apiKey:"private",fetch:http});
      await expect(harness.submit("ach_transfer_demo")).rejects.toThrow("requires pending_submission");
      expect(http).toHaveBeenCalledTimes(1);
    }
  });
  it("harness recognizes automatic submission racing the simulation without repeating the POST", async () => {
    let gets = 0;
    const http = vi.fn<typeof fetch>(async (_url, init) => init?.method === "POST"
      ? response({error:"already submitted"},409)
      : response({id:"ach_transfer_demo",account_id:scope.accountId,status:++gets === 1 ? "pending_submission" : "submitted"}));
    const harness = new IncreaseSandboxHarness({scope,apiKey:"private",fetch:http});
    expect(await harness.submit("ach_transfer_demo")).toMatchObject({status:"submitted"});
    expect(http).toHaveBeenCalledTimes(3);
    expect(http.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("harness preserves simulation failures and verifies ownership again after a submission race", async () => {
    for(const accountId of [scope.accountId,"account_other"]) {
      let gets=0;
      const http=vi.fn<typeof fetch>(async (_url,init)=>init?.method==="POST"
        ? response({error:"not allowed"},400)
        : response({id:"ach_transfer_demo",account_id:++gets===1?scope.accountId:accountId,status:"pending_submission"}));
      const harness=new IncreaseSandboxHarness({scope,apiKey:"private",fetch:http});
      await expect(harness.submit("ach_transfer_demo")).rejects.toThrow(accountId===scope.accountId?"failed (HTTP 400)":"account mismatch");
      expect(http.mock.calls.filter(([,init])=>init?.method==="POST")).toHaveLength(1);
    }
  });
  it("harness rejects cross-account control before issuing a simulation POST", async () => {
    const http = vi.fn<typeof fetch>(async () => response({ id: "ach_transfer_demo", account_id: "account_other" }));
    const harness = new IncreaseSandboxHarness({ scope, apiKey: "private", fetch: http });
    await expect(harness.settle("ach_transfer_demo")).rejects.toThrow("account mismatch");
    expect(http).toHaveBeenCalledTimes(1);
  });
});

describe("Increase signed raw-byte notification ingress", () => {
  const now = 1792756800000;
  const secret = "subscription-signing-secret";
  const raw = Buffer.from(JSON.stringify(fixtures.event, null, 2));
  function headers(body = raw, eventId = "event_demo", timestamp = String(now / 1000)) {
    return { "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${createHmac("sha256", secret).update(`${eventId}.${timestamp}.`).update(body).digest("base64")}` };
  }
  it("verifies raw bytes and persists resource identity without treating it as settlement", () => {
    expect(verifyIncreaseWebhook({ rawBody: raw, headers: headers(), scope, signingSecret: secret, now })).toMatchObject({ id: "event_demo", transferId: "ach_transfer_demo", resourceType: "ach_transfer" });
    expect(verifyIncreaseWebhook({ rawBody: raw, headers: headers(), scope, signingSecret: secret, now })).not.toHaveProperty("status");
  });
  it("accepts transaction notifications as durable hints before fetching account-scoped evidence", () => {
    const body = Buffer.from(JSON.stringify({ ...fixtures.event, associated_object_type: "transaction", associated_object_id: "transaction_debit", category: "transaction.created" }));
    expect(verifyIncreaseWebhook({ rawBody: body, headers: headers(body), scope, signingSecret: secret, now })).toMatchObject({ transactionId: "transaction_debit" });
  });
  it("rejects tampering, serialization changes, stale timestamps, wrong secret and mismatched signed IDs", () => {
    const invalid = [
      { rawBody: Buffer.from(JSON.stringify(fixtures.event)), headers: headers(), signingSecret: secret },
      { rawBody: raw, headers: headers(raw, "event_demo", "100"), signingSecret: secret },
      { rawBody: raw, headers: headers(), signingSecret: "wrong-secret" },
      { rawBody: raw, headers: headers(raw, "event_other"), signingSecret: secret },
    ];
    for (const options of invalid) expect(() => verifyIncreaseWebhook({ ...options, scope, now })).toThrow();
  });
  it("accepts one valid signature during rotation", () => {
    const h = headers();
    h["webhook-signature"] = `v1,aW52YWxpZA== ${h["webhook-signature"]}`;
    expect(verifyIncreaseWebhook({ rawBody: raw, headers: h, scope, signingSecret: secret, now }).id).toBe("event_demo");
  });
});
