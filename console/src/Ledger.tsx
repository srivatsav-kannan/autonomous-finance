import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Icon } from "./Icon";
import { useUrlState } from "./useUrlState";

const money = (cents: number) => (cents < 0 ? "-" : "") + "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function csvCell(value: string | number) {
  if (typeof value === "number") return String(value);
  // Spreadsheet apps can execute formulas even inside quoted CSV fields.
  const safe = /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const content = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Ledger({ runId }: { runId: string }) {
  const balances = useQuery(api.ledger.trialBalance, { runId });
  const entries = useQuery(api.ledger.entries, { runId, limit: 60 });
  const chain = useQuery(api.ledger.verifyChain, { runId });
  const [view, setView] = useUrlState("ledgerView", "journal", ["journal", "balances"] as const);
  const [search, setSearch] = useUrlState("ledgerSearch");
  const term = search.trim().toLocaleLowerCase();
  const journal = (entries ?? []).filter((entry) => [entry.sequence, entry.date, entry.memo, entry.postedBy, entry.decisionPath ?? "", entry.status, money(entry.totalCents)].join(" ").toLocaleLowerCase().includes(term));
  const trialBalance = (balances ?? []).filter((account) => [account.code, account.name, account.type, money(account.type === "asset" || account.type === "expense" ? account.net : -account.net)].join(" ").toLocaleLowerCase().includes(term));
  const loading = view === "journal" ? entries === undefined : balances === undefined;
  const count = view === "journal" ? journal.length : trialBalance.length;
  const exportRows = () => {
    const rows: (string | number)[][] = view === "journal"
      ? [["Sequence", "Date", "Entry", "Amount (USD)", "By", "Why", "Status"], ...journal.map((entry) => [entry.sequence, entry.date, entry.memo, entry.totalCents / 100, entry.postedBy, entry.decisionPath ?? "", entry.status])]
      : [["Account", "Name", "Type", "Balance (USD)"], ...trialBalance.map((account) => [account.code, account.name, account.type, (account.type === "asset" || account.type === "expense" ? account.net : -account.net) / 100])];
    downloadCsv(`${runId.replace(/[^a-z0-9._-]/gi, "-")}-${view}.csv`, rows);
  };

  return (
    <section>
      <div className="row between">
        <h2>Ledger</h2>
        <button type="button" className="icon-label" onClick={exportRows} disabled={loading || count === 0}><Icon name="download" /> Download CSV</button>
      </div>
      <p className="lede">Posted entries and account balances for this scenario.</p>
      <div className="tab-strip" role="group" aria-label="Ledger view">
        <button type="button" className={`tab-item ${view === "journal" ? "is-active" : ""}`} aria-pressed={view === "journal"} onClick={() => { setView("journal"); setSearch(""); }}>Journal entries</button>
        <button type="button" className={`tab-item ${view === "balances" ? "is-active" : ""}`} aria-pressed={view === "balances"} onClick={() => { setView("balances"); setSearch(""); }}>Trial balance</button>
      </div>
      <div className="table-toolbar">
        <label className="search-field"><Icon name="search" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search ledger" placeholder={view === "journal" ? "Search entries, agents, or references" : "Search accounts"} /></label>
        <span className={`pill ${chain ? chain.ok ? "ok" : "bad" : ""}`} role="status">{chain ? (chain.ok ? `Hash chain verified · ${chain.entries} entries` : "Hash chain broken") : "Verifying hash chain…"}</span>
      </div>
      {loading ? <div className="loading" role="status">Loading ledger…<span className="loading-bar" /><span className="loading-bar" /></div> : count === 0 ? (
        <div className="empty"><strong>{term ? "No matching records." : view === "journal" ? "No entries posted yet." : "No account balances yet."}</strong>{term ? "Try another search or clear the filter." : "Records will appear as the agents post entries."}</div>
      ) : (
        <div className="table-scroll">
          {view === "journal" ? <table className="grid responsive-table" aria-label="Journal entries">
            <thead><tr><th scope="col">#</th><th scope="col">Date</th><th scope="col">Entry</th><th scope="col" className="num">Amount</th><th scope="col">By</th><th scope="col">Why</th></tr></thead>
            <tbody>{journal.map((entry) => <tr key={entry._id}>
              <td data-label="#" className="muted nowrap">{entry.sequence}</td>
              <td data-label="Date" className="nowrap">{entry.date}</td>
              <td data-label="Entry">{entry.memo}{entry.status === "reversed" && <span className="tag blocked"> reversed</span>}</td>
              <td data-label="Amount" className="num">{money(entry.totalCents)}</td>
              <td data-label="By" className="nowrap">{entry.postedBy}</td>
              <td data-label="Why" className="muted mono" title={entry.decisionPath}>{entry.decisionPath ? entry.decisionPath.split("/").pop() : "—"}</td>
            </tr>)}</tbody>
          </table> : <table className="grid responsive-table" aria-label="Trial balance">
            <thead><tr><th scope="col">Account</th><th scope="col">Name</th><th scope="col">Type</th><th scope="col" className="num">Balance</th></tr></thead>
            <tbody>{trialBalance.map((account) => <tr key={account.code}>
              <td data-label="Account" className="nowrap">{account.code}</td>
              <td data-label="Name">{account.name}</td>
              <td data-label="Type">{account.type}</td>
              <td data-label="Balance" className="num">{money(account.type === "asset" || account.type === "expense" ? account.net : -account.net)}</td>
            </tr>)}</tbody>
          </table>}
        </div>
      )}
      {!loading && <p className="table-summary" aria-live="polite">{view === "journal" ? `${journal.length} of ${entries?.length ?? 0} recent entries${(chain?.entries ?? 0) > (entries?.length ?? 0) ? ` · ${chain!.entries} entries in this scenario` : ""}` : `${trialBalance.length} of ${balances?.length ?? 0} accounts`}</p>}
    </section>
  );
}
