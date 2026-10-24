import {
  CALIBRATION,
  CARD_PROCESSOR,
  DELIVERY_PLATFORMS,
  HUMANS,
  LANDLORDS,
  STORES,
  VENDORS,
} from "../../company/sweetgreen/profile";
import { INITIAL_ORG } from "../core/org";
import type { FileChange } from "./store";
import { DEFAULT_RECEIVABLES_POLICY } from "./schemas";

const LANDLORD_FOR: Record<string, string> = {
  "San Francisco": "embarcadero-realty",
  "Palo Alto": "peninsula-retail",
  "San Jose": "peninsula-retail",
  "San Mateo": "peninsula-retail",
  "Mountain View": "peninsula-retail",
  Oakland: "eastbay-properties",
  Berkeley: "eastbay-properties",
  "Walnut Creek": "eastbay-properties",
};

export function baseRentCents(storeIndex: number): number {
  return 1_450_000 + storeIndex * 37_500; // $14,500-$18,600 / month
}

export function camCapCents(storeIndex: number): number {
  return 210_000 + storeIndex * 5_000;
}

/** The company's memory on day zero, built from the profile. */
export function seedFiles(storeCount: number): FileChange[] {
  const stores = STORES.slice(0, storeCount);
  const files: FileChange[] = [];

  files.push({
    path: "company.yaml",
    data: {
      id: "sweetgreen",
      legalName: "Sweetgreen, Inc. (simulated)",
      ticker: "SG",
      fiscalYearEnd: "last Sunday of December",
      calibration: Object.fromEntries(Object.entries(CALIBRATION).map(([k, v]) => [k, { ...v }])),
      disclaimer: "Simulation calibrated to public SEC filings. Not affiliated with Sweetgreen. Transactions, counterparties and people are simulated.",
    },
  });

  files.push({ path: "policies/approval-limits.yaml", data: { autoApproveCents: 5_000_00, dualApprovalCents: 10_000_00, humanApprovalCents: 50_000_00 } });
  files.push({ path: "policies/materiality.yaml", data: { priceVarianceBps: 100, quantityToleranceUnits: 0, payoutToleranceCents: 500, bankMatchToleranceCents: 0 } });
  files.push({ path: "policies/receivables.yaml", data: DEFAULT_RECEIVABLES_POLICY });
  files.push({
    path: "policies/payments.yaml",
    data: { remitChangeRequires: ["callback_known_number", "crs_check", "controller_approval", "cooling_off_days"], coolingOffDays: 3, paymentRunDaysBeforeDue: 3 },
  });

  for (const v of VENDORS) {
    files.push({
      path: `vendors/${v.id}.yaml`,
      data: {
        id: v.id,
        legalName: v.legalName,
        category: v.category,
        expenseAccount: v.expenseAccount,
        termsNetDays: v.termsNetDays,
        status: "active",
        remitTo: { bank: v.bank, accountLast4: v.accountLast4, verifiedOn: "2025-06-01", verifiedBy: "onboarding", method: "onboarding" },
        contacts: [{ ...v.contact, source: "vendor onboarding packet" }],
        contractPrices: v.catalog.map((c) => ({ sku: c.sku, description: c.description, unitCents: c.unitCents, uom: c.uom, effectiveFrom: "2025-07-01" })),
        credits: [],
        notes: [],
      },
    });
  }
  for (const l of LANDLORDS) {
    files.push({
      path: `vendors/${l.id}.yaml`,
      data: {
        id: l.id,
        legalName: l.legalName,
        category: "landlord",
        expenseAccount: "5200",
        termsNetDays: 5,
        status: "active",
        remitTo: { bank: l.bank, accountLast4: l.accountLast4, verifiedOn: "2025-03-01", verifiedBy: "onboarding", method: "onboarding" },
        contacts: [{ ...l.contact, source: "lease agreement" }],
        contractPrices: [],
        credits: [],
        notes: [],
      },
    });
  }

  stores.forEach((s, i) => {
    files.push({
      path: `stores/${s.id}.yaml`,
      data: {
        id: s.id,
        name: s.name,
        city: s.city,
        openedOn: `20${18 + (i % 6)}-0${1 + (i % 9)}-15`,
        lease: {
          landlord: LANDLORD_FOR[s.city] ?? "embarcadero-realty",
          baseRentCents: baseRentCents(i),
          camCapCents: camCapCents(i),
          startDate: "2022-01-01",
          endDate: "2032-12-31",
        },
        cardProcessor: { ...CARD_PROCESSOR },
        deliveryPlatforms: DELIVERY_PLATFORMS.map((p) => ({ platform: p.id, storeRef: `${p.id}-${s.id}`, commissionBps: p.commissionBps })),
      },
    });
  });

  for (const h of HUMANS) {
    files.push({ path: `people/${h.id}.yaml`, data: { id: h.id, name: h.name, title: h.title, seat: h.id, authority: [...h.authority] } });
  }
  for (const s of INITIAL_ORG) {
    files.push({
      path: `seats/${s.seatId}.yaml`,
      data: { id: s.seatId, role: s.role, name: s.name, ...(s.reportsTo ? { reportsTo: s.reportsTo } : {}), ...(s.effort ? { effort: s.effort } : {}), mandate: s.mandate },
    });
  }

  files.push({
    path: "playbooks/ap_clerk.yaml",
    data: {
      role: "ap_clerk",
      version: 1,
      steps: [
        { id: "parse", when: "document received", do: "parse with the vendor's registered parser; fall back to extraction", checks: ["line math", "total"] },
        { id: "duplicate", when: "parsed", do: "check vendor + normalized invoice number and same-amount-same-week look-alikes", checks: ["kernel duplicate guard"] },
        { id: "match", when: "not duplicate", do: "3-way match lines against contract prices and receiving logs", checks: ["price within materiality", "quantity received"] },
        { id: "credits", when: "matched", do: "apply open vendor credits from memory", checks: ["credit not already applied"] },
        { id: "decide", when: "checked", do: "approve if clean and under the auto-approve limit, else hold with exceptions", checks: ["policy limits"] },
      ],
      escalate: [
        { condition: "held bill", to: "controller" },
        { condition: "document asks to change payment details", to: "payments" },
      ],
    },
  });
  return files;
}
