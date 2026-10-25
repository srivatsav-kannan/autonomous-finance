import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Icon } from "./Icon";
import { useUrlState } from "./useUrlState";
import "./finance-flow.css";

type FlowDestination = "inbox" | "org" | "activity" | "ledger" | "memory" | "control" | "bank";
const STAGE_IDS = ["sources", "agents", "controls", "records"] as const;
type StageId = typeof STAGE_IDS[number];
type TaskStatus = "queued" | "leased" | "waiting" | "done" | "failed";

const STAGES: Record<StageId, {
  title: string;
  icon: "file" | "org" | "check" | "ledger";
  items: string[];
  heading: string;
  description: string;
  input: string;
  output: string;
  roles: { id: string; name: string; responsibility: string }[];
  action: { label: string; view: FlowDestination };
}> = {
  sources: {
    title: "Source records",
    icon: "file",
    items: ["Invoices & receipts", "Sales & bank activity", "Payroll & leases"],
    heading: "Start with the evidence",
    description: "The simulated business produces records. Events become tasks for the finance team, with source references kept alongside the work.",
    input: "Vendor documents, point-of-sale activity, bank transactions and payroll records.",
    output: "Tasks routed to the specialist responsible for each kind of record.",
    roles: [
      { id: "ap_clerk", name: "Accounts payable", responsibility: "Review vendor documents" },
      { id: "cash_application", name: "Cash application", responsibility: "Match bank activity and payouts" },
      { id: "revenue_accountant", name: "Revenue accounting", responsibility: "Record sales and revenue" },
      { id: "payroll_accountant", name: "Payroll accounting", responsibility: "Process payroll records" },
    ],
    action: { label: "Explore bank & cash", view: "bank" },
  },
  agents: {
    title: "Specialist team",
    icon: "org",
    items: ["AP, cash & revenue", "Payroll & leases", "Treasury & planning"],
    heading: "Every task has an owner",
    description: "Specialist agents process their queues within assigned permissions. They can request help, hand work to another role or raise a decision for review.",
    input: "Assigned tasks, source evidence and the team's shared memory.",
    output: "Accounting entries, recorded bills, payment requests and questions that need an answer.",
    roles: [
      { id: "ap_clerk", name: "Accounts payable", responsibility: "Validate and record bills" },
      { id: "cash_application", name: "Cash application", responsibility: "Reconcile incoming cash" },
      { id: "revenue_accountant", name: "Revenue accounting", responsibility: "Recognize revenue" },
      { id: "payroll_accountant", name: "Payroll accounting", responsibility: "Record payroll obligations" },
      { id: "lease_accountant", name: "Lease accounting", responsibility: "Maintain lease obligations" },
      { id: "treasury", name: "Treasury", responsibility: "Review cash and liquidity" },
      { id: "fpa", name: "Financial planning", responsibility: "Analyze financial performance" },
    ],
    action: { label: "View the team", view: "org" },
  },
  controls: {
    title: "Control checks",
    icon: "check",
    items: ["Role permissions", "Approval requirements", "Human review"],
    heading: "Authority stays explicit",
    description: "The finance backend enforces permissions and payment approvals. Agents escalate exceptions; the human finance lead answers decisions in the inbox.",
    input: "Proposed postings, payment requests, exceptions and supporting evidence.",
    output: "Permitted actions proceed. Blocked attempts are recorded, and unresolved questions stay visible.",
    roles: [
      { id: "controller", name: "Controller", responsibility: "Review accounting and approvals" },
      { id: "cfo_agent", name: "CFO agent", responsibility: "Coordinate work and approvals" },
      { id: "auditor", name: "Auditor", responsibility: "Inspect independently; cannot post or approve" },
    ],
    action: { label: "Open the review inbox", view: "inbox" },
  },
  records: {
    title: "Books & payments",
    icon: "ledger",
    items: ["Journal & balances", "Payment lifecycle", "Shared memory"],
    heading: "Keep the result traceable",
    description: "Posted entries update the books. Payment intents track their approval and settlement status, while shared memory preserves the team's operating knowledge.",
    input: "Validated accounting work, approved payment intents and memory proposals.",
    output: "Journal entries, payment records and versioned memory that future work can reference.",
    roles: [
      { id: "payments", name: "Payments", responsibility: "Submit authorized payments" },
      { id: "controller", name: "Controller", responsibility: "Maintain the books and shared guidance" },
      { id: "integrations_engineer", name: "Integrations", responsibility: "Maintain integration knowledge" },
    ],
    action: { label: "Inspect the ledger", view: "ledger" },
  },
};

const TASK_LABELS: { status: TaskStatus; label: string }[] = [
  { status: "queued", label: "Queued" },
  { status: "leased", label: "Leased" },
  { status: "waiting", label: "Waiting" },
  { status: "done", label: "Done" },
  { status: "failed", label: "Failed" },
];
const number = (value: number) => value.toLocaleString("en-US");

export function FinanceFlow({ runId, onNavigate }: {
  runId: string;
  onNavigate: (view: FlowDestination) => void;
}) {
  const overview = useQuery(api.observe.overview, { runId });
  const seats = useQuery(api.seats.list, { runId });
  const queues = useQuery(api.tasks.queueStats, { runId });
  const asks = useQuery(api.asks.list, { runId, to: "human_cfo", status: "open" });
  const bills = useQuery(api.ap.bills, { runId });
  const payments = useQuery(api.payments.intents, { runId });
  const [selected, setSelected] = useUrlState<StageId>("flowStage", "agents", STAGE_IDS);

  if (overview === undefined || seats === undefined || queues === undefined || asks === undefined || bills === undefined || payments === undefined) {
    return <section aria-labelledby="finance-flow-title"><h2 id="finance-flow-title">Finance flow</h2><div className="loading" role="status">Loading the finance workflow…<span className="loading-bar" /><span className="loading-bar" /></div></section>;
  }

  const activeAgents = seats.filter((seat) => seat.kind === "agent" && seat.status === "active");
  const decisions = asks.filter((ask) => ask.severity !== "info");
  const stage = STAGES[selected];
  const totals = TASK_LABELS.map(({ status, label }) => ({ status, label, count: Object.values(queues).reduce((sum, role) => sum + (role[status] ?? 0), 0) }));
  const stageMetrics: Record<StageId, { value: number; label: string }> = {
    sources: { value: bills.length, label: "bills recorded" },
    agents: { value: activeAgents.length, label: "active agent seats" },
    controls: { value: decisions.length, label: "open human decisions" },
    records: { value: overview.entries, label: "journal entries" },
  };
  const pendingPayments = payments.filter((payment) => payment.status === "pending_approval").length;
  const settledPayments = payments.filter((payment) => payment.status === "settled").length;

  return <section className="finance-flow" aria-labelledby="finance-flow-title">
    <header className="finance-flow-heading">
      <div><h2 id="finance-flow-title">Finance flow</h2><p className="lede">Follow the work from source records to the books. Select a stage to look inside.</p></div>
      <button type="button" className="finance-flow-activity" onClick={() => onNavigate("activity")}><Icon name="activity" />Live activity</button>
    </header>

    <section className="finance-flow-map" aria-label="Finance process: sources, agents, controls, then records">
      <div className="finance-flow-map-caption"><span>How this simulation works</span><span>Current scenario counts</span></div>
      <ol className="finance-flow-stages">
        {STAGE_IDS.map((id, index) => <li key={id}>
          <button type="button" className={`finance-flow-stage${selected === id ? " is-selected" : ""}`} aria-pressed={selected === id} aria-controls="finance-flow-detail" onClick={() => setSelected(id)}>
            <span className="finance-flow-stage-top"><span className="finance-flow-stage-icon"><Icon name={STAGES[id].icon} /></span><span className="finance-flow-step">{index + 1} of {STAGE_IDS.length}</span></span>
            <span className="finance-flow-stage-title">{STAGES[id].title}</span>
            <span className="finance-flow-stage-items">{STAGES[id].items.map((item) => <span key={item}>{item}</span>)}</span>
            <span className="finance-flow-stage-metric"><strong>{number(stageMetrics[id].value)}</strong><span>{stageMetrics[id].label}</span></span>
          </button>
          {index < STAGE_IDS.length - 1 && <span className="finance-flow-connector" aria-hidden="true"><Icon name="arrow" /></span>}
        </li>)}
      </ol>
      <div className="finance-flow-human">
        <span className="finance-flow-human-icon" aria-hidden="true"><Icon name="inbox" /></span>
        <div><strong>Human finance lead</strong><span>{decisions.length ? `${number(decisions.length)} ${decisions.length === 1 ? "decision needs" : "decisions need"} your input.` : "No decisions waiting for you."} An answer returns a linked waiting task to its queue.</span></div>
        <button type="button" onClick={() => onNavigate("inbox")}>Review inbox<Icon name="chevron" /></button>
      </div>
    </section>

    <div className="finance-flow-detail" id="finance-flow-detail">
      <article className="finance-flow-explanation" aria-labelledby="finance-flow-stage-heading">
        <p className="finance-flow-detail-label">{stage.title}</p>
        <h3 id="finance-flow-stage-heading">{stage.heading}</h3>
        <p>{stage.description}</p>
        <dl className="finance-flow-handoff"><div><dt>Comes in</dt><dd>{stage.input}</dd></div><div><dt>Moves forward</dt><dd>{stage.output}</dd></div></dl>
        {selected === "controls" && <p className="finance-flow-evidence"><strong>{number(overview.blockedAttempts)}</strong> blocked attempts recorded by the backend. <strong>{number(pendingPayments)}</strong> payment intents awaiting approval.</p>}
        {selected === "records" && <p className="finance-flow-evidence"><strong>{number(payments.length)}</strong> payment intents recorded; <strong>{number(settledPayments)}</strong> settled in this simulation.</p>}
        <div className="finance-flow-detail-actions"><button type="button" className="primary" onClick={() => onNavigate(stage.action.view)}>{stage.action.label}<Icon name="arrow" /></button>{selected === "records" && <button type="button" onClick={() => onNavigate("memory")}>Browse memory</button>}</div>
      </article>

      <section className="finance-flow-responsibilities" aria-labelledby="finance-flow-responsibilities-title">
        <div className="finance-flow-responsibilities-heading"><h3 id="finance-flow-responsibilities-title">Who carries the work</h3><span>Active seats / task queue</span></div>
        <ul>
          {stage.roles.map((role) => {
            const agentCount = activeAgents.filter((agent) => agent.role === role.id).length;
            const counts = queues[role.id] ?? {};
            const visibleStatuses = TASK_LABELS.filter(({ status }) => (counts[status] ?? 0) > 0);
            return <li key={role.id}>
              <div className="finance-flow-role"><strong>{role.name}</strong><span>{role.responsibility}</span></div>
              <div className="finance-flow-role-state"><span className="finance-flow-seat-count">{number(agentCount)} active {agentCount === 1 ? "seat" : "seats"}</span><span className="finance-flow-role-queue">{visibleStatuses.length ? visibleStatuses.map(({ status, label }) => <span className={status === "failed" ? "finance-flow-task-failed" : ""} key={status}>{number(counts[status]!)} {label.toLowerCase()}</span>) : <span>No tasks recorded</span>}</span></div>
            </li>;
          })}
        </ul>
      </section>
    </div>

    <section className="finance-flow-queue" aria-labelledby="finance-flow-queue-title">
      <div><h3 id="finance-flow-queue-title">Across all task queues</h3><p>Current task states for this scenario. Leased tasks are claimed by a worker; waiting tasks need a response or dependency.</p></div>
      <dl>{totals.map(({ status, label, count }) => <div key={status}><dt>{label}</dt><dd className={status === "failed" && count > 0 ? "finance-flow-task-failed" : ""}>{number(count)}</dd></div>)}</dl>
    </section>
    <p className="finance-flow-note">This map describes the system's responsibilities. Counts reflect the selected simulation; arrows show the workflow, not individual transaction movements.</p>
  </section>;
}
