import fixtures from "../../src/integrations/fixtures/increase/lifecycle.json";
import { api, demoFixture } from "../demo-fixture";
import { IncreaseSandboxBank } from "../../src/integrations/banking/increase";
import { EvidenceWorker, type KernelTransport } from "../../src/payments/evidence";
import { PaymentDispatcher } from "../../src/payments/dispatcher";

type Raw = Record<string, unknown> & { id: string; created_at: string };

/** Stateful mocked Increase HTTP transport for convex-test suites. It never contacts Increase.
 * Shapes come from the pinned lifecycle fixtures; behaviour is limited to what the AP flow reads. */
export function increaseMock(options: { accountId?: string; honorCreatedAtFilter?: boolean } = {}) {
  const accountId = options.accountId ?? "account_demo";
  const transfers = new Map<string, Raw>();
  const transactions = new Map<string, Raw>();
  /** Transfer ids whose GET answers HTTP 429, and how many more times. */
  const throttledTransfers = new Map<string, number>();
  const requests: { method: string; url: URL }[] = [];
  /** Transaction ids omitted from list pages (still readable by id), to force the explicit retry path. */
  const hidden = new Set<string>();
  let clock = "2026-10-23T00:00:00Z";
  let sequence = 0;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const since = (url: URL) => options.honorCreatedAtFilter ? url.searchParams.get("created_at.on_or_after") : null;
  const newest = (rows: Raw[]) => [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "ach_transfers" && parts.length === 1 && method === "POST") {
      const key = new Headers(init?.headers).get("Idempotency-Key");
      const body = JSON.parse(String(init?.body)) as { account_id: string; amount: number; external_account_id: string; statement_descriptor: string };
      const existing = [...transfers.values()].find(t => t.idempotency_key === key);
      if (existing) return json(existing);
      const transfer: Raw = { ...fixtures.pending, id: `ach_transfer_mock${++sequence}`, idempotency_key: key, account_id: body.account_id,
        amount: body.amount, external_account_id: body.external_account_id, statement_descriptor: body.statement_descriptor,
        created_at: clock, pending_transaction_id: `pending_transaction_mock${sequence}` };
      transfers.set(transfer.id, transfer);
      return json(transfer);
    }
    if (parts[0] === "ach_transfers" && parts.length === 1) {
      const key = url.searchParams.get("idempotency_key");
      const destination = url.searchParams.get("external_account_id");
      const after = url.searchParams.get("created_at.on_or_after");
      const data = newest([...transfers.values()]).filter(t => t.account_id === url.searchParams.get("account_id") &&
        (!key || t.idempotency_key === key) && (!destination || t.external_account_id === destination) && (!after || t.created_at >= after));
      return json({ data, next_cursor: null });
    }
    if (parts[0] === "ach_transfers" && parts.length === 2) {
      const remaining = throttledTransfers.get(parts[1]!) ?? 0;
      if (remaining > 0) { throttledTransfers.set(parts[1]!, remaining - 1); return json(fixtures.error, 429, { "Retry-After": "0" }); }
      const transfer = transfers.get(parts[1]!);
      return transfer ? json(transfer) : json({ status: 404 }, 404);
    }
    if (parts[0] === "transactions" && parts.length === 1) {
      const after = since(url);
      return json({ data: newest([...transactions.values()]).filter(t => !hidden.has(t.id) && (!after || t.created_at >= after)), next_cursor: null });
    }
    if (parts[0] === "transactions" && parts.length === 2) {
      const transaction = transactions.get(parts[1]!);
      return transaction ? json(transaction) : json({ status: 404 }, 404);
    }
    return json({ status: 404 }, 404);
  };

  return {
    fetch, requests, transfers, transactions, accountId, hidden,
    setClock(value: string) { clock = value; },
    /** The next `times` GETs of this transfer are rate limited. */
    throttleTransfer(transferId: string, times = 1) { throttledTransfers.set(transferId, times); },
    /** Post the ACH debit. Without settlement it models a debit posted before `settlement` exists. */
    settle(transferId: string, at: string, settled = true) {
      const transfer = transfers.get(transferId)!;
      const id = `transaction_mock${++sequence}`;
      transactions.set(id, { ...fixtures.debit, id, account_id: transfer.account_id, amount: -(transfer.amount as number), created_at: at,
        source: { category: "ach_transfer_intention", ach_transfer_intention: { ...fixtures.debit.source.ach_transfer_intention,
          amount: -(transfer.amount as number), statement_descriptor: transfer.statement_descriptor, transfer_id: transferId } } });
      transfers.set(transferId, { ...transfer, status: "submitted", transaction_id: id, settlement: settled ? { settled_at: at } : null });
      return id;
    },
    completeSettlement(transferId: string, at: string) {
      transfers.set(transferId, { ...transfers.get(transferId)!, settlement: { settled_at: at } });
    },
    addTransaction(transaction: Raw) { transactions.set(transaction.id, transaction); },
  };
}
export type IncreaseMock = ReturnType<typeof increaseMock>;

/** One configured Increase sandbox run whose workers talk to the mocked transport. */
export async function increaseRun(runId: string, mock: IncreaseMock, options: Parameters<typeof demoFixture>[2] = {}) {
  const f = await demoFixture(runId, { provider: "increase", environment: "sandbox", accountId: mock.accountId }, options);
  await f.t.run(async ctx => {
    const config = (await ctx.db.query("demoConfigs").withIndex("by_run", q => q.eq("scope.runId", runId)).unique())!;
    await ctx.db.patch(config._id, { beneficiary: { ...config.beneficiary, externalAccountId: "external_account_vendor" } });
  });
  const provider = new IncreaseSandboxBank({ scope: f.scope, apiKey: "test-only", fetch: mock.fetch,
    resolveCommand: key => f.t.query(api.demoEvidence.resolveCommand, { scope: f.scope, token: f.evidenceToken, idempotencyKey: key }) });
  const transport = f.t as unknown as KernelTransport;
  return { ...f, provider,
    dispatcher: new PaymentDispatcher(transport, f.scope, f.dispatcherToken, provider, `${runId}-dispatch`),
    worker: new EvidenceWorker(transport, f.scope, f.evidenceToken, provider) };
}
