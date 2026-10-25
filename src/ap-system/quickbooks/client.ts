import { OAuth, boundedJson } from "./oauth";
import { QboError, hash, canonical } from "./private-store";
import type { Entity, Mappings, Operation, Plan } from "./types";
import {
  validateDimensionPolicy,
  verifyProjectCatalog,
  type ProjectCatalogVerifier,
} from "./dimensions";
const BASE = "https://sandbox-quickbooks.api.intuit.com";
const entities = new Set([
  "Bill",
  "BillPayment",
  "VendorCredit",
  "JournalEntry",
  "Vendor",
  "Account",
  "CompanyInfo",
  "Class",
  "Department",
  "Customer",
]);
/** An absent/malformed query envelope is not evidence of zero matching transactions. */
function queryRows(
  data: Record<string, any>,
  entity: string,
): Record<string, any>[] {
  const q = data.QueryResponse;
  if (
    !Object.prototype.hasOwnProperty.call(data, "QueryResponse") ||
    !q ||
    typeof q !== "object" ||
    Array.isArray(q) ||
    Object.keys(q).some(
      (k) => ![entity, "startPosition", "maxResults", "totalCount"].includes(k),
    )
  )
    throw new QboError("qbo_query_envelope_invalid");
  const hasRows = Object.prototype.hasOwnProperty.call(q, entity);
  if (hasRows && !Array.isArray(q[entity]))
    throw new QboError("qbo_query_envelope_invalid");
  const rows: Record<string, any>[] = hasRows ? q[entity] : [];
  if (
    rows.some(
      (r) =>
        !r ||
        typeof r !== "object" ||
        Array.isArray(r) ||
        typeof r.Id !== "string" ||
        !/^\d{1,32}$/.test(r.Id),
    )
  )
    throw new QboError("qbo_query_envelope_invalid");
  for (const key of ["startPosition", "maxResults", "totalCount"])
    if (q[key] !== undefined && (!Number.isSafeInteger(q[key]) || q[key] < 0))
      throw new QboError("qbo_query_envelope_invalid");
  if (
    (q.startPosition !== undefined && q.startPosition !== 1) ||
    (q.totalCount !== undefined && q.totalCount !== rows.length) ||
    (q.maxResults !== undefined && q.maxResults < rows.length)
  )
    throw new QboError("qbo_query_incomplete");
  return rows;
}
function processingDisabled(value: Record<string, unknown>) {
  return (
    !Object.prototype.hasOwnProperty.call(value, "ProcessBillPayment") ||
    value.ProcessBillPayment === false
  );
}
export function matches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((v, i) => matches(v, actual[i]))
    );
  if (expected !== null && typeof expected === "object") {
    const e = expected as Record<string, any>;
    const a = actual as Record<string, any> | null;
    // Merchant processing is never an additive provider default we can certify.
    if (!processingDisabled(e) || (a && !processingDisabled(a))) return false;
    // Dimension/reference additions alter approved coding; provider metadata may be additive.
    for (const key of [
      "ClassRef",
      "DepartmentRef",
      "ProjectRef",
      "CustomerRef",
    ])
      if (e[key] == null && a?.[key] != null) return false;
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(expected).every(([k, v]) =>
        matches(v, (actual as Record<string, unknown>)[k]),
      )
    );
  }
  return expected === actual;
}
export class QboClient {
  constructor(
    readonly oauth: OAuth,
    readonly sleep = (ms: number) =>
      new Promise<void>((r) => setTimeout(r, ms)),
    readonly projectCatalogVerifier?: ProjectCatalogVerifier,
  ) {}
  async request(
    path: string,
    method: "GET" | "POST",
    body?: string,
    requestId?: string,
    query?: string,
  ) {
    if (
      !/^(bill|billpayment|vendorcredit|journalentry|vendor|account|class|department|customer|preferences|companyinfo)(\/\d{1,32})?$/.test(
        path,
      ) &&
      path !== "query"
    )
      throw new QboError("invalid_qbo_route");
    if (method === "POST" && /^billpayment(?:\/\d+)?$/.test(path)) {
      let payload: unknown;
      try {
        payload = JSON.parse(body ?? "");
      } catch {
        /* Reject before obtaining a token. */
      }
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        !processingDisabled(payload as Record<string, unknown>)
      )
        throw new QboError("merchant_processing_forbidden");
    }
    const url = new URL(
      `${BASE}/v3/company/${this.oauth.config.realmId}/${path}`,
    );
    url.searchParams.set("minorversion", "75");
    if (requestId) url.searchParams.set("requestid", requestId);
    if (query) url.searchParams.set("query", query);
    let token = await this.oauth.access();
    let refreshed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let res: Response;
      try {
        res = await this.oauth.transport(url, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          ...(body ? { body } : {}),
        });
      } catch {
        throw new QboError("qbo_transport_unknown", method === "POST");
      }
      if (res.status === 401 && !refreshed) {
        await res.body?.cancel();
        token = await this.oauth.access(token);
        refreshed = true;
        continue;
      }
      if (res.status === 429 || (method === "GET" && res.status >= 500)) {
        const retry = res.headers.get("retry-after");
        await res.body?.cancel();
        let wait = retry
          ? /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - Date.now()
          : 60000;
        if (!Number.isFinite(wait) || wait < 0) wait = 60000;
        if (attempt === 2 || wait > 60000)
          throw new QboError("qbo_retry_later");
        await this.sleep(Math.max(1000, wait));
        continue;
      }
      if (!res.ok) {
        const data = await boundedJson(res).catch(
          () => ({}) as Record<string, any>,
        );
        const code = String(data.Fault?.Error?.[0]?.code ?? "");
        if (code === "5010") throw new QboError("qbo_stale_sync_token");
        if (code === "6140" || code === "600")
          throw new QboError("qbo_duplicate_or_mapping_conflict");
        throw new QboError(
          res.status >= 500 || res.status === 408
            ? "qbo_write_unknown"
            : res.status === 401
              ? "qbo_reauthorization_required"
              : "qbo_request_rejected",
          method === "POST" && (res.status >= 500 || res.status === 408),
        );
      }
      return boundedJson(res);
    }
    throw new QboError("qbo_retry_exhausted");
  }
  async get(entity: string, id: string) {
    if (!entities.has(entity) || !/^\d{1,32}$/.test(id))
      throw new QboError("invalid_external_identity");
    const data = await this.request(`${entity.toLowerCase()}/${id}`, "GET");
    const value = data[entity];
    if (!value || (entity !== "CompanyInfo" && String(value.Id) !== id))
      throw new QboError("external_identity_mismatch");
    return value as Record<string, any>;
  }
  async verifyMappings(m: Mappings) {
    validateDimensionPolicy(m);
    if (m.realmId !== this.oauth.config.realmId)
      throw new QboError("mapping_realm_mismatch");
    const projects = Object.values(m.dimensions?.projects?.mappings ?? {});
    if (projects.length) {
      verifyProjectCatalog(m.dimensions!.projects!.catalog, m);
      if (!this.projectCatalogVerifier)
        throw new QboError("project_catalog_verification_required");
      const fresh = await this.projectCatalogVerifier({
        realmId: m.realmId,
        projectIds: projects.map((p) => p.id),
      });
      verifyProjectCatalog(fresh, m);
    }
    const info = await this.get("CompanyInfo", m.realmId);
    if (info.Country !== "US" && info.CompanyAddr?.Country !== "US")
      throw new QboError("us_company_required");
    for (const vendor of Object.values(m.vendors)) {
      const v = await this.get("Vendor", vendor.id);
      if (
        v.Active !== true ||
        v.DisplayName !== vendor.displayName ||
        (v.CurrencyRef && v.CurrencyRef.value !== "USD")
      )
        throw new QboError("vendor_mapping_conflict");
    }
    for (const account of Object.values(m.accounts)) {
      const a = await this.get("Account", account.id);
      if (
        a.Active !== true ||
        a.Name !== account.name ||
        a.AccountType !== account.type ||
        (a.CurrencyRef && a.CurrencyRef.value !== "USD")
      )
        throw new QboError("account_mapping_conflict");
    }
    for (const cls of Object.values(m.classes ?? {})) {
      const actual = await this.get("Class", cls.id);
      if (actual.Active !== true || actual.Name !== cls.name)
        throw new QboError("class_mapping_conflict");
    }
    const locations = Object.values(
      m.dimensions?.departmentAsLocation?.locations ?? {},
    );
    if (locations.length) {
      const prefs = await this.request("preferences", "GET");
      if (prefs.Preferences?.AccountingInfoPrefs?.TrackDepartments !== true)
        throw new QboError("department_tracking_required");
      for (const location of locations) {
        const actual = await this.get("Department", location.id);
        if (actual.Active !== true || actual.Name !== location.name)
          throw new QboError("department_mapping_conflict");
      }
    }
    for (const customerId of new Set(projects.map((p) => p.customerId))) {
      const customer = await this.get("Customer", customerId);
      if (customer.Active !== true)
        throw new QboError("project_customer_mapping_conflict");
    }
    return { realmId: m.realmId, country: "US", mappingHash: hash(m) };
  }
  /** QBO can omit optional BillPayment.APAccountRef. Prove it through every
   * exact linked payable instead of treating the missing field as a wildcard. */
  private async responseMatches(plan: Pick<Plan, "entity" | "payload">, actual: Record<string, any>) {
    if (matches(plan.payload, actual)) return true;
    const { APAccountRef, ...rest } = plan.payload;
    const apValue = APAccountRef && typeof APAccountRef === "object" && "value" in APAccountRef ? APAccountRef.value : undefined;
    if (
      plan.entity !== "BillPayment" ||
      !actual || Object.prototype.hasOwnProperty.call(actual, "APAccountRef") ||
      typeof apValue !== "string" ||
      !/^\d{1,32}$/.test(apValue) ||
      !matches(rest, actual) || !Array.isArray(rest.Line)
    ) return false;
    const links = rest.Line.flatMap((line: any) => line.LinkedTxn ?? []);
    if (!links.length || links.length > 100 || links.some((link: any) =>
      !link || !["Bill", "VendorCredit"].includes(link.TxnType) ||
      typeof link.TxnId !== "string" || !/^\d{1,32}$/.test(link.TxnId)
    )) return false;
    for (const link of links) {
      const payable = await this.get(link.TxnType, link.TxnId);
      if (!matches(APAccountRef, payable.APAccountRef) ||
          !matches(rest.VendorRef, payable.VendorRef) ||
          (rest.CurrencyRef && !matches(rest.CurrencyRef, payable.CurrencyRef))) return false;
    }
    return true;
  }
  async find(plan: Plan) {
    const doc = String(plan.payload.DocNumber);
    if (!/^AP[a-f0-9]{18}$/.test(doc))
      throw new QboError("invalid_operation_marker");
    const data = await this.request(
      "query",
      "GET",
      undefined,
      undefined,
      `SELECT * FROM ${plan.entity} WHERE DocNumber = '${doc}' MAXRESULTS 1000`,
    );
    const rows = queryRows(data, plan.entity);
    if (!Array.isArray(rows) || rows.length >= 1000)
      throw new QboError("reconciliation_incomplete");
    // Any same marker with changed economics is a conflict, never silently picked.
    if (
      rows.length > 1 ||
      (rows.length === 1 && !await this.responseMatches(plan, rows[0]!))
    )
      throw new QboError("external_mapping_conflict");
    return rows[0] as Record<string, any> | undefined;
  }
  /** Deliberately no generic update/delete: external edits require reviewed corrections. */
  async verify(op: Operation) {
    if (!op.externalId) throw new QboError("external_identity_required");
    const found = await this.get(op.entity, op.externalId);
    if (String(found.SyncToken) !== op.syncToken || !await this.responseMatches(op, found))
      throw new QboError("external_stale_or_changed");
    return found;
  }
  /** Bounded authoritative scan: never assume a journal's original AP principal remains unused. */
  async journalAppliedCents(op: Operation, vendorId: string) {
    if (
      op.entity !== "JournalEntry" ||
      !op.externalId ||
      !/^\d{1,32}$/.test(vendorId)
    )
      throw new QboError("invalid_external_identity");
    const data = await this.request(
      "query",
      "GET",
      undefined,
      undefined,
      `SELECT * FROM BillPayment WHERE VendorRef = '${vendorId}' MAXRESULTS 1000`,
    );
    const rows = queryRows(data, "BillPayment");
    if (
      !Array.isArray(rows) ||
      rows.length >= 1000 ||
      new Set(rows.map((r: any) => r.Id)).size !== rows.length
    )
      throw new QboError("restored_balance_incomplete");
    let total = 0n;
    for (const row of rows) {
      if (row.VendorRef?.value !== vendorId || !Array.isArray(row.Line))
        throw new QboError("restored_balance_incomplete");
      for (const line of row.Line) {
        const links = line.LinkedTxn ?? [];
        if (!Array.isArray(links))
          throw new QboError("restored_balance_incomplete");
        if (
          links.some(
            (l: any) =>
              l.TxnType === "JournalEntry" && l.TxnId === op.externalId,
          )
        ) {
          if (
            links.length !== 1 ||
            typeof line.Amount !== "number" ||
            line.Amount < 0 ||
            !Number.isSafeInteger(Math.round(line.Amount * 100)) ||
            Math.abs(line.Amount * 100 - Math.round(line.Amount * 100)) >
              0.000001
          )
            throw new QboError("restored_balance_conflict");
          total += BigInt(Math.round(line.Amount * 100));
        }
      }
    }
    if (total > BigInt(Number.MAX_SAFE_INTEGER))
      throw new QboError("restored_balance_conflict");
    return Number(total);
  }
  async create(op: Operation) {
    const data = await this.request(
      op.entity.toLowerCase(),
      "POST",
      canonical(op.payload),
      op.requestId,
    );
    const value = data[op.entity];
    if (!value || !await this.responseMatches(op, value))
      throw new QboError("external_response_mismatch", true);
    return value as Record<string, any>;
  }
}
