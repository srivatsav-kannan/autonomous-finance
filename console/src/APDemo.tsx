import { useEffect, useRef, useState, type FormEvent } from "react";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { BankScope } from "../../src/integrations/contracts";
import "./APDemo.css";

type Review = FunctionReturnType<typeof api.demoPayments.humanReview>;
type Evidence = FunctionReturnType<typeof api.demoEvidence.humanView>;
type Snapshot = Review["versions"][number];
type Command = Review["commands"][number];
type Session = { client: ConvexHttpClient; scope: BankScope };
const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const when = (time?: number) => time === undefined ? "—" : new Date(time).toLocaleString();
const failure = (error: unknown) => error instanceof Error ? error.message : "The request could not be completed.";
const scopeExample = '{"organizationId":"ap-demo","runId":"your-run-id","provider":"fake","environment":"local","accountId":"usd-operating"}';
function parseScope(text: string): BankScope {
  const s: unknown = JSON.parse(text);
  if (!s || typeof s !== "object") throw new Error("Enter the account scope from the demo report.");
  const row = s as Record<string, unknown>;
  const keys = ["organizationId", "runId", "provider", "environment", "accountId"];
  if (Object.keys(row).length !== keys.length || keys.some(key => typeof row[key] !== "string" || !String(row[key]).trim()) ||
      !((row.provider === "fake" && row.environment === "local") || (row.provider === "increase" && row.environment === "sandbox"))) {
    throw new Error("Scope needs organizationId, runId, provider, environment and accountId. Use fake/local or increase/sandbox.");
  }
  return row as BankScope;
}

/** Human-only route. JWT lives in memory; no service credentials, bank adapters or simulator controls. */
export function APDemo() {
  const session = useRef<Session | null>(null);
  const [scopeText, setScopeText] = useState("");
  const [jwt, setJwt] = useState("");
  const [scope, setScope] = useState<BankScope | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number>();
  const deploymentUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
  useEffect(() => () => { session.current?.client.clearAuth(); session.current = null; }, []);

  async function load(active: Session) {
    const [r, e] = await Promise.all([
      active.client.query(api.demoPayments.humanReview, { scope: active.scope }),
      active.client.query(api.demoEvidence.humanView, { scope: active.scope }),
    ]);
    if (session.current !== active) return;
    setReview(r); setEvidence(e); setUpdatedAt(Date.now());
  }
  async function connect(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      if (!deploymentUrl) throw new Error("Set VITE_CONVEX_URL for this console deployment.");
      const selected = parseScope(scopeText);
      if (!jwt.trim()) throw new Error("A signed human identity token is required.");
      const client = new ConvexHttpClient(deploymentUrl);
      client.setAuth(jwt.trim());
      const active = { client, scope: selected };
      session.current?.client.clearAuth(); session.current = active;
      setJwt("");
      await load(active);
      if (session.current === active) setScope(selected);
    } catch (e) {
      session.current?.client.clearAuth(); session.current = null;
      setError(failure(e)); setReview(null); setEvidence(null);
    } finally { setBusy(false); }
  }
  function disconnect() {
    session.current?.client.clearAuth(); session.current = null;
    setJwt(""); setScope(null); setReview(null); setEvidence(null); setMessage(""); setError(""); setUpdatedAt(undefined);
  }
  async function action(operation: (active: Session) => Promise<unknown>, success: string) {
    const active = session.current;
    if (!active || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await operation(active);
      if (session.current !== active) return;
      setMessage(success);
      await load(active);
    } catch (e) { if (session.current === active) setError(failure(e)); }
    finally { setBusy(false); }
  }
  const approve = (version: Snapshot) => action(active => active.client.mutation(api.demoPayments.approveAndQueue, {
    scope: active.scope, versionId: version._id, snapshotHash: version.snapshotHash,
  }), "Human approval recorded for the reviewed payment version. The dispatcher can now process it.");
  const resume = (commandId: Id<"demoCommands">, reason: string) => action(active => active.client.mutation(api.demoPayments.resume, {
    scope: active.scope, commandId, reason,
  }), "Recovery resumed using the original saved request and idempotency key.");
  const operator = review && "operator" in review && review.operator && typeof review.operator === "object" && "name" in review.operator
    ? String(review.operator.name) : "Human CFO assigned to this account";

  return <main className="ap-console">
    <header className="ap-heading">
      <div><a href="/">Autonomous Finance</a><h1>Accounts payable review</h1><p>Approve exact payment details and trace verified bank activity to the journal.</p></div>
      {scope && <button onClick={disconnect}>Disconnect</button>}
    </header>
    <div aria-live="polite">{message && <p className="ap-success">{message}</p>}</div>
    {error && <p role="alert" className="ap-error">{error}</p>}
    {!scope ? <section className="ap-panel ap-login">
      <h2>Connect as a human approver</h2>
      <p>Your configured identity provider must issue the token for a human CFO bound to this account. The token is held in memory until disconnect or page close.</p>
      <form onSubmit={connect}>
        <label htmlFor="ap-scope">Account scope from the demo report</label>
        <textarea id="ap-scope" required rows={5} spellCheck={false} value={scopeText} placeholder={scopeExample} onChange={event => setScopeText(event.target.value)} />
        <label htmlFor="ap-jwt">Human identity token</label>
        <input id="ap-jwt" type="password" required autoComplete="off" spellCheck={false} value={jwt} onChange={event => setJwt(event.target.value)} />
        <button className="primary" disabled={busy}>{busy ? "Verifying identity…" : "Connect and load review"}</button>
      </form>
    </section> : <>
      <section className="ap-panel">
        <div className="ap-row"><h2>{scope.runId}</h2><button disabled={busy} onClick={() => action(async () => undefined, "Review refreshed.")}>{busy ? "Working…" : "Refresh"}</button></div>
        <p>{scope.organizationId} · {scope.provider} / {scope.environment} · USD account <code>{scope.accountId}</code></p>
        <p className="muted">Responsible operator: {operator}. Last refreshed: {when(updatedAt)}.</p>
      </section>
      {review && <section className="ap-panel">
        <h2>Payment versions</h2>
        {!review.versions.length && <p>No payment versions have been requested for this account.</p>}
        {review.versions.map(version => <VersionReview key={`${version._id}:${version.snapshotHash}`} version={version} review={review} busy={busy} approve={approve} />)}
      </section>}
      {review && <section className="ap-panel">
        <h2>Dispatch and recovery</h2>
        {!review.commands.length && <p>No approved commands have been queued.</p>}
        {review.commands.map(command => <CommandReview key={command._id} command={command} busy={busy} resume={resume} operator={operator} />)}
      </section>}
      {evidence && <section className="ap-panel">
        <h2>Close blockers · {evidence.blockers.length}</h2>
        {evidence.blockers.length ? <ul className="ap-blockers">{evidence.blockers.map((blocker, index) => <li key={`${blocker.kind}:${blocker.id}:${index}`}><strong>{blocker.kind}</strong> <code>{blocker.id}</code><p>{blocker.reason}</p></li>)}</ul> : <p className="ap-success">All imported bank activity is explained and the AP flow has no open blockers.</p>}
        <h2>Bank evidence and journal links</h2>
        <div className="ap-table-wrap"><table className="grid"><thead><tr><th>Bank transaction</th><th>Transfer / command</th><th>Cash movement</th><th>Journal / reconciliation</th></tr></thead><tbody>
          {evidence.transactions.map(record => <tr key={record._id}>
            <td><code>{record.transaction.id}</code><br />{record.transaction.purpose} · {record.transaction.status}<br /><span className="muted">{record.transaction.postedAt}</span></td>
            <td><code>{record.transaction.transferId || "Unmatched"}</code><br /><code>{record.transaction.commandId || "No authorized command linked"}</code></td>
            <td>{usd(record.transaction.amountCents)}<br />{record.transaction.originalTransactionId && <span>Original: <code>{record.transaction.originalTransactionId}</code></span>}</td>
            <td><code>{record.entryId ?? "Awaiting local posting"}</code><br />{record.state}{record.error && <p className="ap-error">{record.error}</p>}</td>
          </tr>)}
        </tbody></table></div>
        {!evidence.transactions.length && <p>No verified bank transactions have been imported.</p>}
      </section>}
    </>}
  </main>;
}

function VersionReview({ version, review, busy, approve }: { version: Snapshot; review: Review; busy: boolean; approve: (version: Snapshot) => Promise<void> }) {
  const [checked, setChecked] = useState(false);
  const snapshot = version.snapshot;
  return <article className="ap-record">
    <div className="ap-row"><h3>{usd(snapshot.amountCents)} to {review.beneficiary.vendor}</h3><span className="pill">{version.status}</span></div>
    <dl className="ap-facts">
      <div><dt>Payment version</dt><dd><code>{version._id}</code></dd></div>
      <div><dt>Beneficiary reference / version</dt><dd><code>{snapshot.destination.externalAccountId}</code> / {snapshot.destination.version}</dd></div>
      <div><dt>Policy / requested by</dt><dd>{snapshot.policyVersion} / {version.requestedBy}</dd></div>
      <div><dt>Approval snapshot hash</dt><dd><code>{version.snapshotHash}</code></dd></div>
    </dl>
    <div className="ap-table-wrap"><table className="grid"><thead><tr><th>Invoice allocation</th><th>Original invoice</th><th>Payment amount</th></tr></thead><tbody>
      {snapshot.bills.map(item => { const bill = review.bills.find(b => b._id === item.billId); return <tr key={item.billId}><td>{bill?.invoiceNumber ?? item.billId}<br /><code>{item.billId}</code> · version {item.version}</td><td>{bill ? usd(bill.originalCents) : "—"}</td><td>{usd(item.amountCents)}</td></tr>; })}
      {snapshot.credits.map(item => <tr key={item.creditId}><td>Credit <code>{item.creditId}</code></td><td>—</td><td>−{usd(item.amountCents)}</td></tr>)}
    </tbody></table></div>
    <details><summary>Exact immutable payment details</summary><pre>{JSON.stringify(snapshot, null, 2)}</pre></details>
    <p className="muted">Approvals: {version.approvals.length ? version.approvals.map(approval => `${approval.seatId} (${approval.kind})`).join(", ") : "Awaiting independent approval"}</p>
    {version.status === "awaiting_approval" && <div className="ap-approval">
      <label><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} /> I approve the displayed USD amount, invoice and credit allocations, beneficiary version and policy.</label>
      <button className="primary" disabled={busy || !checked} onClick={() => void approve(version)}>Approve this version and queue payment</button>
    </div>}
  </article>;
}

function CommandReview({ command, busy, resume, operator }: { command: Command; busy: boolean; resume: (id: Id<"demoCommands">, reason: string) => Promise<void>; operator: string }) {
  const [reason, setReason] = useState("");
  const step = command.execution === "exception" ? "Dispatch requires operator review"
    : command.execution === "unknown" ? "Resolve unknown bank outcome"
    : command.execution === "queued" ? "Waiting for the dispatcher"
    : command.execution === "in_flight" ? "Bank request in progress"
    : command.execution === "pending" ? "Await verified bank settlement"
    : ["cancelled", "rejected"].includes(command.execution) ? "Closed without settlement"
    : command.posting === "unposted" ? "Post verified bank evidence locally"
    : command.reconciliation !== "matched" ? "Reconcile bank evidence" : "Reconciled";
  const nextAttempt = command.execution === "exception" ? "Operator action required"
    : ["queued", "unknown"].includes(command.execution) ? when(command.nextAttemptAt) : "No dispatch scheduled";
  return <article className="ap-record">
    <h3>{usd(command.command.amountCents)} · {step}</h3>
    <dl className="ap-facts">
      <div><dt>Command</dt><dd><code>{command.command.commandId}</code></dd></div>
      <div><dt>Execution / posting / reconciliation</dt><dd>{command.execution} / {command.posting} / {command.reconciliation}</dd></div>
      <div><dt>Attempts / next scheduled attempt</dt><dd>{command.attemptCount} / {nextAttempt}</dd></div>
      <div><dt>Responsible operator</dt><dd>{operator}</dd></div>
      <div><dt>Provider transfer</dt><dd><code>{command.providerTransferId ?? "Awaiting bank identity"}</code></dd></div>
      <div><dt>Original idempotency key</dt><dd><code>{command.command.idempotencyKey}</code></dd></div>
      <div><dt>Saved request hash</dt><dd><code>{command.command.requestHash}</code></dd></div>
    </dl>
    {command.lastError && <p className="ap-error">{command.lastError}</p>}
    {command.execution === "exception" && <form className="ap-resume" onSubmit={event => { event.preventDefault(); if (reason.trim()) void resume(command._id, reason.trim()); }}>
      <label htmlFor={`reason-${command._id}`}>Resolution and reason for resuming</label>
      <textarea id={`reason-${command._id}`} required rows={2} value={reason} onChange={event => setReason(event.target.value)} />
      <p className="muted">Resuming retains the original request, key, provider and reservations. The reason is recorded in the audit log.</p>
      <button disabled={busy || !reason.trim()}>Resume original command</button>
    </form>}
  </article>;
}
