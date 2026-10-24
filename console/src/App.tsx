import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { registerWebMcpTools } from "./webmcp";
import { gateway } from "./gateway";

const $ = (cents: number) => (cents < 0 ? "-" : "") + "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
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

export function App() {
  const runs = useQuery(api.admin.runs, {});
  const [runId, setRunId] = useState<string>(() => decodeURIComponent(location.hash.slice(1)));
  const [tab, setTab] = useState<Tab>("inbox");
  useEffect(() => {
    if (!runId && runs?.length) setRunId(runs[0]!.runId);
  }, [runs, runId]);
  useEffect(() => {
    if (runId) location.hash = encodeURIComponent(runId);
  }, [runId]);
  useEffect(() => {
    if (runId) return registerWebMcpTools(runId);
  }, [runId]);

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="mark">AF</span>
          <div>
            <div className="title">Autonomous Finance</div>
            <div className="sub">Sweetgreen, Inc. (simulated) · agents run the finance function, you oversee</div>
          </div>
        </div>
        <select value={runId} onChange={(e) => setRunId(e.target.value)} aria-label="Scenario">
          {(runs ?? []).map((r) => (
            <option key={r.runId} value={r.runId}>{r.label} · {r.runId}</option>
          ))}
        </select>
      </header>
      {runId ? <Kpis runId={runId} /> : <div className="empty">No scenarios yet. Run <code>npm run world</code>.</div>}
      {runId && (
        <div className="body">
          <nav className="side">
            {TABS.map((t) => (
              <button key={t.id} className={t.id === tab ? "on" : ""} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === "inbox" && <InboxCount runId={runId} />}
              </button>
            ))}
          </nav>
          <main className="main">
            {tab === "inbox" && <Inbox runId={runId} />}
            {tab === "org" && <Org runId={runId} />}
            {tab === "activity" && <Activity runId={runId} />}
            {tab === "ledger" && <Ledger runId={runId} />}
            {tab === "memory" && <Memory runId={runId} />}
            {tab === "evals" && <Evals runId={runId} />}
            {tab === "control" && <Control runId={runId} />}
          </main>
        </div>
      )}
    </div>
  );
}

function Kpis({ runId }: { runId: string }) {
  const o = useQuery(api.observe.overview, { runId });
  if (!o) return <div className="kpis" />;
  const items = [
    { label: "Sim date", value: o.run?.simDate ?? "-" },
    { label: "Cash", value: $(o.cashCents) },
    { label: "Accounts payable", value: $(o.apCents) },
    { label: "Revenue to date", value: $(o.revenueCents) },
    { label: "Ledger entries", value: o.entries.toLocaleString() },
    { label: "Agent turns", value: `${o.agentTurns.toLocaleString()} (${o.llmTurns} Claude)` },
    { label: "Model spend", value: `$${(o.costMicros / 1e6).toFixed(2)}` },
    { label: "Blocked by kernel", value: String(o.blockedAttempts) },
  ];
  return (
    <div className="kpis">
      {items.map((k) => (
        <div key={k.label} className="kpi">
          <div className="kl">{k.label}</div>
          <div className="kv">{k.value}</div>
        </div>
      ))}
    </div>
  );
}

function InboxCount({ runId }: { runId: string }) {
  const open = useQuery(api.asks.list, { runId, status: "open", to: "human_cfo" });
  const n = open?.filter((a) => a.severity !== "info").length ?? 0;
  return n ? <span className="badge">{n}</span> : null;
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
        <label className="toggle"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show answered</label>
      </div>
      <p className="lede">Agents only ask when policy says a human must decide, or when they found something you should know. Everything else is already done.</p>
      {ordered.length === 0 && <div className="empty">Nothing needs you right now.</div>}
      {ordered.map((a) => <AskCard key={a._id} runId={runId} ask={a} />)}
    </section>
  );
}

function AskCard({ runId, ask }: { runId: string; ask: Doc<"asks"> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const choose = async (optionId: string) => {
    setBusy(true);
    try {
      const r = await gateway(runId, `asks/${ask._id}/answer`, { method: "POST", body: { optionId } });
      setResult(r.effects?.length ? r.effects.join(", ") : "answered");
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`ask ${ask.severity} ${ask.status}`}>
      <div className="row between">
        <div className="ask-title">{ask.title}</div>
        <span className="muted">{ask.from} · {ago(ask.createdAt)}</span>
      </div>
      <pre className="ask-body">{ask.body}</pre>
      {ask.evidence.length > 0 && (
        <div className="chips">
          {ask.evidence.map((e) => <span key={e.ref} className="chip" title={e.ref}>{e.label}: {e.ref.split("/").pop()}</span>)}
        </div>
      )}
      {ask.status === "open" ? (
        <div className="row gap">
          {ask.options.map((o, i) => (
            <button key={o.id} disabled={busy} className={i === 0 ? "primary" : ""} onClick={() => choose(o.id)}>{o.label}</button>
          ))}
          {result && <span className="muted">{result}</span>}
        </div>
      ) : (
        <div className="muted">Answered: {ask.options.find((o) => o.id === ask.answer?.optionId)?.label ?? ask.answer?.optionId}</div>
      )}
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
  const Node = ({ seatId, depth }: { seatId: string; depth: number }) => {
    const s = (seats ?? []).find((x) => x.seatId === seatId);
    if (!s) return null;
    const q = stats?.[s.role];
    const act = last.get(s.seatId);
    return (
      <>
        <div className={`seat ${s.kind} ${s.status}`} style={{ marginLeft: depth * 22 }}>
          <div className="row between">
            <div>
              <span className="seat-name">{s.name}</span> <span className="muted">{s.role}{s.spawnedBy ? ` · hired by ${s.spawnedBy}` : ""}</span>
            </div>
            <span className="muted">{q ? `${q.queued ?? 0} queued · ${q.done ?? 0} done${q.waiting ? ` · ${q.waiting} waiting` : ""}` : ""}</span>
          </div>
          {act && <div className="seat-act">{act.text} <span className="muted">· {ago(act.at)}</span></div>}
        </div>
        {children(s.seatId).map((c) => <Node key={c.seatId} seatId={c.seatId} depth={depth + 1} />)}
      </>
    );
  };
  return (
    <section>
      <h2>The team</h2>
      <p className="lede">Every seat is a principal with its own identity and limits, enforced by the kernel. The CFO agent hires extra clerks when queues back up.</p>
      {children(undefined).map((s) => <Node key={s.seatId} seatId={s.seatId} depth={0} />)}
    </section>
  );
}

function Activity({ runId }: { runId: string }) {
  const rows = useQuery(api.observe.activity, { runId, limit: 200 });
  return (
    <section>
      <h2>Live activity</h2>
      <table className="grid">
        <thead><tr><th>When</th><th>Seat</th><th>What</th><th /></tr></thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r._id} className={r.kind}>
              <td className="muted nowrap">{ago(r.at)}</td>
              <td className="nowrap">{r.seatId}</td>
              <td>{r.text}</td>
              <td><span className={`tag ${r.kind}`}>{r.kind}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
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
        <span className={`pill ${chain?.ok ? "ok" : "bad"}`}>{chain ? (chain.ok ? `hash chain verified · ${chain.entries} entries` : "CHAIN BROKEN") : "verifying"}</span>
      </div>
      <div className="two">
        <table className="grid">
          <thead><tr><th>Account</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {(tb ?? []).map((a) => (
              <tr key={a.code}><td>{a.code} {a.name}</td><td className="num">{$(a.type === "asset" || a.type === "expense" ? a.net : -a.net)}</td></tr>
            ))}
          </tbody>
        </table>
        <table className="grid">
          <thead><tr><th>#</th><th>Date</th><th>Entry</th><th className="num">Amount</th><th>By</th><th>Why</th></tr></thead>
          <tbody>
            {(entries ?? []).map((e) => (
              <tr key={e._id}>
                <td className="muted">{e.sequence}</td>
                <td className="nowrap">{e.date}</td>
                <td>{e.memo}{e.status === "reversed" && <span className="tag blocked"> reversed</span>}</td>
                <td className="num">{$(e.totalCents)}</td>
                <td className="nowrap">{e.postedBy}</td>
                <td className="muted mono" title={e.decisionPath}>{e.decisionPath ? e.decisionPath.split("/").pop()?.slice(0, 22) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Memory({ runId }: { runId: string }) {
  const commits = useQuery(api.observe.commits, { runId, limit: 150 });
  const [open, setOpen] = useState<{ path: string; text: string; blame?: { author: string; text: string }[] } | null>(null);
  const show = async (p: string) => {
    const [{ text }, blame] = await Promise.all([gateway(runId, `memory/show?path=${encodeURIComponent(p)}`), gateway(runId, `memory/blame?path=${encodeURIComponent(p)}`)]);
    setOpen({ path: p, text: text ?? "(not on main)", blame });
  };
  return (
    <section>
      <h2>Company memory (git)</h2>
      <p className="lede">Structured, schema-checked records. Every change is a commit by the seat that made it. Bank details, policies and agent-written code need a different seat to merge.</p>
      <div className="two">
        <table className="grid">
          <thead><tr><th>Commit</th><th>Author</th><th>Message</th></tr></thead>
          <tbody>
            {(commits ?? []).map((c) => (
              <tr key={c._id} onClick={() => c.paths[0] && show(c.paths[0])} className="click">
                <td className="mono muted">{c.sha.slice(0, 8)}{c.branch !== "main" && <span className="tag held"> {c.branch}</span>}</td>
                <td className="nowrap">{c.author}</td>
                <td>{c.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="viewer">
          {open ? (
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
  useEffect(() => {
    gateway(runId, "eval").then(setReport, (e) => setErr(String(e)));
  }, [runId]);
  if (err) return <div className="empty">{err}</div>;
  if (!report) return <div className="empty">No eval report for this scenario. Run <code>npm run eval</code>.</div>;
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
      <table className="grid">
        <thead><tr><th>Planted error</th><th>Caught</th><th className="num">$ at risk</th><th>How</th></tr></thead>
        <tbody>{report.errors.map((e: any) => <tr key={e.id}><td>{e.type}</td><td>{e.caught ? "yes" : <b>no</b>}</td><td className="num">{$(e.amountAtRiskCents)}</td><td>{e.how}</td></tr>)}</tbody>
      </table>
      <table className="grid">
        <thead><tr><th>Books</th><th className="num">Expected</th><th className="num">Actual</th><th className="num">Diff</th></tr></thead>
        <tbody>{report.books.map((b: any) => <tr key={b.metric}><td>{b.metric}</td><td className="num">{$(b.expected)}</td><td className="num">{$(b.actual)}</td><td className="num">{b.diff === 0 ? "0" : $(b.diff)}</td></tr>)}</tbody>
      </table>
    </section>
  );
}

function Control({ runId }: { runId: string }) {
  const [log, setLog] = useState<string[]>([]);
  const [q, setQ] = useState("Why did we short-pay Golden State Produce?");
  const [answer, setAnswer] = useState<string | null>(null);
  const fire = async (kind: string) => {
    try {
      await gateway(runId, "chaos", { method: "POST", body: { kind } });
      setLog((l) => [`${new Date().toLocaleTimeString()} injected ${kind}`, ...l]);
    } catch (e) {
      setLog((l) => [`${kind} failed: ${e instanceof Error ? e.message : e}`, ...l]);
    }
  };
  const ask = async () => {
    setAnswer("thinking…");
    try {
      setAnswer((await gateway(runId, "why", { method: "POST", body: { question: q } })).answer);
    } catch (e) {
      setAnswer(String(e));
    }
  };
  return (
    <section>
      <h2>Control room</h2>
      <p className="lede">Throw the outside world at the team and watch it respond. Then ask why it did what it did; answers cite the record.</p>
      <div className="row gap wrap">
        <button onClick={() => fire("fraud_bank_change")}>Phishing bank-change email</button>
        <button onClick={() => fire("duplicate_invoice")}>Resend an invoice through the portal</button>
        <button onClick={() => fire("unexplained_debit")}>Unknown wire out of operating</button>
        <button onClick={() => fire("next_day")}>End the day (payment run + digest)</button>
        <button onClick={() => fire("close")}>Close the period</button>
      </div>
      <ul className="log">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
      <h3>Ask why</h3>
      <div className="row gap">
        <input value={q} onChange={(e) => setQ(e.target.value)} className="grow" />
        <button className="primary" onClick={ask}>Ask</button>
      </div>
      {answer && <pre className="ask-body">{answer}</pre>}
    </section>
  );
}
