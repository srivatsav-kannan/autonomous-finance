import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useConvexConnectionState, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { registerWebMcpTools } from "./webmcp";
import { gateway } from "./gateway";
import { Icon } from "./Icon";
import { ReviewDrawer } from "./ReviewDrawer";
import { Ledger } from "./Ledger";
import { Bank } from "./Bank";
import { CaseSummary, CaseWorkspace } from "./CaseWorkspace";
import { caseRecords, type CaseRecords } from "./case-model";
import { FinanceFlow } from "./FinanceFlow";
import { useUrlState } from "./useUrlState";

const $ = (cents: number) => (cents < 0 ? "-" : "") + "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

type Tab = "inbox" | "org" | "activity" | "ledger" | "memory" | "evals" | "control" | "bank" | "flow";
const TABS: { id: Tab; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "bank", label: "Bank & cash" },
  { id: "flow", label: "Finance flow" },
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
    <div className="shell finance-workbench">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <aside className="sidebar">
        <div className="brand">
          <span className="mark" aria-hidden="true">af</span>
          <h1 className="title">Autonomous<br />Finance</h1>
        </div>
        <div className="company"><span className="company-avatar" aria-hidden="true">S</span><div>Sweetgreen, Inc.<span>Simulated company</span></div></div>
        <nav className="side" aria-label="Console views">
          <p className="nav-label">Workspace</p>
          {TABS.map((t) => (
            <button type="button" key={t.id} className={t.id === tab ? "on" : ""} aria-current={t.id === tab ? "page" : undefined} onClick={() => setTab(t.id)}>
              <Icon name={t.id} /><span>{t.label}</span>
              {t.id === "inbox" && runId && <InboxCount runId={runId} />}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer"><span className="operator-avatar" aria-hidden="true">HF</span><div>Human finance lead<span>You oversee. Agents operate.</span></div></div>
      </aside>
      <div className="workspace">
        <header className="workspace-top">
          <div className="breadcrumb"><span>Workspace</span><Icon name="chevron" /><span>{TABS.find((t) => t.id === tab)?.label}</span></div>
          <label className="scenario-picker"><span>{runs?.find((r) => r.runId === runId)?.simDate ?? "Scenario"}</span>
            <select value={runId} onChange={(e) => setRunId(e.target.value)} aria-label="Scenario" disabled={!runs?.length}>
              {!runs?.length && <option value={runId}>{runs ? "No scenarios" : "Loading scenarios…"}</option>}
              {(runs ?? []).map((r) => <option key={r.runId} value={r.runId}>{r.label} ({r.runId})</option>)}
            </select>
          </label>
        </header>
        <div className="workspace-content">
          <label className="mobile-nav"><span>Autonomous Finance<small>Sweetgreen, Inc. · simulated</small></span>
            <select value={tab} onChange={(e) => setTab(e.target.value as Tab)} aria-label="Console view">
              {TABS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          {!connection.isWebSocketConnected && <p className="connection-note" role="status">Connecting to the finance backend. Check that it is running if this continues.</p>}
          {runId && tab !== "bank" && tab !== "flow" && tab !== "inbox" && <Kpis runId={runId} />}
          <main className="main" id="main" tabIndex={-1} key={runId}>
            {!runId ? runs === undefined ? <Loading label="Loading scenarios…" /> : <div className="empty"><strong>No scenarios yet.</strong>Run <code>npm run world</code> to start a simulation.</div> : <>
              {tab === "inbox" && <Inbox runId={runId} />}
              {tab === "bank" && <Bank runId={runId} onReview={(askId) => { const url = new URL(location.href); url.searchParams.set("ask", askId); history.replaceState(null, "", url); setTab("inbox"); }} />}
              {tab === "flow" && <FinanceFlow runId={runId} onNavigate={setTab} />}
              {tab === "org" && <Org runId={runId} />}
              {tab === "activity" && <Activity runId={runId} />}
              {tab === "ledger" && <Ledger runId={runId} />}
              {tab === "memory" && <Memory runId={runId} />}
              {tab === "evals" && <Evals runId={runId} />}
              {tab === "control" && <Control runId={runId} />}
            </>}
          </main>
        </div>
      </div>
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
      <details className="simulation-details"><summary>Simulation activity <span>{o.run?.simDate ?? "No date"}</span></summary>
      <dl className="metrics" aria-label="Simulation activity">
        {metrics.map((k) => <div key={k.label}><dt>{k.label}</dt><dd>{k.value}</dd></div>)}
      </dl>
      </details>
    </>
  );
}

function InboxCount({ runId }: { runId: string }) {
  const open = useQuery(api.asks.list, { runId, status: "open", to: "human_cfo" });
  const n = open?.filter((a) => a.severity !== "info").length ?? 0;
  return n ? <span className="badge" aria-label={`${n} decisions need attention`}>{n}</span> : null;
}

const INBOX_FILTERS = ["review", "updates", "answered"] as const;
type InboxFilter = typeof INBOX_FILTERS[number];
const INBOX_SORTS = ["priority", "newest"] as const;
const seatName = (id: string) => id.split(/[-_]/).map((part) => /^(cfo|ap|ar|hr)$/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
const askStatus = (ask: Doc<"asks">) => ask.status === "answered" ? "Answered" : ask.severity === "urgent" ? "Needs attention" : ask.severity === "decision" ? "Needs review" : "Update";

function Inbox({ runId }: { runId: string }) {
  const [filter, setFilter] = useUrlState("inboxFilter", "review", INBOX_FILTERS);
  const [search, setSearch] = useUrlState("inboxSearch");
  const [sort, setSort] = useUrlState("inboxSort", "priority", INBOX_SORTS);
  const [selectedId, setSelectedId] = useUrlState("ask");
  const [responseRecorded, setResponseRecorded] = useState(false);
  const [previewId, setPreviewId] = useUrlState("case");
  const bills = useQuery(api.ap.bills, { runId });
  const payments = useQuery(api.payments.intents, { runId });
  const openRecord = (id: string) => { setResponseRecorded(false); setSelectedId(id); };
  const asks = useQuery(api.asks.list, { runId, to: "human_cfo" });
  const belongs = (ask: Doc<"asks">, group: InboxFilter) => group === "answered" ? ask.status === "answered" : ask.status === "open" && (group === "updates" ? ask.severity === "info" : ask.severity !== "info");
  const groups: { id: InboxFilter; label: string; count: number }[] = [
    { id: "review", label: "Needs review", count: (asks ?? []).filter((a) => belongs(a, "review")).length },
    { id: "updates", label: "Updates", count: (asks ?? []).filter((a) => belongs(a, "updates")).length },
    { id: "answered", label: "Answered", count: (asks ?? []).filter((a) => belongs(a, "answered")).length },
  ];
  const ordered = useMemo(() => {
    const rank = { urgent: 0, decision: 1, info: 2 } as const;
    const query = search.trim().toLowerCase();
    return (asks ?? []).filter((a) => belongs(a, filter) && [a.title, a.body, a.from, seatName(a.from), ...a.evidence.map((e) => e.ref)].join(" ").toLowerCase().includes(query))
      .sort((a, b) => (sort === "priority" ? rank[a.severity] - rank[b.severity] : 0) || b.createdAt - a.createdAt);
  }, [asks, filter, search, sort]);
  const selected = asks?.find((a) => a._id === selectedId);
  const preview = ordered.find((a) => a._id === previewId) ?? ordered[0];
  const recordsFor = (a: Doc<"asks">) => caseRecords(a, bills ?? [], payments ?? []);
  const next = (asks ?? []).filter((a) => belongs(a, "review")).sort((a, b) => Number(b.severity === "urgent") - Number(a.severity === "urgent") || a.createdAt - b.createdAt)[0];
  const close = () => setSelectedId("");
  return (
    <section className="inbox-view">
      <div className="page-heading">
        <div><h2 id="inbox-heading" tabIndex={-1}>Decisions for you</h2>
          <p className="lede">{asks === undefined ? "Your team's requests, with the evidence to decide." : groups[0]!.count ? `${groups[0]!.count} ${groups[0]!.count === 1 ? "decision needs" : "decisions need"} your review. Your team is handling the routine work.` : "You're up to date. Your team is handling the routine work."}</p>
        </div>
        {next && <button type="button" className="primary button-icon" onClick={() => openRecord(next._id)}>Review next<Icon name="arrow" /></button>}
      </div>
      <div className="inbox-workbench"><div className="inbox-queue">
      <div className="tab-strip" role="group" aria-label="Filter inbox">
        {groups.map((g) => <button type="button" key={g.id} className={`tab-item ${filter === g.id ? "is-active" : ""}`} aria-pressed={filter === g.id} onClick={() => setFilter(g.id)}>{g.label}<span>{asks === undefined ? "—" : g.count}</span></button>)}
      </div>
      <div className="table-toolbar">
        <label className="search-field"><Icon name="search" /><input type="search" aria-label="Search inbox" placeholder="Search decisions, people, or evidence" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label className="toolbar-select">Sort by<select aria-label="Sort inbox" value={sort} onChange={(e) => setSort(e.target.value as typeof INBOX_SORTS[number])}><option value="priority">Priority</option><option value="newest">Newest first</option></select></label>
      </div>
      {asks === undefined ? <Loading label="Loading decisions…" /> : ordered.length === 0 ? <div className="empty queue-empty"><Icon name={search ? "search" : "check"} /><strong>{search ? "No matching records" : filter === "review" ? "All decisions reviewed" : filter === "updates" ? "No new updates" : "No answered decisions yet"}</strong><p>{search ? "Try a different search or switch the inbox filter." : "New records will appear here as your team works."}</p>{search && <button type="button" onClick={() => setSearch("")}>Clear search</button>}</div> : (
        <div className="table-scroll queue-table"><table className="grid decision-table">
          <caption className="visually-hidden">{groups.find((g) => g.id === filter)?.label} in {runId}</caption>
          <thead><tr><th>Decision</th><th>From</th><th>Status</th><th>Evidence</th><th>Received</th></tr></thead>
          <tbody>{ordered.map((a) => <tr key={a._id} className={preview?._id === a._id ? "case-selected" : ""}>
            <td className="decision-subject"><button type="button" className="decision-link" onClick={() => setPreviewId(a._id)} aria-pressed={preview?._id === a._id} aria-label={`Review ${a.title}`}><span>{a.title}</span><Icon name="chevron" /></button><p className="decision-excerpt">{a.body.split("\n")[0]}</p></td>
            <td className="decision-from"><span className="agent-avatar" aria-hidden="true">{a.from.slice(0, 2).toUpperCase()}</span><span>{seatName(a.from)}</span></td>
            <td className="decision-state"><span className={`status-label ${a.status === "answered" ? "answered" : a.severity}`}>{askStatus(a)}</span></td>
            <td className="decision-evidence">{a.evidence.length ? <span className="evidence-count"><Icon name="file" />{a.evidence.length} {a.evidence.length === 1 ? "record" : "records"}</span> : <span className="muted">None</span>}</td>
            <td className="decision-time muted"><time dateTime={new Date(a.createdAt).toISOString()} title={new Date(a.createdAt).toLocaleString()}>{ago(a.createdAt)}</time></td>
          </tr>)}</tbody>
        </table></div>
      )}
      {asks !== undefined && <p className="table-summary" role="status">{ordered.length} {ordered.length === 1 ? "record" : "records"}{search ? " matching your search" : ` in ${groups.find((g) => g.id === filter)?.label.toLowerCase()}`}<span>Live from the selected simulation</span></p>}
      </div>
      <aside className="case-preview" aria-label="Selected case preview">
        {preview ? <>
          {bills === undefined || payments === undefined ? <Loading label="Loading case records…" /> : <CaseSummary ask={preview} records={recordsFor(preview)} />}
          <h4>Why this needs attention</h4><p className="case-preview-body">{preview.body}</p>
          <h4>Related evidence</h4>{preview.evidence.length ? preview.evidence.map((e) => <div className="preview-evidence" key={e.ref}><Icon name="file" /><span>{e.label}</span><span>Linked</span></div>) : <p className="muted">Open the case to review linked bills and payments.</p>}
          <button type="button" className="primary open-case" onClick={() => openRecord(preview._id)}>Open case<Icon name="chevron" /></button>
          <p className="source-caption">Your queue position is kept when you close the case.</p>
        </> : <p className="muted">Select a decision to see its context and evidence.</p>}
      </aside></div>
      <ReviewDrawer wide open={!!selected} onClose={close} labelledBy="review-title" fallbackFocusId="inbox-heading" preferFallbackFocus={responseRecorded}>
        {selected && <AskDetail key={selected._id} runId={runId} ask={selected} asks={asks ?? []} records={recordsFor(selected)} onAnswered={() => setResponseRecorded(true)} />}
      </ReviewDrawer>
    </section>
  );
}


function AskDetail({ runId, ask, asks, records, onAnswered }: { runId: string; ask: Doc<"asks">; asks: Doc<"asks">[]; records: CaseRecords; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const confirmation = useRef<HTMLParagraphElement>(null);
  const choose = async (optionId: string) => {
    if (busy || submitted) return;
    setBusy(true); setResult(null); setFailed(false);
    try {
      const r = await gateway(runId, `asks/${ask._id}/answer`, { method: "POST", body: { optionId } });
      setSubmitted(optionId);
      onAnswered();
      setResult(r.effects?.length ? r.effects.join(", ") : "Your response has been recorded.");
    } catch (e) {
      setFailed(true); setResult(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const answered = ask.status === "answered" || submitted !== null;
  useEffect(() => { if (answered) confirmation.current?.focus({ preventScroll: true }); }, [answered]);
  return <article className="review-detail">
    <header className="drawer-header"><h2 id="review-title">{ask.title}</h2><span className={`status-label ${answered ? "answered" : ask.severity}`}>{answered ? "Answered" : askStatus(ask)}</span></header>
    <div className="drawer-body case-body">
      <CaseWorkspace runId={runId} ask={ask} asks={asks} records={records} />
    </div>
    <footer className="drawer-footer">
      {result && <p className={`feedback ${failed ? "error" : ""}`} role={failed ? "alert" : "status"}>{result}</p>}
      {!answered ? <><p className="action-hint">Your response will be sent to {seatName(ask.from)}.</p><div className="ask-actions" aria-busy={busy}>{ask.options.map((o, i) => <button type="button" key={o.id} disabled={busy} aria-busy={busy} className={i === 0 ? "primary" : ""} onClick={() => void choose(o.id)}>{o.label}</button>)}</div></> : <p className="response-confirmed" ref={confirmation} tabIndex={-1}><Icon name="check" />{ask.options.find((o) => o.id === (ask.answer?.optionId ?? submitted))?.label ?? "Response recorded"}</p>}
    </footer>
  </article>;
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
