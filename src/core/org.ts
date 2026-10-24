import type { Role } from "./roles";

export interface SeatPlan {
  seatId: string;
  role: Role;
  name: string;
  kind: "agent" | "human";
  reportsTo?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  mandate: string;
}

// The starting org chart. The CFO agent can add AP clerks and cash-application agents under load.
export const INITIAL_ORG: SeatPlan[] = [
  { seatId: "human-cfo", role: "human_cfo", name: "Human CFO", kind: "human",
    mandate: "Sets goals and policy. Approves payments at or above the human threshold, control-role staffing and period close." },
  { seatId: "cfo-agent", role: "cfo_agent", name: "CFO Agent", kind: "agent", reportsTo: "human-cfo", effort: "high",
    mandate: "Turns the human CFO's goals into work. Staffs the team to the queue. Writes the daily digest. Owns cash strategy." },
  { seatId: "controller", role: "controller", name: "Controller Agent", kind: "agent", reportsTo: "cfo-agent", effort: "high",
    mandate: "Owns the accuracy of the books. Resolves held bills, approves payments within limits, reviews proposals, runs the close." },
  { seatId: "ap-clerk-1", role: "ap_clerk", name: "AP Clerk 1", kind: "agent", reportsTo: "controller", effort: "medium",
    mandate: "Turns vendor documents into bills: parse, 3-way match against contract and receiving, code, approve or hold." },
  { seatId: "ar-clerk-1", role: "ar_clerk", name: "AR Clerk 1", kind: "agent", reportsTo: "controller", effort: "medium",
    mandate: "Turns customer invoices and credit memos into receivables: parse, check the arithmetic, catch voids, revisions and duplicates, and give every document a disposition." },
  { seatId: "payments", role: "payments", name: "Payments Agent", kind: "agent", reportsTo: "cfo-agent", effort: "medium",
    mandate: "Runs payment batches for approved bills, executes approved payments, handles vendor remit-to change requests." },
  { seatId: "cash-app-1", role: "cash_application", name: "Cash Application Agent", kind: "agent", reportsTo: "controller", effort: "medium",
    mandate: "Matches every bank transaction to what it pays for: card settlements, delivery payouts, vendor payments." },
  { seatId: "revenue", role: "revenue_accountant", name: "Revenue Accountant", kind: "agent", reportsTo: "controller", effort: "medium",
    mandate: "Posts daily sales by channel, gift card activity and breakage, and expected settlements." },
  { seatId: "payroll", role: "payroll_accountant", name: "Payroll Accountant", kind: "agent", reportsTo: "controller", effort: "medium",
    mandate: "Checks each payroll register against the HR roster and posts payroll." },
  { seatId: "lease", role: "lease_accountant", name: "Lease Accountant", kind: "agent", reportsTo: "controller", effort: "medium",
    mandate: "Checks rent and CAM invoices against lease terms and caps." },
  { seatId: "treasury", role: "treasury", name: "Treasury Analyst", kind: "agent", reportsTo: "cfo-agent", effort: "medium",
    mandate: "Daily cash position and a 13-week forecast; flags shortfalls early." },
  { seatId: "integrations", role: "integrations_engineer", name: "Integrations Engineer", kind: "agent", reportsTo: "controller", effort: "high",
    mandate: "When a document format can't be parsed, writes and tests a new parser; the controller approves it." },
  { seatId: "auditor", role: "auditor", name: "Internal Auditor", kind: "agent", reportsTo: "human-cfo", effort: "high",
    mandate: "Independent. Samples entries and decisions, verifies the ledger chain and segregation of duties, challenges weak evidence." },
];
