import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { businessFixture, acceptance, policy } from "./business-fixture";
import { successful } from "./quickbooks-business-fixture";
import {
  billPlan,
  creditPlan,
  dimensionHold,
} from "../../src/ap-system/quickbooks/plans";
import {
  dimensionsOf,
  documentDimensions,
  lineDimensions,
  type ProjectCatalogVerifier,
} from "../../src/ap-system/quickbooks/dimensions";
import { QboClient, matches } from "../../src/ap-system/quickbooks/client";
import type { OAuth } from "../../src/ap-system/quickbooks/oauth";
import type {
  AccountingExport,
  Mappings,
} from "../../src/ap-system/quickbooks/types";
import { hash } from "../../src/ap-system/quickbooks/private-store";
const current = makeFunctionReference<"query">("apAccountingExport:current");
afterEach(() => vi.unstubAllEnvs());
function mappings(): Mappings {
  const now = Date.now();
  return {
    version: "explicit-dimension-policy-test",
    realmId: "123",
    country: "US",
    vendors: {
      "golden-state-produce": {
        id: "5",
        displayName: "Golden State Produce Co.",
      },
    },
    accounts: {
      "2000": { id: "33", name: "AP", type: "Accounts Payable" },
      "1000": { id: "35", name: "Bank", type: "Bank" },
      "5000": { id: "7", name: "Produce", type: "Expense" },
    },
    classes: { "sf-hayes-valley": { id: "9", name: "SF Hayes Valley" } },
    apAccount: "2000",
    bankAccount: "1000",
    dimensions: {
      version: "ap-qbo-dimensions-v1",
      policyId: "synthetic-reviewed-policy",
      reviewedBy: "synthetic-controller",
      reviewedAt: now,
      departmentAsLocation: {
        mode: "department_as_location",
        locations: { operations: { id: "10", name: "Operations" } },
      },
      projects: {
        mode: "qbo_project",
        mappings: {
          remodel: {
            id: "11",
            name: "Remodel",
            customerId: "12",
            billable: false,
          },
        },
        catalog: {
          realmId: "123",
          observedAt: now,
          validUntil: now + 60000,
          responseHash: "a".repeat(64),
          entitlementHash: "b".repeat(64),
          scope: "project-management.project",
          projects: [
            { id: "11", name: "Remodel", customerId: "12", active: true },
          ],
        },
      },
    },
  };
}
const allocation = () => ({
  store: "sf-hayes-valley",
  department: "operations",
  project: "remodel",
});
async function invoice() {
  const p = policy();
  p.dimensions = {
    version: "ap-gl-dimensions-v1",
    scope: "cost_allocations",
    departments: ["operations"],
    projects: ["remodel"],
  };
  const f = await businessFixture({ policy: p });
  const accepted = acceptance(f.input, "1");
  Object.assign(accepted.lines[0]!.allocations[0]!, allocation());
  await f.recognize(f.detail, accepted);
  const e = (await f.humans.finance!.query(current, {
    scope: f.scope,
    caseId: f.detail.caseId,
  })) as AccountingExport;
  expect(e.recognizedInvoice!.allocations[0]).toMatchObject(allocation());
  return e;
}
function client(
  m: Mappings,
  verifier?: ProjectCatalogVerifier,
  override: Record<string, unknown> = {},
) {
  const calls: URL[] = [];
  const responses: Record<string, unknown> = {
    "/companyinfo/123": { CompanyInfo: { Country: "US" } },
    "/vendor/5": {
      Vendor: {
        Id: "5",
        Active: true,
        DisplayName: "Golden State Produce Co.",
      },
    },
    "/class/9": { Class: { Id: "9", Active: true, Name: "SF Hayes Valley" } },
    "/department/10": {
      Department: { Id: "10", Active: true, Name: "Operations" },
    },
    "/customer/12": { Customer: { Id: "12", Active: true } },
    "/preferences": {
      Preferences: { AccountingInfoPrefs: { TrackDepartments: true } },
    },
    ...Object.fromEntries(
      Object.values(m.accounts).map((a) => [
        `/account/${a.id}`,
        {
          Account: {
            Id: a.id,
            Active: true,
            Name: a.name,
            AccountType: a.type,
          },
        },
      ]),
    ),
    ...override,
  };
  const oauth = {
    config: { realmId: "123" },
    access: async () => "protocol-only-token",
    transport: async (url: URL, init: RequestInit) => {
      calls.push(url);
      expect(init.method).toBe("GET");
      expect(url.origin).toBe("https://sandbox-quickbooks.api.intuit.com");
      const key = url.pathname.replace("/v3/company/123", "");
      if (!(key in responses))
        throw new Error(`unexpected protocol route ${key}`);
      return new Response(JSON.stringify(responses[key]), { status: 200 });
    },
  } as unknown as OAuth;
  return { client: new QboClient(oauth, async () => {}, verifier), calls };
}
describe("explicit QBO department/project mapping", () => {
  it("preserves store Class, document location and project/customer without making expenses billable", async () => {
    const e = await invoice(),
      m = mappings(),
      p = billPlan(e, m);
    expect(p.payload.DepartmentRef).toEqual({ value: "10" });
    expect((p.payload.Line as any[])[0]).toMatchObject({
      ProjectRef: { value: "11" },
      AccountBasedExpenseLineDetail: {
        ClassRef: { value: "9" },
        CustomerRef: { value: "12" },
        BillableStatus: "NotBillable",
      },
    });
    const r = e.recognizedInvoice!;
    const cp = creditPlan(
      { ...r, creditId: "synthetic-credit" },
      m,
      successful(p, "90"),
    );
    expect(cp.payload.DepartmentRef).toEqual(p.payload.DepartmentRef);
    expect(cp.payload.Line).toEqual(p.payload.Line);
    const changed = structuredClone(m);
    changed.dimensions!.projects!.mappings.remodel!.billable = true;
    const next = billPlan(e, changed);
    expect(
      (next.payload.Line as any[])[0].AccountBasedExpenseLineDetail
        .BillableStatus,
    ).toBe("Billable");
    expect(next.mappingHash).not.toBe(p.mappingHash);
    expect(hash(next.payload)).not.toBe(hash(p.payload));
  });
  it("keeps missing policy an owned hold in preview and plan", async () => {
    const e = await invoice(),
      m = mappings();
    delete m.dimensions;
    expect(dimensionHold(e, m)).toMatchObject({
      owner: "controller",
      code: "department_location_policy_required",
    });
    expect(() => billPlan(e, m)).toThrow("department_location_policy_required");
  });
  it("requires both new fields together while preserving explicit legacy and null semantics", () => {
    expect(dimensionsOf({ store: null })).toEqual({
      department: null,
      project: null,
    });
    expect(
      dimensionsOf({ store: null, department: null, project: null }),
    ).toEqual({ department: null, project: null });
    expect(() => dimensionsOf({ store: null, department: null })).toThrow(
      "allocation_dimensions_missing",
    );
    expect(() =>
      dimensionsOf({ store: null, department: "", project: null }),
    ).toThrow("allocation_dimensions_missing");
  });
  it.each([null, "unmapped"])(
    "holds heterogeneous departments including %s; no line is dropped",
    (department) => {
      expect(() =>
        documentDimensions(
          [allocation(), { ...allocation(), department }],
          mappings(),
        ),
      ).toThrow("mixed_department_export_unsupported");
    },
  );
  it("requires literal department-as-location declaration and reviewed mapping", () => {
    const m = mappings();
    (m.dimensions!.departmentAsLocation as any).mode = "automatic";
    expect(() => documentDimensions([allocation()], m)).toThrow(
      "department_location_policy_required",
    );
    m.dimensions!.departmentAsLocation!.mode = "department_as_location";
    m.dimensions!.departmentAsLocation!.locations = {};
    expect(() => documentDimensions([allocation()], m)).toThrow(
      "department_mapping_missing",
    );
  });
  it.each([
    "missing",
    "expired",
    "realm",
    "entitlement",
    "relation",
    "inactive",
    "duplicate",
  ])("holds %s project catalog evidence", (kind) => {
    const m = mappings(),
      p = m.dimensions!.projects!;
    if (kind === "missing") (p as any).catalog = undefined;
    if (kind === "expired") p.catalog.validUntil = Date.now() - 1;
    if (kind === "realm") p.catalog.realmId = "999";
    if (kind === "entitlement") p.catalog.entitlementHash = "";
    if (kind === "relation") p.catalog.projects[0]!.customerId = "999";
    if (kind === "inactive") (p.catalog.projects[0] as any).active = false;
    if (kind === "duplicate")
      p.catalog.projects.push({ ...p.catalog.projects[0]! });
    expect(() => lineDimensions(allocation(), m)).toThrow(/project_catalog/);
  });
  it("rejects absent billability instead of defaulting it", () => {
    const m = mappings();
    delete (m.dimensions!.projects!.mappings.remodel as any).billable;
    expect(() => lineDimensions(allocation(), m)).toThrow(
      "project_mapping_conflict",
    );
  });
});
describe("fresh provider catalog gates and dimensional readback", () => {
  it("static catalog does not authorize a project submit without trusted current verifier", async () => {
    const m = mappings(),
      f = client(m);
    await expect(f.client.verifyMappings(m)).rejects.toThrow(
      "project_catalog_verification_required",
    );
    expect(f.calls).toHaveLength(0);
  });
  it("verifies current project relation, customer, location and location preference using read-only protocol", async () => {
    const m = mappings(),
      verify = vi.fn(async () =>
        structuredClone(m.dimensions!.projects!.catalog),
      ),
      f = client(m, verify);
    await expect(f.client.verifyMappings(m)).resolves.toMatchObject({
      realmId: "123",
      mappingHash: hash(m),
    });
    expect(verify).toHaveBeenCalledWith({ realmId: "123", projectIds: ["11"] });
    expect(f.calls.some((u) => u.pathname.endsWith("/department/10"))).toBe(
      true,
    );
    expect(f.calls.some((u) => u.pathname.endsWith("/customer/12"))).toBe(true);
  });
  it("rejects changed current project relation despite valid reviewed snapshot", async () => {
    const m = mappings(),
      fresh = structuredClone(m.dimensions!.projects!.catalog);
    fresh.projects[0]!.customerId = "99";
    const f = client(m, async () => fresh);
    await expect(f.client.verifyMappings(m)).rejects.toThrow(
      "project_catalog_conflict",
    );
  });
  it.each([
    [
      "/preferences",
      { Preferences: { AccountingInfoPrefs: { TrackDepartments: false } } },
      "department_tracking_required",
    ],
    [
      "/department/10",
      { Department: { Id: "10", Name: "Changed", Active: true } },
      "department_mapping_conflict",
    ],
    [
      "/customer/12",
      { Customer: { Id: "12", Active: false } },
      "project_customer_mapping_conflict",
    ],
  ])(
    "holds unavailable current reference %s",
    async (path, response, error) => {
      const m = mappings(),
        f = client(m, async () => m.dimensions!.projects!.catalog, {
          [String(path)]: response,
        });
      await expect(f.client.verifyMappings(m)).rejects.toThrow(String(error));
    },
  );
  for (const field of [
    "ClassRef",
    "DepartmentRef",
    "ProjectRef",
    "CustomerRef",
  ]) {
    it(`rejects missing/changed/unexpected ${field} while accepting non-dimensional metadata`, () => {
      const p = {
        Line: [
          {
            JournalEntryLineDetail: {
              AccountRef: { value: "7" },
              [field]: { value: "10" },
            },
          },
        ],
      };
      const metadata = structuredClone(p) as any;
      metadata.Line[0].JournalEntryLineDetail.providerMetadata = "allowed";
      expect(matches(p, metadata)).toBe(true);
      const missing = structuredClone(p) as any;
      delete missing.Line[0].JournalEntryLineDetail[field];
      expect(matches(p, missing)).toBe(false);
      expect(matches(missing, p)).toBe(false);
      const changed = structuredClone(p) as any;
      changed.Line[0].JournalEntryLineDetail[field].value = "11";
      expect(matches(p, changed)).toBe(false);
      expect(matches({}, { [field]: { value: "10" } })).toBe(false);
    });
  }
});

describe("dimension lifecycle gates", () => {
  it("keeps the immutable operation prepared with no POST and no invented external receipt when project verification is unavailable", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { PrivateStore } =
      await import("../../src/ap-system/quickbooks/private-store");
    const { SyncJournal } = await import("../../src/ap-system/quickbooks/sync");
    const root = await mkdtemp(join(tmpdir(), "qbo-dimensions-"));
    try {
      const e = await invoice(),
        m = mappings(),
        p = billPlan(e, m),
        f = client(m);
      const j = new SyncJournal(new PrivateStore(root), f.client);
      for (let n = 0; n < 2; n++)
        await expect(
          j.execute(p, m, undefined, {
            subject: "test-human",
            planHash: hash(p),
            decidedAt: Date.now(),
          }),
        ).rejects.toThrow("project_catalog_verification_required");
      expect(await j.get(p)).toMatchObject({
        state: "prepared",
        attempts: 0,
        externalId: null,
        responseHash: null,
        lastError: "project_catalog_verification_required",
      });
      expect(f.calls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("holds department payment and restored allocation until their local journals carry that authority", async () => {
    const { creditFixture, seedSettled } =
      await import("./quickbooks-business-fixture");
    const { paymentPlan } =
      await import("../../src/ap-system/quickbooks/plans");
    const { allocatedPaymentPlan } =
      await import("../../src/ap-system/quickbooks/correction-plans");
    const f = await creditFixture(),
      settled = await seedSettled(f, 2000, 2000);
    const e = await settled.load(f.detail.caseId, {
      paymentVersionId: settled.versionId,
    });
    Object.assign(e.recognizedInvoice!.allocations[0]!, allocation());
    const m = mappings(),
      b = successful(billPlan(e, m), "90");
    expect(dimensionHold(e, m)).toMatchObject({
      code: "department_settlement_authority_required",
      owner: "controller",
    });
    expect(() => paymentPlan(e, m, b)).toThrow(
      "department_settlement_authority_required",
    );
    expect(() => allocatedPaymentPlan(e, m, b, [], [])).toThrow(
      "department_settlement_authority_required",
    );
  });
});
