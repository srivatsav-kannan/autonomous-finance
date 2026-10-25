import { useEffect, useState } from "react";
import { CONNECTORS, PROOF_GROUPS, type Connector, type ProofStatus } from "./proofData";
import "./proof.css";

const STATUS: Record<ProofStatus, string> = { passed: "Passed", failed: "Open", partial: "Partial", not_run: "Not run" };
const MODE: Record<Connector["mode"], string> = { local_fake: "Local fake", sandbox_verified: "Verified", sandbox_partial: "Partly verified", not_configured: "Not configured" };

// Everything we measured, in one place, each with the file it came from.
export function ProofGroups() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="proof" aria-labelledby="proof-heading">
      <div className="page-heading"><div>
        <h2 id="proof-heading">What we measured</h2>
        <p className="lede">This page lists the benchmarks, sample cases, sandbox runs and test suites that we measured, and every number links to the file that it came from.</p>
      </div></div>
      {PROOF_GROUPS.map((g) => {
        const counts = g.items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }), {});
        return <details key={g.id} className="proof-group" open={open === g.id || undefined} onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && setOpen(g.id)}>
          <summary><span className="proof-title">{g.title}</span><span className="proof-counts">{(["passed", "partial", "failed", "not_run"] as const).filter((s) => counts[s]).map((s) => <span key={s} className={`proof-pill is-${s}`}>{counts[s]} {STATUS[s].toLowerCase()}</span>)}</span><span className="proof-summary">{g.summary}</span></summary>
          <ul className="proof-items">{g.items.map((i) => <li key={i.id}>
            <div className="proof-item-head"><span className={`proof-pill is-${i.status}`}>{STATUS[i.status]}</span><strong>{i.title}</strong></div>
            <p className="proof-headline">{i.headline}</p>
            <p>{i.detail}</p>
            <p className="proof-meta"><span>{i.how}</span>{i.command && <code>{i.command}</code>}<span className="proof-source">Source: <code>{i.source}</code></span></p>
          </li>)}</ul>
        </details>;
      })}
    </section>
  );
}

type Runtime = { parser?: string; providerMode?: string; identityMode?: string; providerFileLoaded?: boolean; accountingIntegration?: { provider: string; status: string }; runId?: string };

export function Connectors() {
  const [runtime, setRuntime] = useState<Runtime | null>();
  useEffect(() => {
    let live = true;
    fetch("/api/ap-system/runtime", { credentials: "same-origin" }).then((r) => r.ok ? r.json() : null).then((v) => { if (live) setRuntime(v); }, () => { if (live) setRuntime(null); });
    return () => { live = false; };
  }, []);
  return (
    <section className="proof" aria-labelledby="connectors-heading">
      <div className="page-heading"><div>
        <h2 id="connectors-heading">Connectors</h2>
        <p className="lede">These are the outside systems that the department uses and what we have proven against each one. Our tests run against fakes of these services, and the sandboxes are the real services with fake money and fake books.</p>
      </div></div>
      <div className="connector-live" role="status">
        {runtime === undefined ? "Checking the AP service…" : runtime === null ? "The AP service isn't running. Start everything with npm run demo." : <>
          <strong>Running now</strong>
          <span>Bank: {runtime.providerMode ?? "unknown"}</span>
          <span>Documents: {runtime.parser ?? "unknown"}</span>
          <span>Sign-in: {runtime.identityMode === "simulated_human" ? "simulated people (local)" : runtime.identityMode ?? "unknown"}</span>
          {runtime.accountingIntegration && <span>Accounting: {runtime.accountingIntegration.provider}, {runtime.accountingIntegration.status.replace(/_/g, " ")}</span>}
        </>}
      </div>
      <ul className="connector-grid">{CONNECTORS.map((c) => <li key={c.id} className="connector-card">
        <div className="proof-item-head"><strong>{c.name}</strong><span className={`proof-pill is-${c.mode === "sandbox_verified" ? "passed" : c.mode === "sandbox_partial" ? "partial" : c.mode === "local_fake" ? "local" : "not_run"}`}>{MODE[c.mode]}</span></div>
        <p>{c.role}</p>
        {!!c.verified.length && <><p className="connector-label">Proven</p><ul>{c.verified.map((v) => <li key={v}>{v}</li>)}</ul></>}
        {!!c.notVerified.length && <><p className="connector-label">Not yet</p><ul>{c.notVerified.map((v) => <li key={v}>{v}</li>)}</ul></>}
        <p className="proof-source">Source: <code>{c.source}</code></p>
      </li>)}</ul>
    </section>
  );
}
