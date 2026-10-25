import { healthSignals, statusLabel, type OperatorHealth } from "./operatorHealthView";

const when = (time: number) => new Date(time).toLocaleString();

/** Read-only view of demoOps.operatorHealth for the authenticated human. It has no controls:
 * recovery stays in the audited actions under "Dispatch and recovery". */
export function OperatorHealthPanel({ health, error }: { health?: OperatorHealth; error?: string }) {
  if (!health) return <section className="ap-panel" aria-labelledby="ap-health-title">
    <h2 id="ap-health-title">Operator health</h2>
    <p className="ap-error">Operator health is unavailable: {error ?? "not loaded yet."}</p>
  </section>;
  const signals = healthSignals(health);
  const nevers = [...new Set(health.alerts.map(alert => alert.never))];
  return <section className="ap-panel" aria-labelledby="ap-health-title">
    <div className="ap-row">
      <h2 id="ap-health-title">Operator health</h2>
      <span className={`pill ap-health-${health.status}`}>{statusLabel(health.status)}</span>
    </div>
    <p className="muted">Read-only. Worker progress, stalled and failed work for this account, as of {when(health.now)} (Convex server clock). Bank and fixture business dates are not used.</p>
    <h3>Alerts · {health.alerts.length}</h3>
    {health.alerts.length ? <ul className="ap-alerts">
      {health.alerts.map((alert, index) => <li key={`${alert.state}:${index}`} className={`ap-alert-${alert.severity}`}>
        <p><strong>{alert.severity === "critical" ? "Critical" : "Warning"}</strong> <code>{alert.state}</code> · {alert.observed}</p>
        <p><span className="muted">Runbook:</span> {alert.action}</p>
      </li>)}
    </ul> : <p className="ap-success">No alerts. Workers are passing and no work is past its target.</p>}
    {nevers.map(never => <p key={never} className="ap-never">{never}</p>)}
    <div className="ap-table-wrap"><table className="grid"><thead><tr><th>Signal</th><th>Observed</th><th>Target</th><th>Within target</th></tr></thead><tbody>
      {signals.map(signal => <tr key={`${signal.group}:${signal.label}`}>
        <td><span className="muted">{signal.group}</span><br />{signal.label}</td>
        <td>{signal.observed}</td>
        <td>{signal.target}</td>
        <td className={signal.overTarget ? "ap-error" : undefined}>{signal.overTarget === null ? "—" : signal.overTarget ? "No" : "Yes"}</td>
      </tr>)}
    </tbody></table></div>
    <p className="muted">
      Targets, not measurements ({health.sloTargets.basis}): no baseline has been recorded on a deployed backend.
      They derive from a 1 s service loop, 10 s heartbeat and 30 s lease. Counts stop at 200 per state, shown as 200+.
    </p>
  </section>;
}
