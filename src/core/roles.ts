// Roles define what a seat may do. The kernel enforces these; prompts never grant authority.

export type Role =
  | "human_cfo"
  | "cfo_agent"
  | "controller"
  | "ap_clerk"
  | "payments"
  | "cash_application"
  | "revenue_accountant"
  | "lease_accountant"
  | "payroll_accountant"
  | "treasury"
  | "fpa"
  | "integrations_engineer"
  | "auditor"
  | "invoice_investigator"
  | "world";

export interface Capabilities {
  /** Account code prefixes this seat may post to. Empty = may not post. */
  post: string[];
  /** May create approved, held, or rejected vendor bills. */
  billsRecord: boolean;
  paymentsRequest: boolean;
  /** Max single payment this seat may approve, in cents. 0 = may not approve. */
  paymentsApproveLimit: number;
  paymentsExecute: boolean;
  /** Memory path prefixes this seat may merge proposals for. */
  memoryMerge: string[];
  periodClose: boolean;
  seatsManage: boolean;
  /** Roles this seat may create tasks for. */
  taskRoles: Role[];
  asks: boolean;
}

const NONE: Capabilities = {
  post: [],
  billsRecord: false,
  paymentsRequest: false,
  paymentsApproveLimit: 0,
  paymentsExecute: false,
  memoryMerge: [],
  periodClose: false,
  seatsManage: false,
  taskRoles: [],
  asks: false,
};

const ALL_AGENT_ROLES: Role[] = [
  "cfo_agent", "controller", "ap_clerk", "payments", "cash_application", "revenue_accountant",
  "lease_accountant", "payroll_accountant", "treasury", "fpa", "integrations_engineer", "auditor",
];

export const ROLE_CAPABILITIES: Record<Role, Capabilities> = {
  human_cfo: {
    ...NONE,
    paymentsApproveLimit: Number.MAX_SAFE_INTEGER,
    memoryMerge: [""],
    periodClose: true,
    seatsManage: true,
    taskRoles: ALL_AGENT_ROLES,
    asks: true,
  },
  // Second approver for dual-approval payments below the human threshold.
  cfo_agent: { ...NONE, seatsManage: true, taskRoles: ALL_AGENT_ROLES, asks: true, memoryMerge: ["playbooks/"], paymentsApproveLimit: 49_999_99 },
  controller: {
    ...NONE,
    billsRecord: true,
    post: ["1", "2", "3", "4", "5", "6"],
    paymentsApproveLimit: 25_000_00,
    memoryMerge: ["vendors/", "playbooks/", "stores/", "integrations/"],
    periodClose: true,
    taskRoles: ALL_AGENT_ROLES,
    asks: true,
  },
  ap_clerk: {
    ...NONE,
    billsRecord: true,
    post: ["2000", "2010", "1150", "1200", "1300", "5000", "5200", "5300", "6000", "6100", "6200"],
    taskRoles: ["controller", "payments", "integrations_engineer"],
    asks: true,
  },
  payments: {
    ...NONE,
    post: ["1000", "1010", "2000", "2100", "6900"],
    paymentsRequest: true,
    paymentsExecute: true,
    taskRoles: ["controller", "ap_clerk"],
    asks: true,
  },
  cash_application: {
    ...NONE,
    post: ["1000", "1020", "1100", "1110", "5400", "5410", "6900"],
    taskRoles: ["controller", "revenue_accountant"],
    asks: true,
  },
  revenue_accountant: {
    ...NONE,
    post: ["1100", "1110", "2200", "2300", "4000", "4010", "4020", "4090", "5410"],
    taskRoles: ["controller", "cash_application"],
    asks: true,
  },
  lease_accountant: {
    ...NONE,
    billsRecord: true,
    post: ["1600", "2000", "2400", "5200"],
    paymentsRequest: true,
    taskRoles: ["controller", "payments"],
    asks: true,
  },
  payroll_accountant: {
    ...NONE,
    post: ["2100", "5100", "2010"],
    paymentsRequest: true,
    taskRoles: ["controller", "payments"],
    asks: true,
  },
  treasury: { ...NONE, taskRoles: ["controller", "payments", "cfo_agent"], asks: true },
  fpa: { ...NONE, taskRoles: ["controller", "cfo_agent"], asks: true },
  integrations_engineer: { ...NONE, taskRoles: ["controller"], asks: true },
  // Independent: reads everything, posts nothing, approves nothing.
  auditor: { ...NONE, taskRoles: [], asks: true },
  // Invoice evidence workspace: proposes case conclusions through convex/invoiceCases.ts only.
  // Posts nothing, records no bills or payments, and creates no tasks.
  invoice_investigator: NONE,
  world: NONE,
};

export function canPost(caps: Capabilities, accountCode: string): boolean {
  return caps.post.some((prefix) => accountCode.startsWith(prefix));
}

export function canMerge(caps: Capabilities, path: string): boolean {
  return caps.memoryMerge.some((prefix) => path.startsWith(prefix));
}
