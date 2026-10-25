import {useEffect, useState} from "react";
import type {BankReconciliationView} from "../../src/ap-system/bank-reconciliation";
import {apSystemApi, apError} from "./apSystemApi";
import {apMoney, apLabel} from "./apSystemView";

export function APBankReconciliation({busy, onBusy, onChanged}: {busy: boolean; onBusy: (value: boolean) => void; onChanged: () => void}) {
  const [view, setView] = useState<BankReconciliationView>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    setView(undefined); setError(undefined);
    apSystemApi.bankEvidence(abort.signal).then(value => {
      if (!abort.signal.aborted) setView(value);
    }).catch(error => { if (!abort.signal.aborted) setError(apError(error)); });
    return () => abort.abort();
  }, [reload]);
  const save = async (transactionId: string, expectedAmountCents: number, reason: string) => {
    onBusy(true); setError(undefined); setNotice(undefined);
    try {
      const result = await apSystemApi.classifySandboxFunding({transactionId, expectedAmountCents, reason});
      setNotice(`Test capital recorded. Journal ${result.entryId}${result.replayed ? " (existing record)" : ""}.`);
      setReload(n => n + 1); onChanged();
    } catch (error) { setError(apError(error)); }
    finally { onBusy(false); }
  };
  return <section className="aps-section" aria-label="Bank reconciliation">
    <div className="aps-section-heading"><h3>Bank reconciliation</h3><button disabled={busy} onClick={() => setReload(n => n + 1)}>Refresh bank evidence</button></div>
    <p className="aps-caption">Imported activity for this run is linked to its journals. The imported net is not a live bank balance. Period close and QuickBooks accounting have separate records.</p>
    {error && <p role="alert" className="aps-error">{error}</p>}
    {notice && <p role="status" className="aps-success">{notice}</p>}
    {view ? <>
      <p className={view.allImportedMatched ? "aps-success" : "aps-notice"}>{view.allImportedMatched ? "All imported bank transactions matched and posted." : "Bank transactions need review."}</p>
      <dl className="aps-amounts">
        <div><dt>Cash ledger / 1000</dt><dd>{apMoney(view.cashLedgerCents)}</dd></div>
        <div><dt>Imported net activity</dt><dd>{apMoney(view.importedNetCents)}</dd></div>
        <div><dt>Unresolved items</dt><dd>{view.blockers.length}</dd></div>
      </dl>
      <p className="aps-caption">Latest complete bank scan: {view.scanCompletedAt ? new Date(view.scanCompletedAt).toLocaleString() : "Not recorded"}</p>
      <ul className="aps-source-list">{view.transactions.map(row => <li key={row.transaction.id}><div>
        <strong>{apMoney(row.transaction.amountCents)} / {apLabel(row.transaction.sourceCategory ?? row.transaction.purpose)}</strong>
        <span>{apLabel(row.state)} / {row.transaction.postedAt ?? row.transaction.createdAt}</span><code>{row.transaction.id}</code>
        {row.entryId && <p>Journal <code>{row.entryId}</code></p>}
        {row.fundingReason && <p>{row.fundingReason}</p>}
        {row.fundingEligible && <FundingClassification key={row.transaction.id} row={row} busy={busy} save={save}/>}
      </div></li>)}</ul>
      {view.blockers.length > 0 && <ul className="aps-exceptions">{view.blockers.map(b => <li key={`${b.kind}:${b.id}`}>{b.reason}<code>{b.id}</code></li>)}</ul>}
    </> : !error && <p role="status">Loading bank evidence…</p>}
  </section>;
}
function FundingClassification({row, busy, save}: {row: BankReconciliationView["transactions"][number]; busy: boolean; save: (id: string, amount: number, reason: string) => Promise<void>}) {
  const [reason, setReason] = useState("");
  return <details><summary>Classify sandbox test capital</summary><fieldset disabled={busy}>
    <p>Record {apMoney(row.transaction.amountCents)} as a debit to bank 1000 and credit to equity 3000. Use only for verified simulated test funding.</p>
    <label>Funding classification reason<textarea maxLength={2000} value={reason} onChange={e => setReason(e.target.value)}/></label>
    <button disabled={!reason.trim()} onClick={() => void save(row.transaction.id, row.transaction.amountCents, reason)}>Record test funding {apMoney(row.transaction.amountCents)}</button>
  </fieldset></details>;
}
