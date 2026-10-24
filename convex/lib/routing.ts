// Which seat picks up which kind of outside-world event. Code, not a prompt.

export interface Route {
  role: string;
  taskType: string;
  priority: number; // lower runs first
}

export function routeEvent(type: string, payload: Record<string, unknown>): Route[] {
  const one = routeOne(type, payload);
  if (type === "day.end") return [one!, { role: "cfo_agent", taskType: "cfo.daily_digest", priority: 7 }];
  return one ? [one] : [];
}

function routeOne(type: string, payload: Record<string, unknown>): Route | null {
  switch (type) {
    case "document.received": {
      const kind = payload.kind as string | undefined;
      if (kind === "remit_change_request") return { role: "payments", taskType: "vendor.remit_change", priority: 1 };
      if (kind === "lease_invoice") return { role: "lease_accountant", taskType: "lease.process_invoice", priority: 3 };
      return { role: "ap_clerk", taskType: "ap.process_document", priority: 3 };
    }
    case "bank.transaction":
      return { role: "cash_application", taskType: "cash.match_bank_txn", priority: 2 };
    case "sales.daily":
      return { role: "revenue_accountant", taskType: "revenue.post_daily", priority: 4 };
    case "payout.report":
      return { role: "cash_application", taskType: "cash.reconcile_payout", priority: 3 };
    case "payroll.register":
      return { role: "payroll_accountant", taskType: "payroll.process", priority: 2 };
    case "day.end":
      return { role: "payments", taskType: "payments.run", priority: 5 };
    case "period.end":
      return { role: "controller", taskType: "close.run", priority: 6 };
    default:
      // Data-only events (receiving logs, roster changes) are read by other tasks; nobody is woken.
      return null;
  }
}
