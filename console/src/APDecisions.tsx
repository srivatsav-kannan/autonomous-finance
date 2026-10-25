import { useEffect, useState } from "react";
import type { APCaseDetail } from "../../src/ap-system/contracts";
import { apSystemApi } from "./apSystemApi";
import { apMoney } from "./apSystemView";
import { Icon } from "./Icon";

// The decision a person owes an AP case right now, in the order the case needs them.
// Field review, bill approval and payment release are separate people (see the AP policy).
export function apDecision(c: APCaseDetail): { label: string; who: string; reason: string } | null {
  const blocking = c.exceptions.find((e) => e.blocking && e.status === "open");
  if (c.states.execution === "unknown") return { label: "Payment outcome unknown", who: "Payments", reason: "The bank may have accepted it. Recovery checks the original payment before anything is sent again." };
  if (c.states.document === "review_required") return { label: "Check the extracted fields", who: "Field reviewer", reason: "Compare the fields with the original documents." };
  if (c.states.document === "failed") return { label: "Document could not be read", who: "Field reviewer", reason: "Upload a clearer copy or enter the fields by hand." };
  if (c.states.business === "held") return { label: "Bill is on hold", who: "Bill approver", reason: blocking?.reason ?? "The invoice doesn't match the order or the delivery." };
  if (c.states.document === "reviewed" && c.states.business === "unreviewed") return { label: "Approve the bill", who: "Bill approver", reason: blocking?.reason ?? "Approving records what we owe. It doesn't pay anything." };
  if (c.states.authorization === "awaiting_approval") return { label: "Release the payment", who: "Payment authorizer", reason: "A different person from the bill approver must release it." };
  if (blocking) return { label: "Exception to clear", who: blocking.ownerRole.replace(/_/g, " "), reason: blocking.reason };
  return null;
}

export function APDecisions({ apReady, onOpenCase, onOpenInvoices }: { apReady: boolean; onOpenCase: (caseId: string) => void; onOpenInvoices: () => void }) {
  const [cases, setCases] = useState<APCaseDetail[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!apReady) return;
    let live = true;
    const load = () => apSystemApi.list().then((value) => { if (live) { setCases(value); setError(undefined); } }, () => { if (live) setError("signin"); });
    void load();
    const timer = setInterval(load, 10_000);
    return () => { live = false; clearInterval(timer); };
  }, [apReady]);
  const open = (cases ?? []).map((c) => ({ c, d: apDecision(c) })).filter((x) => x.d);
  return (
    <section className="ap-decisions" aria-labelledby="ap-decisions-heading">
      <div className="page-heading"><div>
        <h3 id="ap-decisions-heading">Invoice decisions</h3>
        <p className="lede">Accounts payable cases waiting on a person. Agents prepared them. Each one opens with its original documents.</p>
      </div></div>
      {!apReady || error ? <div className="empty"><Icon name="file" /><strong>Choose who you're acting as</strong>Open Invoices and pick a reviewer, approver or payer. Their decisions then show here too.<button type="button" onClick={onOpenInvoices}>Open invoices</button></div>
        : cases === undefined ? <p className="aps-empty" role="status">Loading invoice decisions…</p>
        : !open.length ? <div className="empty queue-empty"><Icon name="check" /><strong>No invoice decisions waiting</strong>{cases.length} {cases.length === 1 ? "case" : "cases"} in accounts payable.</div>
        : <div className="table-scroll queue-table"><table className="grid decision-table">
          <thead><tr><th>Invoice</th><th>Decision</th><th>Who decides</th><th className="num">Amount</th><th>Why</th></tr></thead>
          <tbody>{open.map(({ c, d }) => <tr key={c.caseId} className="clickable" onClick={() => onOpenCase(c.caseId)}>
            <td data-label="Invoice"><button type="button" className="aps-text-button" onClick={(e) => { e.stopPropagation(); onOpenCase(c.caseId); }}>{c.candidate?.invoiceNumber ?? c.sources[0]?.name ?? c.caseId}</button><br /><small>{c.candidate?.extractedSupplierName ?? "Supplier not established"}</small></td>
            <td data-label="Decision">{d!.label}</td>
            <td data-label="Who decides">{d!.who}</td>
            <td data-label="Amount" className="num">{apMoney(c.amounts.invoicedCents)}</td>
            <td data-label="Why">{d!.reason}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  );
}
