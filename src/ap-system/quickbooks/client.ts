import { OAuth, boundedJson } from "./oauth";
import { QboError, hash, canonical } from "./private-store";
import type { Entity, Mappings, Operation, Plan } from "./types";
const BASE = "https://sandbox-quickbooks.api.intuit.com";
const entities = new Set([
  "Bill",
  "BillPayment",
  "VendorCredit",
  "Vendor",
  "Account",
  "CompanyInfo",
]);
export function matches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((v, i) => matches(v, actual[i]))
    );
  if (expected !== null && typeof expected === "object")
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(expected).every(([k, v]) =>
        matches(v, (actual as Record<string, unknown>)[k]),
      )
    );
  return expected === actual;
}
export class QboClient {
  constructor(
    readonly oauth: OAuth,
    readonly sleep = (ms: number) =>
      new Promise<void>((r) => setTimeout(r, ms)),
  ) {}
  async request(
    path: string,
    method: "GET" | "POST",
    body?: string,
    requestId?: string,
    query?: string,
  ) {
    if (
      !/^(bill|billpayment|vendorcredit|vendor|account|companyinfo)(\/\d{1,32})?$/.test(
        path,
      ) &&
      path !== "query"
    )
      throw new QboError("invalid_qbo_route");
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
    if (m.realmId !== this.oauth.config.realmId)
      throw new QboError("mapping_realm_mismatch");
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
    return { realmId: m.realmId, country: "US", mappingHash: hash(m) };
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
    const rows = data.QueryResponse?.[plan.entity] ?? [];
    if (!Array.isArray(rows) || rows.length >= 1000)
      throw new QboError("reconciliation_incomplete");
    // Any same marker with changed economics is a conflict, never silently picked.
    if (
      rows.length > 1 ||
      (rows.length === 1 && !matches(plan.payload, rows[0]))
    )
      throw new QboError("external_mapping_conflict");
    return rows[0] as Record<string, any> | undefined;
  }
  /** Deliberately no generic update/delete: external edits require reviewed corrections. */
  async verify(op: Operation) {
    if (!op.externalId) throw new QboError("external_identity_required");
    const found = await this.get(op.entity, op.externalId);
    if (String(found.SyncToken) !== op.syncToken || !matches(op.payload, found))
      throw new QboError("external_stale_or_changed");
    return found;
  }
  async create(op: Operation) {
    const data = await this.request(
      op.entity.toLowerCase(),
      "POST",
      canonical(op.payload),
      op.requestId,
    );
    const value = data[op.entity];
    if (!value || !matches(op.payload, value))
      throw new QboError("external_response_mismatch", true);
    return value as Record<string, any>;
  }
}
