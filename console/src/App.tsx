import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useConvexConnectionState, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { registerWebMcpTools } from "./webmcp";
import { gateway } from "./gateway";

const $ = (cents: number) => (cents < 0 ? "-" : "") + "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

type Tab = "inbox" | "org" | "activity" | "ledger" | "memory" | "evals" | "control";
const TABS: { id: Tab; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "org", label: "Team" },
  { id: "activity", label: "Live activity" },
  { id: "ledger", label: "Ledger" },
  { id: "memory", label: "Memory" },
  { id: "evals", label: "Evals" },
  { id: "control", label: "Control room" },
];

function initialRun() {
  try { return decodeURIComponent(location.hash.slice(1)); } catch { return ""; }
}

function initialTab(): Tab {
  const value = new URLSearchParams(location.search).get("view");
  return TABS.find((t) => t.id === value)?.id ?? "inbox";
}

function Loading({ label }: { label: string }) {
  return <div className="loading" role="status">{label}<span className="loading-bar" /><span className="loading-bar" /></div>;
}

export function App() {
  const runs = useQuery(api.admin.runs, {});
  const connection = useConvexConnectionState();
  const [runId, setRunId] = useState(initialRun);
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => {
    if (!runId && runs?.length) setRunId(runs[0]!.runId);
  }, [runs, runId]);
  useEffect(() => {
    if (runId) location.hash = encodeURIComponent(runId);
  }, [runId]);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("view", tab);
    history.replaceState(null, "", url);
  }, [tab]);
  useEffect(() => {
    const sync = () => { setRunId(initialRun()); setTab(initialTab()); };
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);
  useEffect(() => {
    if (runId) return registerWebMcpTools(runId);
  }, [runId]);

  return (
    <div className="shell">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true">AF</span>
          <div>
            <h1 className="title">Autonomous Finance</h1>
            <div className="sub">Sweetgreen, Inc. (simulated)</div>
          </div>
        </div>
        <label className="scenario-picker">
          <span>Scenario</span>
          <select value={runId} onChange={(e) => setRunId(e.target.value)} aria-label="Scenario" disabled={!runs?.length}>
            {!runs?.length && <option value={runId}>{runs ? "No scenarios" : "Loading scenarios…"}</option>}
            {(runs ?? []).map((r) => (
              <option key={r.runId} value={r.runId}>{r.label} ({r.runId})</option>
            ))}
          </select>
        </label>
      </header>
      {!connection.isWebSocketConnected && <p className="connection-note" role="status">Connecting to the finance backend. Check that it is running if this continues.</p>}
      {!runId ? <main id="main" tabIndex={-1}>{runs === undefined ? <Loading label="Loading scenarios…" /> : <div className="empty"><strong>No scenarios yet.</strong>Run <code>npm run world</code> to start a simulation.</div>}</main> : (
        <div className="body">
          <aside className="sidebar">
            <nav className="side" aria-label="Console views">
              {TABS.map((t) => (
                <button type="button" key={t.id} className={t.id === tab ? "on" : ""} aria-current={t.id === tab ? "page" : undefined} onClick={() => setTab(t.id)}>
                  {t.label}
                  {t.id === "inbox" && <InboxCount runId={runId} />}
                </button>
              ))}
              <p className="side-note">Agents run the finance function. You oversee.</p>
            </nav>
          </aside>
          <div className="workspace">
            <label className="mobile-nav">View
              <select value={tab} onChange={(e) => setTab(e.target.value as Tab)} aria-label="Console view">
                {TABS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
            <Kpis runId={runId} />
            <main className="main" id="main" tabIndex={-1} key={runId}>
              {tab === "inbox" && <Inbox runId={runId} />}
              {tab === "org" && <Org runId={runId} />}
              {tab === "activity" && <Activity runId={runId} />}
              {tab === "ledger" && <Ledger runId={runId} />}
              {tab === "memory" && <Memory runId={runId} />}
              {tab === "evals" && <Evals runId={runId} />}
              {tab === "control" && <Control runId={runId} />}
            </main>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpis({ runId }: { runId: string }) {
  const o = useQuery(api.observe.overview, { runId });
  if (!o) return <Loading label="Loading balances…" />;
  const balances = [
    { label: "Cash", value: $(o.cashCents) },
    { label: "Accounts payable", value: $(o.apCents) },
    { label: "Revenue to date", value: $(o.revenueCents) },
  ];
  const metrics = [
    { label: "Sim date", value: o.run?.simDate ?? "—" },
    { label: "Ledger entries", value: o.entries.toLocaleString() },
    { label: "Agent turns", value: `${o.agentTurns.toLocaleString()} (${o.llmTurns} Claude)` },
    { label: "Model spend", value: `$${(o.costMicros / 1e6).toFixed(2)}` },
    { label: "Blocked by kernel", value: String(o.blockedAttempts) },
  ];
  return (
    <>
      <dl className="kpis" aria-label="Financial position">
        {balances.map((k) => <div key={k.label} className="kpi"><dt className="kl">{k.label}</dt><dd className="kv">{k.value}</dd></div>)}
      </dl>
      <dl className="metrics" aria-label="Simulation activity">
        {metrics.map((k) => <div key={k.label}><dt>{k.label}</dt><dd>{k.value}</dd></div>)}
      </dl>
    </>
  );
}

function InboxCount({ runId }: { runId: string }) {
  const open = useQuery(api.asks.list, { runId, status: "open", to: "human_cfo" });
  const n = open?.filter((a) => a.severity !== "info").length ?? 0;
  return n ? <span className="badge" aria-label={`${n} decisions need attention`}>{n}</span> : null;
}

function Inbox({ runId }: { runId: string }) {
  const [showAll, setShowAll] = useState(false);
  const asks = useQuery(api.asks.list, { runId, to: "human_cfo" });
  const list = (asks ?? []).filter((a) => showAll || a.status === "open");
  const ordered = useMemo(() => {
    const rank = { urgent: 0, decision: 1, info: 2 } as const;
    return [...list].sort((a, b) => rank[a.severity] - rank[b.severity] || b.createdAt - a.createdAt);
  }, [list]);
  return (
    <section>
      <div className="row between">
        <h2>Decisions for you</h2>
        <label className="toggle"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show answered</label>
      </div>
      <p className="lede">Agents only ask when policy says a human must decide, or when they found something you should know. Everything else is already done.</p>
      {asks === undefined ? <Loading label="Loading decisions…" /> : ordered.length === 0 && <div className="empty"><strong>Nothing needs you right now.</strong>New decisions will appear here when the agents need your input.</div>}
      {ordered.map((a) => <AskCard key={a._id} runId={runId} ask={a} />)}
    </section>
  );
}

function AskCard({ runId, ask }: { runId: string; ask: Doc<"asks"> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const choose = async (optionId: string) => {
    setBusy(true);
    setResult(null);
    setFailed(false);
    try {
      const r = await gateway(runId, `asks/${ask._id}/answer`, { method: "POST", body: { optionId } });
      setResult(r.effects?.length ? r.effects.join(", ") : "answered");
    } catch (e) {
      setFailed(true);
      setResult(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`ask ${ask.severity} ${ask.status}`}>
      <div className="ask-heading">
        <span className="severity">{ask.severity === "urgent" ? "Needs attention" : ask.severity === "decision" ? "Your decision" : "For your information"}</span>
        <span className="ask-meta"><span>{ask.from}</span><time dateTime={new Date(ask.createdAt).toISOString()}>{ago(ask.createdAt)}</time></span>
      </div>
      <h3 className="ask-title">{ask.title}</h3>
      <pre className="ask-body">{ask.body}</pre>
      {ask.evidence.length > 0 && (
        <div className="chips">
          {ask.evidence.map((e) => <span key={e.ref} className="chip" title={e.ref}>{e.label}: {e.ref.split("/").pop()}</span>)}
        </div>
      )}
      {ask.status === "open" ? (
        <div className="ask-actions" aria-busy={busy}>
          {ask.options.map((o, i) => (
            <button type="button" key={o.id} disabled={busy} aria-busy={busy} className={i === 0 ? "primary" : ""} onClick={() => choose(o.id)}>{o.label}</button>
          ))}

        </div>
      ) : (
        <div className="muted">Answered: {ask.options.find((o) => o.id === ask.answer?.optionId)?.label ?? ask.answer?.optionId}</div>
      )}
      {result && <p className={`feedback ${failed ? "error" : ""}`} role={failed ? "alert" : "status"}>{result}</p>}
    </article>
  );
}

function Org({ runId }: { runId: string }) {
  const seats = useQuery(api.seats.list, { runId });
  const stats = useQuery(api.tasks.queueStats, { runId });
  const activity = useQuery(api.observe.activity, { runId, limit: 300 });
  const last = new Map<string, Doc<"activity">>();
  for (const a of activity ?? []) if (!last.has(a.seatId)) last.set(a.seatId, a);
  const children = (parent?: string) => (seats ?? []).filter((s) => s.reportsTo === parent);
  const renderNode = (seatId: string, depth: number) => {
    const s = (seats ?? []).find((x) => x.seatId === seatId);
    if (!s) return null;
    const q = stats?.[s.role];
    const act = last.get(s.seatId);
    return (
      <Fragment key={s.seatId}>
        <div className={`seat ${s.kind} ${s.status}`} style={{ "--depth": depth } as CSSProperties}>
          <div className="row between">
            <div>
              <div className="seat-name">{s.name}</div><div className="seat-details">{s.role}{s.spawnedBy ? ` (hired by ${s.spawnedBy})` : ""}{s.status === "retired" ? " (retired)" : ""}</div>
            </div>
            <span className="seat-stats">{q && <><span>{q.queued ?? 0} queued</span><span>{q.done ?? 0} done</span>{!!q.waiting && <span>{q.waiting} waiting</span>}</>}</span>
          </div>
          {act && <div className="seat-act">{act.text} <span className="muted">({ago(act.at)})</span></div>}
        </div>
        {children(s.seatId).map((c) => renderNode(c.seatId, depth + 1))}
      </Fragment>
    );
  };
  return (
    <section>
      <h2>The team</h2>
      <p className="lede">Every seat is a principal with its own identity and limits, enforced by the kernel. The CFO agent hires extra clerks when queues back up.</p>
      {seats === undefined ? <Loading label="Loading the team…" /> : seats.length === 0 ? <div className="empty">No seats registered in this scenario.</div> : children(undefined).map((s) => renderNode(s.seatId, 0))}
    </section>
  );
}

function Activity({ runId }: { runId: string }) {
  const rows = useQuery(api.observe.activity, { runId, limit: 200 });
  return (
    <section>
      <h2>Live activity</h2>
      {rows === undefined ? <Loading label="Loading activity…" /> : rows.length === 0 && <div className="empty">No activity recorded yet. Events will appear as the agents work.</div>}
      <div className="table-scroll"><table className="grid responsive-table">
        <thead><tr><th>When</th><th>Seat</th><th>What</th><th>Status</th></tr></thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r._id} className={r.kind}>
              <td data-label="When" className="muted nowrap">{ago(r.at)}</td>
              <td data-label="Seat" className="nowrap">{r.seatId}</td>
              <td data-label="What">{r.text}</td>
              <td data-label="Status"><span className={`tag ${r.kind}`}>{r.kind}</span></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  );
}

function Ledger({ runId }: { runId: string }) {
  const tb = useQuery(api.ledger.trialBalance, { runId });
  const entries = useQuery(api.ledger.entries, { runId, limit: 60 });
  const chain = useQuery(api.ledger.verifyChain, { runId });
  return (
    <section>
      <div className="row between">
        <h2>Ledger</h2>
        <span className={`pill ${chain ? chain.ok ? "ok" : "bad" : ""}`}>{chain ? (chain.ok ? `Hash chain verified (${chain.entries} entries)` : "Hash chain broken") : "verifying"}</span>
      </div>
      {entries === undefined && <Loading label="Loading ledger…" />}
      <div className="two">
        <div className="table-scroll"><table className="grid">
          <caption>Trial balance</caption>
          <thead><tr><th>Account</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {(tb ?? []).map((a) => (
              <tr key={a.code}><td data-label="Account">{a.code} {a.name}</td><td data-label="Balance" className="num">{$(a.type === "asset" || a.type === "expense" ? a.net : -a.net)}</td></tr>
            ))}
          </tbody>
        </table></div>
        <div className="table-scroll"><table className="grid responsive-table">
          <caption>Journal entries</caption>
          <thead><tr><th>#</th><th>Date</th><th>Entry</th><th className="num">Amount</th><th>By</th><th>Why</th></tr></thead>
          <tbody>
            {entries?.length === 0 && <tr><td colSpan={6}>No entries posted yet.</td></tr>}
            {(entries ?? []).map((e) => (
              <tr key={e._id}>
                <td data-label="#" className="muted nowrap">{e.sequence}</td>
                <td data-label="Date" className="nowrap">{e.date}</td>
                <td data-label="Entry">{e.memo}{e.status === "reversed" && <span className="tag blocked"> reversed</span>}</td>
                <td data-label="Amount" className="num">{$(e.totalCents)}</td>
                <td data-label="By" className="nowrap">{e.postedBy}</td>
                <td data-label="Why" className="muted mono" title={e.decisionPath}>{e.decisionPath ? e.decisionPath.split("/").pop()?.slice(0, 22) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </section>
  );
}

function Memory({ runId }: { runId: string }) {
  const commits = useQuery(api.observe.commits, { runId, limit: 150 });
  const [open, setOpen] = useState<{ path: string; text: string; blame?: { author: string; text: string }[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const viewer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open || error) viewer.current?.focus();
  }, [open, error]);
  const show = async (p: string) => {
    const current = ++request.current;
    setLoading(true);
    setError(null);
    setOpen(null);
    try {
      const [{ text }, blame] = await Promise.all([gateway(runId, `memory/show?path=${encodeURIComponent(p)}`), gateway(runId, `memory/blame?path=${encodeURIComponent(p)}`)]);
      if (current === request.current) setOpen({ path: p, text: text ?? "(not on main)", blame });
    } catch (e) {
      if (current === request.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current === request.current) setLoading(false);
    }
  };
  return (
    <section>
      <h2>Company memory (git)</h2>
      <p className="lede">Structured, schema-checked records. Every change is a commit by the seat that made it. Bank details, policies and agent-written code need a different seat to merge.</p>
      {commits === undefined ? <Loading label="Loading commits…" /> : commits.length === 0 && <div className="empty">No commits recorded yet. Agent changes will appear here.</div>}
      <div className="two memory-layout">
        <div className="table-scroll"><table className="grid responsive-table">
          <thead><tr><th>Commit</th><th>Author</th><th>Message</th></tr></thead>
          <tbody>
            {(commits ?? []).map((c) => (
              <tr key={c._id}>
                <td data-label="Commit"><button type="button" className="record-link" disabled={!c.paths[0]} aria-label={`Read commit ${c.sha.slice(0, 8)}`} onClick={() => c.paths[0] && show(c.paths[0])}>{c.sha.slice(0, 8)}</button>{c.branch !== "main" && <span className="tag held"> {c.branch}</span>}</td>
                <td data-label="Author" className="nowrap">{c.author}</td>
                <td data-label="Message">{c.message}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div className="viewer" ref={viewer} tabIndex={-1} aria-label="Selected memory record" aria-live="polite" aria-busy={loading}>
          {loading ? <Loading label="Reading the record…" /> : error ? <p className="feedback error" role="alert">{error}. Check the human gateway, then select the commit to try again.</p> : open ? (
            <>
              <div className="mono muted">{open.path}</div>
              <pre className="file">{open.blame?.length ? open.blame.map((b) => `${b.author.padEnd(22).slice(0, 22)} │ ${b.text}`).join("\n") : open.text}</pre>
            </>
          ) : <div className="empty">Click a commit to see the record with line-by-line authorship.</div>}
        </div>
      </div>
    </section>
  );
}

function Evals({ runId }: { runId: string }) {
  const [report, setReport] = useState<null | Record<string, any>>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReport(null);
    setErr(null);
    gateway(runId, "eval").then((data) => {
      if (!cancelled) { setReport(data); setLoading(false); }
    }, (e) => {
      if (!cancelled) { setErr(String(e)); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [runId]);
  if (err) return <section><h2>Evals</h2><div className="empty" role="alert">{err}. Check the human gateway and run <code>npm run eval</code> to generate a report.</div></section>;
  if (loading) return <section><h2>Evals</h2><Loading label="Loading evaluation…" /></section>;
  if (!report) return <section><h2>Evals</h2><div className="empty">No eval report for this scenario. Run <code>npm run eval</code>.</div></section>;
  const s = report.summary;
  return (
    <section>
      <h2>Eval: {report.runId}</h2>
      <div className="kpis inline">
        <div className="kpi"><div className="kl">Planted errors caught</div><div className="kv">{s.caught}/{s.planted}</div></div>
        <div className="kpi"><div className="kl">$ at risk caught</div><div className="kv">{$(s.dollarsCaught)}</div></div>
        <div className="kpi"><div className="kl">Decoys handled</div><div className="kv">{s.decoysCorrect}/{s.decoys}</div></div>
        <div className="kpi"><div className="kl">False alarms</div><div className="kv">{s.falseAlarmCount}</div></div>
        <div className="kpi"><div className="kl">Wall clock</div><div className="kv">{report.wallSeconds}s</div></div>
      </div>
      <div className="table-scroll"><table className="grid responsive-table">
        <thead><tr><th>Planted error</th><th>Caught</th><th className="num">$ at risk</th><th>How</th></tr></thead>
        <tbody>{report.errors.map((e: any) => <tr key={e.id}><td data-label="Planted error">{e.type}</td><td data-label="Caught">{e.caught ? "yes" : <b>no</b>}</td><td data-label="$ at risk" className="num">{$(e.amountAtRiskCents)}</td><td data-label="How">{e.how}</td></tr>)}</tbody>
      </table></div>
      <div className="table-scroll"><table className="grid responsive-table">
        <thead><tr><th>Books</th><th className="num">Expected</th><th className="num">Actual</th><th className="num">Diff</th></tr></thead>
        <tbody>{report.books.map((b: any) => <tr key={b.metric}><td data-label="Books">{b.metric}</td><td data-label="Expected" className="num">{$(b.expected)}</td><td data-label="Actual" className="num">{$(b.actual)}</td><td data-label="Diff" className="num">{b.diff === 0 ? "0" : $(b.diff)}</td></tr>)}</tbody>
      </table></div>
    </section>
  );
}

function Control({ runId }: { runId: string }) {
  const [log, setLog] = useState<string[]>([]);
  const [q, setQ] = useState("Why did we short-pay Golden State Produce?");
  const [answer, setAnswer] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const fire = async (kind: string) => {
    setPending(kind);
    try {
      await gateway(runId, "chaos", { method: "POST", body: { kind } });
      setLog((l) => [`${new Date().toLocaleTimeString()} injected ${kind}`, ...l]);
    } catch (e) {
      setLog((l) => [`${kind} failed: ${e instanceof Error ? e.message : e}`, ...l]);
    } finally {
      setPending(null);
    }
  };
  const ask = async () => {
    setAsking(true);
    setAnswer(null);
    try {
      setAnswer((await gateway(runId, "why", { method: "POST", body: { question: q } })).answer);
    } catch (e) {
      setAnswer(String(e));
    } finally {
      setAsking(false);
    }
  };
  return (
    <section>
      <h2>Control room</h2>
      <p className="lede">Throw the outside world at the team and watch it respond. Then ask why it did what it did; answers cite the record.</p>
      <div className="control-actions" aria-busy={pending !== null}>
        <button type="button" disabled={pending !== null} onClick={() => fire("fraud_bank_change")}>Phishing bank-change email</button>
        <button type="button" disabled={pending !== null} onClick={() => fire("duplicate_invoice")}>Resend an invoice through the portal</button>
        <button type="button" disabled={pending !== null} onClick={() => fire("unexplained_debit")}>Unknown wire out of operating</button>
        <button type="button" disabled={pending !== null} onClick={() => fire("next_day")}>End the day (payment run + digest)</button>
        <button type="button" disabled={pending !== null} onClick={() => fire("close")}>Close the period</button>
      </div>
      {pending && <p className="feedback" role="status">Sending scenario event…</p>}
      <ul className="log" aria-live="polite">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
      <h3>Ask why</h3>
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim() && !asking) void ask(); }}>
        <label className="question-label" htmlFor="question">Question for the team</label>
        <div className="row gap question">
          <input id="question" name="question" required value={q} onChange={(e) => setQ(e.target.value)} className="grow" />
          <button type="submit" className="primary" disabled={asking || !q.trim()} aria-busy={asking}>{asking ? "Asking…" : "Ask"}</button>
        </div>
      </form>
      <div className="feedback" aria-live="polite">{answer && <pre className="ask-body">{answer}</pre>}</div>
    </section>
  );
}
