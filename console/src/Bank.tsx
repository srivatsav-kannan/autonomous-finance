import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { Icon } from "./Icon";
import { ReviewDrawer } from "./ReviewDrawer";
import { EvidenceRecord } from "./EvidenceRecord";
import { useUrlState } from "./useUrlState";
import "./bank.css";

type Workspace = FunctionReturnType<typeof api.bank.workspace>;
type Transaction = Workspace["transactions"][number];
const ACCOUNT_KEYS = ["all", "operating", "payroll", "deposits"] as const;
const FILTERS = ["all", "attention", "in", "out"] as const;
const money = (cents: number) =>
  (cents < 0 ? "−" : "") +
  "$" +
  (Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const shortMoney = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
const accountLabels = {
  operating: "Operating",
  payroll: "Payroll",
  deposits: "Store deposits",
};
const statusLabels = {
  processing: "Processing",
  reconciled: "Reconciled",
  recorded: "Recorded",
  needs_review: "Needs review",
  unmatched: "Unmatched",
};
const statusDescriptions = {
  processing: "The cash agent has not finished matching this transaction.",
  reconciled:
    "The cash agent matched this bank transaction to a settled payment.",
  recorded:
    "A journal entry was posted for this transaction. Posting alone does not confirm reconciliation.",
  needs_review:
    "An exception or a request is attached to this transaction. Review the agent's evidence before deciding.",
  unmatched:
    "No completed match or journal entry was found for this transaction.",
};

export function Bank({
  runId,
  onReview,
}: {
  runId: string;
  onReview: (askId: string) => void;
}) {
  const workspace = useQuery(api.bank.workspace, { runId });
  const [account, setAccount] = useUrlState("bankAccount", "all", ACCOUNT_KEYS);
  const [filter, setFilter] = useUrlState("bankFilter", "all", FILTERS);
  const [search, setSearch] = useUrlState("bankSearch");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (workspace === undefined)
    return (
      <div className="loading" role="status">
        Loading bank activity…
        <span className="loading-bar" />
        <span className="loading-bar" />
      </div>
    );
  if (!workspace.run)
    return (
      <section>
        <h2>Bank & cash</h2>
        <div className="empty">
          This scenario is unavailable. Choose a scenario from the top bar.
        </div>
      </section>
    );
  const scope =
    account === "all"
      ? workspace.totals
      : workspace.accounts.find((a) => a.key === account)!;
  const term = search.trim().toLowerCase();
  const accountRows = workspace.transactions.filter(
    (t) => account === "all" || t.accountKey === account,
  );
  const rows = accountRows.filter(
    (t) =>
      (filter === "all" ||
        (filter === "attention"
          ? t.status === "needs_review" || t.status === "unmatched"
          : filter === "in"
            ? t.amountCents > 0
            : t.amountCents < 0)) &&
      [
        t.description,
        t.txnId,
        t.bankRef ?? "",
        t.date,
        statusLabels[t.status],
        money(t.amountCents),
      ]
        .join(" ")
        .toLowerCase()
        .includes(term),
  );
  const selected = workspace.transactions.find((t) => t.id === selectedId);
  const attention = accountRows.filter(
    (t) => t.status === "needs_review" || t.status === "unmatched",
  ).length;
  const filters = [
    { id: "all", label: "All transactions", count: accountRows.length },
    { id: "attention", label: "Needs attention", count: attention },
    {
      id: "in",
      label: "Money in",
      count: accountRows.filter((t) => t.amountCents > 0).length,
    },
    {
      id: "out",
      label: "Money out",
      count: accountRows.filter((t) => t.amountCents < 0).length,
    },
  ] as const;
  return (
    <section className="bank-view">
      <div className="page-heading">
        <div>
          <h2 id="bank-heading" tabIndex={-1}>
            Bank & cash
          </h2>
          <p className="lede">
            Cash across your accounts, with every movement connected to its
            evidence.
          </p>
        </div>
        <span className="bank-source">
          Simulated bank feed
          <small>Simulation date {workspace.run.simDate || "not set"}</small>
        </span>
      </div>
      <div
        className="bank-accounts"
        role="group"
        aria-label="Choose bank account"
      >
        <button
          type="button"
          className={`bank-account bank-account-total ${account === "all" ? "is-selected" : ""}`}
          aria-pressed={account === "all"}
          onClick={() => setAccount("all")}
        >
          <span>All accounts</span>
          <strong>{money(workspace.totals.bookBalanceCents)}</strong>
          <small>Total book balance</small>
        </button>
        {workspace.accounts.map((a) => (
          <button
            type="button"
            key={a.key}
            className={`bank-account ${account === a.key ? "is-selected" : ""}`}
            aria-pressed={account === a.key}
            onClick={() => setAccount(a.key)}
          >
            <span>
              <Icon name="bank" />
              {accountLabels[a.key]}
            </span>
            <strong>{money(a.bookBalanceCents)}</strong>
            <small>
              {a.bank} / Account {a.code}
            </small>
          </button>
        ))}
      </div>
      <CashChart
        key={account}
        series={workspace.series}
        account={account}
        balance={scope.bookBalanceCents}
        inflow={scope.inflowCents}
        outflow={scope.outflowCents}
      />
      <div className="bank-feed-heading">
        <h3>Bank transactions</h3>
        <span className="muted">
          Simulated transactions and their matching records.
        </span>
      </div>
      {!!workspace.dataBasis.invalidTransactionCount && (
        <p className="feedback error" role="status">
          {workspace.dataBasis.invalidTransactionCount} malformed bank{" "}
          {workspace.dataBasis.invalidTransactionCount === 1
            ? "record was"
            : "records were"}{" "}
          excluded from this feed.
        </p>
      )}
      <div
        className="tab-strip bank-filters"
        role="group"
        aria-label="Filter bank transactions"
      >
        {filters.map((f) => (
          <button
            type="button"
            key={f.id}
            className={`tab-item ${filter === f.id ? "is-active" : ""}`}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            <span>{f.count}</span>
          </button>
        ))}
      </div>
      <div className="table-toolbar">
        <label className="search-field">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search bank transactions"
            placeholder="Search transactions or references"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <span className="muted bank-feed-note">Amounts from the bank feed</span>
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table className="grid responsive-table bank-table">
            <caption className="visually-hidden">
              Bank transactions for {runId}
            </caption>
            <thead>
              <tr>
                <th scope="col">Transaction</th>
                <th scope="col">Date</th>
                <th scope="col">Account</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td data-label="Transaction">
                    <div>
                      <button
                        type="button"
                        className="bank-transaction-link"
                        aria-label={`View ${t.description}, transaction ${t.txnId}`}
                        onClick={() => setSelectedId(t.id)}
                      >
                        <span>{t.description}</span>
                        <Icon name="chevron" />
                      </button>
                      <span className="bank-reference">{t.txnId}</span>
                    </div>
                  </td>
                  <td data-label="Date" className="nowrap">
                    {t.date}
                  </td>
                  <td data-label="Account">{accountLabels[t.accountKey]}</td>
                  <td data-label="Status">
                    <span className={`bank-status bank-status-${t.status}`}>
                      {statusLabels[t.status]}
                    </span>
                  </td>
                  <td
                    data-label="Amount"
                    className={`num ${t.amountCents > 0 ? "bank-credit" : ""}`}
                  >
                    {t.amountCents > 0 ? "+" : ""}
                    {money(t.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <strong>
            {search || filter !== "all"
              ? "No matching transactions"
              : "No bank transactions yet"}
          </strong>
          <p>
            {search || filter !== "all"
              ? "Choose another account or adjust your filters."
              : "The feed will appear when bank events are recorded in this simulation."}
          </p>
          {(search || filter !== "all") && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setFilter("all");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
      <p className="table-summary" role="status">
        {rows.length} of {accountRows.length} transactions
        <span>Book balances are not bank available balances.</span>
      </p>
      <details className="bank-data-basis">
        <summary>About these balances</summary>
        <p>{workspace.dataBasis.description}</p>
      </details>
      <ReviewDrawer
        open={!!selected}
        onClose={() => setSelectedId(null)}
        labelledBy="bank-transaction-title"
        fallbackFocusId="bank-heading"
      >
        {selected && (
          <TransactionDetail
            transaction={selected}
            runId={runId}
            onReview={onReview}
          />
        )}
      </ReviewDrawer>
    </section>
  );
}

function CashChart({
  series,
  account,
  balance,
  inflow,
  outflow,
}: {
  series: Workspace["series"];
  account: (typeof ACCOUNT_KEYS)[number];
  balance: number;
  inflow: number;
  outflow: number;
}) {
  const [selectedDate, setSelectedDate] = useState("");
  const chartContainer = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(990);
  useEffect(() => {
    const element = chartContainer.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [series.length > 0]);
  const selected = series.find((p) => p.date === selectedDate) ?? series.at(-1);
  const value = (point: Workspace["series"][number]) =>
    account === "all" ? point.balanceCents : point.accountBalances[account];
  const values = series.map(value);
  const min = Math.min(...values, balance),
    max = Math.max(...values, balance);
  const padding = Math.max((max - min) * 0.12, Math.abs(max) * 0.02, 100);
  const bottom = min - padding,
    top = max + padding;
  const timestamp = (date: string) => Date.parse(`${date}T00:00:00Z`);
  const start = series.length ? timestamp(series[0]!.date) : 0;
  const end = series.length ? timestamp(series.at(-1)!.date) : 0;
  const x = (index: number) =>
    66 +
    ((timestamp(series[index]!.date) - start) / Math.max(end - start, 1)) *
      (width - 80);
  const y = (amount: number) => 18 + ((top - amount) / (top - bottom)) * 164;
  const selectedIndex = Math.max(
    0,
    series.findIndex((p) => p.date === selected?.date),
  );
  return (
    <section className="cash-history" aria-labelledby="cash-history-heading">
      <div className="cash-chart-heading">
        <div>
          <h3 id="cash-history-heading">Cash balance over time</h3>
          <p>
            {account === "all" ? "All accounts" : accountLabels[account]} /
            Daily closing book balance
          </p>
        </div>
        <label className="toolbar-select">
          View date
          <select
            aria-label="Cash balance date"
            value={selected?.date ?? ""}
            disabled={!series.length}
            onChange={(e) => setSelectedDate(e.target.value)}
          >
            {series.length ? (
              series.map((p) => (
                <option key={p.date} value={p.date}>
                  {p.date}
                </option>
              ))
            ) : (
              <option value="">No dates yet</option>
            )}
          </select>
        </label>
      </div>
      <div className="cash-chart-readout" aria-live="polite">
        <strong>{money(selected ? value(selected) : balance)}</strong>
        <span>
          {selected
            ? `Closing balance on ${selected.date}`
            : "Current book balance"}
        </span>
      </div>
      {series.length ? (
        <svg
          ref={chartContainer}
          className="cash-chart"
          viewBox={`0 0 ${width} 220`}
          role="img"
          aria-label={`Daily cash book balances from ${series[0]!.date} to ${series.at(-1)!.date}. Selected balance ${money(value(selected!))} on ${selected!.date}. Exact balances are available below.`}
        >
          {[top, (top + bottom) / 2, bottom].map((amount, i) => (
            <g key={i}>
              <line
                className="cash-grid"
                x1="66"
                x2={width - 14}
                y1={y(amount)}
                y2={y(amount)}
              />
              <text x="54" y={y(amount) + 4} textAnchor="end">
                {shortMoney(amount)}
              </text>
            </g>
          ))}
          <polyline
            className="cash-line"
            points={series.map((p, i) => `${x(i)},${y(value(p))}`).join(" ")}
          />
          <line
            className="cash-cursor"
            x1={x(selectedIndex)}
            x2={x(selectedIndex)}
            y1="18"
            y2="182"
          />
          <circle
            className="cash-point"
            cx={x(selectedIndex)}
            cy={y(value(selected!))}
            r="4"
          />
          <text x="66" y="212">
            {series[0]!.date}
          </text>
          {series.length > 2 && width > 480 && (
            <text x={width / 2 + 26} y="212" textAnchor="middle">
              {new Date((start + end) / 2).toISOString().slice(0, 10)}
            </text>
          )}
          {series.length > 1 && (
            <text x={width - 14} y="212" textAnchor="end">
              {series.at(-1)!.date}
            </text>
          )}
        </svg>
      ) : (
        <div className="empty cash-chart-empty">
          Cash history will appear after the first journal entry.
        </div>
      )}
      <div className="cash-chart-footer">
        <p>
          <span>Cash debits</span>
          <strong>{money(inflow)}</strong>
        </p>
        <p>
          <span>Cash credits</span>
          <strong>{money(outflow)}</strong>
        </p>
        <details>
          <summary>View daily balances</summary>
          <div className="table-scroll">
            <table className="grid">
              <caption>
                Ledger cash movements, including reversals and transfers
              </caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col" className="num">
                    Closing balance
                  </th>
                </tr>
              </thead>
              <tbody>
                {series.map((p) => (
                  <tr key={p.date}>
                    <td>{p.date}</td>
                    <td className="num">{money(value(p))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </section>
  );
}

function TransactionDetail({
  transaction: t,
  runId,
  onReview,
}: {
  transaction: Transaction;
  runId: string;
  onReview: (id: string) => void;
}) {
  return (
    <article className="review-detail">
      <header className="drawer-header">
        <h2 id="bank-transaction-title">{t.description}</h2>
        <span className={`bank-status bank-status-${t.status}`}>
          {statusLabels[t.status]}
        </span>
      </header>
      <div className="drawer-body">
        <p className="bank-detail-amount">
          {t.amountCents > 0 ? "+" : ""}
          {money(t.amountCents)}
        </p>
        <dl className="bank-transaction-facts">
          <div>
            <dt>Account</dt>
            <dd>
              {accountLabels[t.accountKey]} / {t.accountCode}
            </dd>
          </div>
          <div>
            <dt>Transaction date</dt>
            <dd>{t.date}</dd>
          </div>
          <div>
            <dt>Transaction ID</dt>
            <dd>{t.txnId}</dd>
          </div>
          <div>
            <dt>Bank reference</dt>
            <dd>{t.bankRef ?? "Not provided"}</dd>
          </div>
        </dl>
        <section className="review-section">
          <h3>Match status</h3>
          <p>{statusDescriptions[t.status]}</p>
          {t.summary && <p>{t.summary}</p>}
          {t.taskOutcome && (
            <p className="muted">
              Agent outcome: {t.taskOutcome.replaceAll("_", " ")}
            </p>
          )}
        </section>
        <section className="review-section">
          <h3>Connected records</h3>
          {t.entries.length ? (
            t.entries.map((entry) => (
              <div className="bank-evidence" key={entry.id}>
                <Icon name="ledger" />
                <div>
                  <strong>Journal entry {entry.sequence}</strong>
                  <p>{entry.memo}</p>
                  <small>
                    {entry.date} / {entry.status}
                  </small>
                  {entry.decisionPath && (
                    <EvidenceRecord
                      runId={runId}
                      reference={entry.decisionPath}
                      label="Agent decision record"
                    />
                  )}
                </div>
              </div>
            ))
          ) : (
            <p className="muted">No matching journal entry.</p>
          )}
          {t.payment && (
            <div className="bank-evidence">
              <Icon name="bank" />
              <div>
                <strong>Payment to {t.payment.payee}</strong>
                <p>{t.payment.status}</p>
              </div>
            </div>
          )}
        </section>
        {!!t.asks.length && (
          <section className="review-section">
            <h3>Team requests</h3>
            {t.asks.map((ask) => (
              <div className="bank-evidence" key={ask.id}>
                <Icon name="inbox" />
                <div>
                  <strong>{ask.title}</strong>
                  <p>{ask.status}</p>
                  {ask.to === "human_cfo" && (
                    <button
                      type="button"
                      className="button-icon"
                      onClick={() => onReview(ask.id)}
                    >
                      Open in inbox
                      <Icon name="arrow" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
      <footer className="drawer-footer">
        <p className="muted">
          Read-only evidence from the selected simulation.
        </p>
      </footer>
    </article>
  );
}
