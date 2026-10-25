import { Component, useEffect, useId, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { gateway } from "./gateway";
import "./workspaceSettings.css";

type WorkspaceSettingsProps = {
  runs?: { runId: string; label: string }[];
  runId: string;
  simulationAvailable: boolean;
  connected: boolean;
  onSelectRun: (id: string) => void;
  onOpenControl: () => void;
  onOpenInbox: () => void;
};

class ScenarioQueryBoundary extends Component<{
  children: ReactNode;
  fallback: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function ScenarioDetails({ runId }: { runId: string }) {
  const overview = useQuery(api.observe.overview, { runId });
  if (overview === undefined) return <p role="status">Loading scenario details…</p>;
  if (!overview.run) return <p role="status">This scenario was not found on the connected backend. Select an available scenario below.</p>;
  return <div className="workspace-settings-scenario">
    <p><strong>{overview.run.label}</strong> · {overview.run.simDate} · {overview.run.status}</p>
    <dl className="workspace-settings-metrics">
      <div><dt>Ledger entries</dt><dd>{overview.entries.toLocaleString()}</dd></div>
      <div><dt>Agent turns</dt><dd>{overview.agentTurns.toLocaleString()}</dd></div>
      <div><dt>Open requests</dt><dd>{overview.openAsks.toLocaleString()}</dd></div>
    </dl>
    {overview.entries === 0 && <p>No ledger entries in this scenario. Choose another scenario, or open simulation controls to inspect this scenario.</p>}
  </div>;
}

type GatewayHealthState = { status: "checking" } | { status: "connected" } | { status: "failed"; message: string };

function HumanGatewayHealth({ runId }: { runId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [health, setHealth] = useState<GatewayHealthState>({ status: "checking" });
  useEffect(() => {
    let active = true;
    setHealth({ status: "checking" });
    const timeout = window.setTimeout(() => {
      if (!active) return;
      active = false;
      setHealth({ status: "failed", message: "The human gateway did not respond. Check that it is running, then retry." });
    }, 10_000);
    gateway(runId, "memory/log?limit=1").then(() => {
      if (active) setHealth({ status: "connected" });
    }).catch((error: unknown) => {
      if (!active) return;
      const missingConfiguration = error instanceof Error && error.message.includes("VITE_GATEWAY_TOKEN is not set");
      setHealth({ status: "failed", message: missingConfiguration
        ? "Human gateway access is not configured. Restart the console and gateway with matching access settings."
        : "Could not connect to the human gateway. Check that it is running with matching console access settings, then retry." });
    }).finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [runId, attempt]);
  return <div className="workspace-settings-gateway">
    <p role="status">{health.status === "checking" ? "Checking human gateway…" : health.status === "connected" ? "Connected · Human gateway can read this scenario." : health.message}</p>
    <button type="button" onClick={() => setAttempt((value) => value + 1)} disabled={health.status === "checking"}>{health.status === "failed" ? "Retry connection" : "Check connection"}</button>
  </div>;
}

export function WorkspaceSettings({ runs, runId, simulationAvailable, connected, onSelectRun, onOpenControl, onOpenInbox }: WorkspaceSettingsProps) {
  const selectId = useId();
  const hasLinkedRun = Boolean(runId) && !runs?.some((run) => run.runId === runId);
  const financeDemo = runs?.find((run) => run.runId === "finance-workbench");
  return <section className="workspace-settings" aria-labelledby="workspace-settings-title">
    <header>
      <h2 id="workspace-settings-title">Settings</h2>
      <p>Choose the records shown across the finance workspace.</p>
    </header>
    <section className="workspace-settings-section" aria-labelledby="finance-data-title">
      <div className="workspace-settings-heading">
        <h3 id="finance-data-title">Finance data</h3>
        <span className="workspace-settings-connection" role="status">{!simulationAvailable ? "Not configured" : connected ? "Connected" : "Reconnecting…"}</span>
      </div>
      {!simulationAvailable ? <p>The finance simulation backend is not configured for this console. AP records use a separate connection and can still be available.</p>
        : !connected ? <p>Waiting for the finance backend. Scenario records will load when the connection returns.</p>
          : runId ? <ScenarioQueryBoundary key={runId} fallback={<p role="alert">This scenario could not be read. Select another finance scenario or check the backend connection.</p>}><ScenarioDetails runId={runId} /></ScenarioQueryBoundary>
            : <p>{runs === undefined ? "Loading available scenarios…" : runs.length ? "Select a scenario to view its records." : "No finance scenarios are available on this backend."}</p>}
      <div className="workspace-settings-selection">
        <label htmlFor={selectId}>Finance scenario</label>
        <select id={selectId} value={runId} onChange={(event) => onSelectRun(event.target.value)} disabled={!simulationAvailable || !runs?.length} aria-describedby={`${selectId}-hint`}>
          {!runId && <option value="">{runs === undefined && simulationAvailable ? "Loading scenarios…" : "Select a scenario"}</option>}
          {hasLinkedRun && <option value={runId}>{runId} (linked scenario)</option>}
          {runs?.map((run) => <option key={run.runId} value={run.runId}>{run.label} ({run.runId})</option>)}
        </select>
        <p id={`${selectId}-hint`}>Selecting a scenario loads its existing records; it does not create a run or initiate transactions.</p>
      </div>
      <div className="workspace-settings-actions">
        {financeDemo && <button type="button" className="primary" onClick={() => onSelectRun(financeDemo.runId)} disabled={runId === financeDemo.runId}>Use finance demo</button>}
        <button type="button" onClick={onOpenControl} disabled={!simulationAvailable || !runId}>Open simulation controls</button>
        <button type="button" onClick={onOpenInbox} disabled={!simulationAvailable || !runId}>View inbox</button>
      </div>
    </section>
    <section className="workspace-settings-section" aria-labelledby="human-gateway-title">
      <h3 id="human-gateway-title">Human gateway</h3>
      <p>Memory, evaluations, and human actions use this connection. Finance balances and ledger records load independently.</p>
      {simulationAvailable && connected && runId ? <HumanGatewayHealth key={runId} runId={runId} />
        : <p role="status">{!simulationAvailable ? "Configure the finance backend to check the human gateway." : !connected ? "Waiting for the finance connection before checking the human gateway." : "Select a finance scenario to check the human gateway."}</p>}
    </section>
    <section className="workspace-settings-section" aria-labelledby="ap-data-title">
      <h3 id="ap-data-title">AP documents and payments</h3>
      <p>AP records are a separate dataset from the finance simulation ledger. Changing the finance scenario does not move AP documents, balances, or payments into these views.</p>
      <nav className="workspace-settings-actions" aria-label="AP workspaces">
        <a href="/ap-system?view=ap-system">Connected AP</a>
        <a href="/ap-system?view=ap-system&apRuntime=apex">APEX documents</a>
      </nav>
      <p>Payment authorization remains a separate step in the AP workspace.</p>
    </section>
  </section>;
}

type WorkspaceDataStatusProps = { runId: string; onOpenSettings: () => void };

function ScenarioDataStatus({ runId, onOpenSettings }: WorkspaceDataStatusProps) {
  const overview = useQuery(api.observe.overview, { runId });
  return <div className="workspace-data-status">
    <div role="status">
      {overview === undefined ? <span>Loading scenario details…</span>
        : !overview.run ? <><strong>Scenario not found</strong><span>Select an available finance scenario in Settings.</span></>
          : <><strong>{overview.run.label} · {overview.entries.toLocaleString()} ledger {overview.entries === 1 ? "entry" : "entries"}</strong><span>{overview.entries === 0 ? "No ledger entries in this scenario. Choose another scenario in Settings." : "Finance simulation records. AP documents and payments use their own workspace."}</span></>}
    </div>
    <button type="button" onClick={onOpenSettings}>Settings</button>
  </div>;
}

export function WorkspaceDataStatus(props: WorkspaceDataStatusProps) {
  return <ScenarioQueryBoundary key={props.runId} fallback={<div className="workspace-data-status"><p role="alert">Unable to read this finance scenario. Choose another scenario in Settings.</p><button type="button" onClick={props.onOpenSettings}>Settings</button></div>}>
    <ScenarioDataStatus {...props} />
  </ScenarioQueryBoundary>;
}
