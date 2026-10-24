// Sweetgreen, Inc. (NYSE: SG): simulated finance function, calibrated to public filings.
// Not affiliated with Sweetgreen. All transactions, counterparties and people are simulated.

export const CALIBRATION = {
  revenueFY2025: { value: 679_474_000, unit: "USD", source: "SEC XBRL RevenueFromContractWithCustomerExcludingAssessedTax, FY ending 2025-12-28" },
  restaurantsFY2025: { value: 281, unit: "count", source: "SEC XBRL NumberOfRestaurants, 2025-12-28" },
  restaurantsFY2024: { value: 246, unit: "count", source: "SEC XBRL NumberOfRestaurants, 2024-12-29" },
  accountsPayableFY2025: { value: 19_885_000, unit: "USD", source: "SEC XBRL AccountsPayableCurrent, 2025-12-28" },
  contractLiabilityFY2025: { value: 7_177_000, unit: "USD", source: "SEC XBRL ContractWithCustomerLiabilityCurrent, 2025-12-28" },
  operatingLeaseLiabilityFY2025: { value: 354_494_000, unit: "USD", source: "SEC XBRL OperatingLeaseLiability, 2025-12-28" },
  cashFY2025: { value: 89_177_000, unit: "USD", source: "SEC XBRL CashAndCashEquivalentsAtCarryingValue, 2025-12-28" },
  cashFY2024: { value: 214_789_000, unit: "USD", source: "SEC XBRL CashAndCashEquivalentsAtCarryingValue, 2024-12-29" },
  accruedLiabilitiesFY2025: { value: 33_739_000, unit: "USD", source: "SEC XBRL AccruedLiabilitiesCurrent, 2025-12-28" },
  netLossFY2025: { value: -134_065_000, unit: "USD", source: "SEC XBRL NetIncomeLoss, FY ending 2025-12-28" },
} as const;

const avgRestaurants = (CALIBRATION.restaurantsFY2025.value + CALIBRATION.restaurantsFY2024.value) / 2;
/** Average revenue per restaurant per day, derived from the filings (~$7,080). */
export const REVENUE_PER_STORE_DAY_CENTS = Math.round((CALIBRATION.revenueFY2025.value * 100) / avgRestaurants / 364);

// Modeling assumptions (labeled as such, not from filings).
export const ASSUMPTIONS = {
  channelMix: { in_store: 0.47, digital: 0.33, marketplace: 0.2 },
  foodCostPct: 0.27,
  laborPct: 0.29,
  avgTicketCents: 1650,
  giftCardSalesPct: 0.012,
  giftCardRedemptionPct: 0.01,
  employeesPerStore: 18,
  hourlyRateCents: 2350,
  hoursPerEmployeeBiweekly: 60,
  dayOfWeekFactor: [0.72, 1.05, 1.08, 1.1, 1.08, 1.0, 0.78], // Sun..Sat
} as const;

export const STORES = [
  { id: "sf-hayes-valley", name: "Hayes Valley", city: "San Francisco" },
  { id: "sf-fidi", name: "Financial District", city: "San Francisco" },
  { id: "sf-mission", name: "Mission", city: "San Francisco" },
  { id: "sf-marina", name: "Marina", city: "San Francisco" },
  { id: "oak-rockridge", name: "Rockridge", city: "Oakland" },
  { id: "berkeley-telegraph", name: "Telegraph", city: "Berkeley" },
  { id: "pa-university", name: "University Ave", city: "Palo Alto" },
  { id: "sj-santana-row", name: "Santana Row", city: "San Jose" },
  { id: "sm-downtown", name: "Downtown", city: "San Mateo" },
  { id: "wc-locust", name: "Locust St", city: "Walnut Creek" },
  { id: "mv-castro", name: "Castro St", city: "Mountain View" },
  { id: "sf-soma", name: "SoMa", city: "San Francisco" },
] as const;

export interface VendorProfile {
  id: string;
  legalName: string;
  category: "produce" | "protein" | "dairy" | "packaging" | "beverage" | "supplies" | "facilities" | "tech" | "utilities" | "landlord" | "marketing" | "services";
  expenseAccount: string;
  termsNetDays: number;
  bank: string;
  accountLast4: string;
  contact: { name: string; email: string; phone: string };
  /** Invoice layout family the vendor sends (drives which parser applies). */
  layout: "columnar" | "keyvalue" | "narrative";
  /** Deliveries per store per week (0 = monthly bill). */
  deliveriesPerWeek: number;
  catalog: { sku: string; description: string; unitCents: number; uom: string; perDeliveryQty: [number, number] }[];
}

export const VENDORS: VendorProfile[] = [
  {
    id: "golden-state-produce", legalName: "Golden State Produce Co.", category: "produce", expenseAccount: "5000", termsNetDays: 14,
    bank: "Pacific Western Bank", accountLast4: "4417", contact: { name: "Maria Ochoa", email: "ar@gsproduce.example", phone: "+1-510-555-0141" },
    layout: "columnar", deliveriesPerWeek: 3,
    catalog: [
      { sku: "KALE-24", description: "Organic Kale, 24ct case", unitCents: 3850, uom: "case", perDeliveryQty: [4, 8] },
      { sku: "ROM-CS", description: "Romaine Hearts, case", unitCents: 4275, uom: "case", perDeliveryQty: [3, 6] },
      { sku: "AVO-48", description: "Hass Avocados, 48ct", unitCents: 6890, uom: "case", perDeliveryQty: [2, 5] },
      { sku: "TOM-25", description: "Heirloom Tomatoes, 25lb", unitCents: 5420, uom: "case", perDeliveryQty: [1, 3] },
    ],
  },
  {
    id: "bay-farms-protein", legalName: "Bay Farms Protein LLC", category: "protein", expenseAccount: "5000", termsNetDays: 21,
    bank: "First Republic Pacific", accountLast4: "9023", contact: { name: "Dev Patel", email: "billing@bayfarms.example", phone: "+1-415-555-0187" },
    layout: "keyvalue", deliveriesPerWeek: 2,
    catalog: [
      { sku: "CHK-THIGH-40", description: "Roasted Chicken Thigh, 40lb", unitCents: 15600, uom: "case", perDeliveryQty: [2, 4] },
      { sku: "SALMON-20", description: "Roasted Salmon, 20lb", unitCents: 24850, uom: "case", perDeliveryQty: [1, 2] },
      { sku: "TOFU-12", description: "Organic Tofu, 12x14oz", unitCents: 3120, uom: "case", perDeliveryQty: [1, 3] },
    ],
  },
  {
    id: "norcal-dairy", legalName: "NorCal Dairy Cooperative", category: "dairy", expenseAccount: "5000", termsNetDays: 14,
    bank: "Exchange Bank", accountLast4: "1186", contact: { name: "Hannah Lee", email: "ar@norcaldairy.example", phone: "+1-707-555-0112" },
    layout: "columnar", deliveriesPerWeek: 1,
    catalog: [
      { sku: "FETA-10", description: "Feta Crumbles, 10lb", unitCents: 4380, uom: "case", perDeliveryQty: [1, 3] },
      { sku: "GOAT-6", description: "Goat Cheese, 6x2lb", unitCents: 5210, uom: "case", perDeliveryQty: [1, 2] },
    ],
  },
  {
    id: "green-earth-packaging", legalName: "Green Earth Packaging Inc.", category: "packaging", expenseAccount: "5000", termsNetDays: 30,
    bank: "Silicon Valley Commerce Bank", accountLast4: "7731", contact: { name: "Tom Brandt", email: "invoices@greenearthpkg.example", phone: "+1-408-555-0166" },
    layout: "narrative", deliveriesPerWeek: 1,
    catalog: [
      { sku: "BOWL-32-300", description: "Compostable Bowl 32oz, 300ct", unitCents: 11250, uom: "case", perDeliveryQty: [2, 4] },
      { sku: "LID-32-300", description: "Fiber Lid 32oz, 300ct", unitCents: 6480, uom: "case", perDeliveryQty: [2, 4] },
      { sku: "BAG-KRAFT-500", description: "Kraft Bag, 500ct", unitCents: 8900, uom: "case", perDeliveryQty: [1, 2] },
    ],
  },
  {
    id: "hydra-beverages", legalName: "Hydra Beverage Distribution", category: "beverage", expenseAccount: "5000", termsNetDays: 30,
    bank: "Pacific Western Bank", accountLast4: "5520", contact: { name: "Luis Romero", email: "ar@hydrabev.example", phone: "+1-510-555-0109" },
    layout: "keyvalue", deliveriesPerWeek: 1,
    catalog: [
      { sku: "LEMON-24", description: "Sparkling Lemonade, 24ct", unitCents: 3360, uom: "case", perDeliveryQty: [2, 5] },
      { sku: "KOMBU-12", description: "Kombucha, 12ct", unitCents: 4140, uom: "case", perDeliveryQty: [1, 3] },
    ],
  },
  {
    id: "spotless-supply", legalName: "Spotless Restaurant Supply", category: "supplies", expenseAccount: "5300", termsNetDays: 30,
    bank: "Bank of the Orient", accountLast4: "3308", contact: { name: "Grace Kim", email: "billing@spotless.example", phone: "+1-415-555-0133" },
    layout: "columnar", deliveriesPerWeek: 1,
    catalog: [
      { sku: "GLOVE-L-1000", description: "Nitrile Gloves L, 1000ct", unitCents: 7450, uom: "case", perDeliveryQty: [1, 2] },
      { sku: "SANI-4G", description: "Sanitizer Concentrate, 4gal", unitCents: 5890, uom: "case", perDeliveryQty: [1, 1] },
    ],
  },
  {
    id: "pg-and-e-sim", legalName: "Pacific Gas & Electric (simulated)", category: "utilities", expenseAccount: "5300", termsNetDays: 21,
    bank: "Wells Fargo", accountLast4: "0091", contact: { name: "Customer Billing", email: "billing@utility.example", phone: "+1-800-555-0100" },
    layout: "narrative", deliveriesPerWeek: 0,
    catalog: [{ sku: "ELEC", description: "Electric & gas service", unitCents: 285000, uom: "month", perDeliveryQty: [1, 1] }],
  },
  {
    id: "toastline-pos", legalName: "Toastline POS Inc.", category: "tech", expenseAccount: "6100", termsNetDays: 30,
    bank: "Silicon Valley Commerce Bank", accountLast4: "2290", contact: { name: "Billing", email: "billing@toastline.example", phone: "+1-617-555-0150" },
    layout: "narrative", deliveriesPerWeek: 0,
    catalog: [{ sku: "POS-SUB", description: "POS subscription, per location", unitCents: 32900, uom: "location-month", perDeliveryQty: [1, 1] }],
  },
];

/** Landlords bill rent + CAM monthly per store; CAM is capped by the lease. */
export const LANDLORDS = [
  { id: "embarcadero-realty", legalName: "Embarcadero Realty Partners", bank: "Bank of America", accountLast4: "6612",
    contact: { name: "Lease Admin", email: "leases@embarcadero.example", phone: "+1-415-555-0175" } },
  { id: "peninsula-retail", legalName: "Peninsula Retail Holdings", bank: "Heritage Bank", accountLast4: "8840",
    contact: { name: "Lease Admin", email: "ar@peninsularetail.example", phone: "+1-650-555-0122" } },
  { id: "eastbay-properties", legalName: "East Bay Properties LLC", bank: "Mechanics Bank", accountLast4: "3175",
    contact: { name: "Lease Admin", email: "rent@eastbayprop.example", phone: "+1-510-555-0158" } },
] as const;

export const DELIVERY_PLATFORMS = [
  { id: "doordash-sim", name: "DoorDash (simulated)", commissionBps: 2500 },
  { id: "ubereats-sim", name: "Uber Eats (simulated)", commissionBps: 2700 },
] as const;

export const CARD_PROCESSOR = { name: "Adyen (simulated)", contractedRateBps: 260, perTxnCents: 10 } as const;

export const HUMANS = [
  { id: "human-cfo", name: "Human CFO", title: "Chief Financial Officer (overseer)", authority: ["policy", "payments>=50k", "period-close", "control-roles"] },
] as const;
