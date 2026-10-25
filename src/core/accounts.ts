// Chart of accounts for a multi-unit restaurant company. Codes are strings; ranges drive capabilities.

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface AccountDef {
  code: string;
  name: string;
  type: AccountType;
  /** Cash accounts can only move through payment settlement or cash application. */
  cash?: boolean;
}

export const CHART: AccountDef[] = [
  { code: "1000", name: "Cash - Operating (Bank A)", type: "asset", cash: true },
  { code: "1010", name: "Cash - Payroll (Bank A)", type: "asset", cash: true },
  { code: "1020", name: "Cash - Store Deposits (Bank B)", type: "asset", cash: true },
  { code: "1100", name: "Card Settlements Receivable", type: "asset" },
  { code: "1110", name: "Delivery Platform Receivable", type: "asset" },
  { code: "1150", name: "Vendor Credits Receivable", type: "asset" },
  { code: "1180", name: "Recoverable Purchase Taxes", type: "asset" },
  { code: "1200", name: "Inventory - Food & Packaging", type: "asset" },
  { code: "1300", name: "Prepaid Expenses", type: "asset" },
  { code: "1500", name: "Property & Equipment", type: "asset" },
  { code: "1600", name: "Operating Lease ROU Assets", type: "asset" },
  { code: "2000", name: "Accounts Payable", type: "liability" },
  { code: "2010", name: "Accrued Liabilities", type: "liability" },
  { code: "2100", name: "Payroll Liabilities", type: "liability" },
  { code: "2200", name: "Gift Card & Loyalty Liability", type: "liability" },
  { code: "2300", name: "Sales Tax Payable", type: "liability" },
  { code: "2400", name: "Operating Lease Liabilities", type: "liability" },
  { code: "3000", name: "Stockholders' Equity", type: "equity" },
  { code: "4000", name: "Revenue - In-Store", type: "revenue" },
  { code: "4010", name: "Revenue - Digital (Owned)", type: "revenue" },
  { code: "4020", name: "Revenue - Delivery Marketplace", type: "revenue" },
  { code: "4090", name: "Gift Card Breakage", type: "revenue" },
  { code: "5000", name: "Food, Beverage & Packaging", type: "expense" },
  { code: "5100", name: "Labor & Related", type: "expense" },
  { code: "5200", name: "Occupancy (Rent & CAM)", type: "expense" },
  { code: "5300", name: "Other Restaurant Operating Costs", type: "expense" },
  { code: "5400", name: "Card Processing Fees", type: "expense" },
  { code: "5410", name: "Delivery Platform Commissions", type: "expense" },
  { code: "6000", name: "General & Administrative", type: "expense" },
  { code: "6100", name: "Technology & SaaS", type: "expense" },
  { code: "6200", name: "Marketing", type: "expense" },
  { code: "6900", name: "Suspense - Unidentified", type: "asset" },
];

const BY_CODE = new Map(CHART.map((a) => [a.code, a]));

export function account(code: string): AccountDef {
  const def = BY_CODE.get(code);
  if (!def) throw new Error(`unknown account ${code}`);
  return def;
}

export function isKnownAccount(code: string): boolean {
  return BY_CODE.has(code);
}

/** Debit-normal accounts grow with debits. */
export function isDebitNormal(code: string): boolean {
  const t = account(code).type;
  return t === "asset" || t === "expense";
}
