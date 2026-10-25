import type { Mappings } from "./types";
import { QboError } from "./private-store";

/** Absent department AND project denotes a legacy allocation whose policy forbade both. */
export type AllocationDimensions = {
  store: string | null;
  department?: string | null;
  project?: string | null;
};
export type ProjectReference = {
  id: string;
  name: string;
  customerId: string;
  billable: boolean;
};
export type ProjectCatalog = {
  realmId: string;
  observedAt: number;
  validUntil: number;
  responseHash: string;
  entitlementHash: string;
  scope: "project-management.project";
  projects: Array<{
    id: string;
    name: string;
    customerId: string;
    active: true;
  }>;
};
export type DimensionPolicy = {
  version: "ap-qbo-dimensions-v1";
  policyId: string;
  reviewedBy: string;
  reviewedAt: number;
  departmentAsLocation?: {
    mode: "department_as_location";
    locations: Record<string, { id: string; name: string }>;
  };
  projects?: {
    mode: "qbo_project";
    catalog: ProjectCatalog;
    mappings: Record<string, ProjectReference>;
  };
};
/** Server-only injection: fetch current catalog/entitlement using an already-authorized provider grant.
 * No implementation or scope expansion is inferred from a configured receipt. */
export type ProjectCatalogVerifier = (request: {
  realmId: string;
  projectIds: string[];
}) => Promise<ProjectCatalog>;
const externalId = (v: unknown): v is string =>
  typeof v === "string" && /^\d{1,32}$/.test(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && !!v.trim() && v.length <= 240;
const digest = (v: unknown) =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function validateDimensionPolicy(m: Mappings) {
  const p = m.dimensions;
  if (!p) return;
  if (
    p.version !== "ap-qbo-dimensions-v1" ||
    !text(p.policyId) ||
    !text(p.reviewedBy) ||
    !Number.isSafeInteger(p.reviewedAt) ||
    p.reviewedAt < 0
  )
    throw new QboError("dimension_policy_required");
  if (p.departmentAsLocation) {
    const d = p.departmentAsLocation;
    if (
      d.mode !== "department_as_location" ||
      !d.locations ||
      typeof d.locations !== "object" ||
      Array.isArray(d.locations)
    )
      throw new QboError("department_location_policy_required");
    const rows = Object.values(d.locations);
    if (
      rows.some((r) => !r || !externalId(r.id) || !text(r.name)) ||
      new Set(rows.map((r) => r.id)).size !== rows.length
    )
      throw new QboError("department_mapping_conflict");
  }
  if (p.projects) {
    const d = p.projects;
    if (
      d.mode !== "qbo_project" ||
      !d.mappings ||
      typeof d.mappings !== "object" ||
      Array.isArray(d.mappings)
    )
      throw new QboError("project_policy_required");
    const rows = Object.values(d.mappings);
    if (
      rows.some(
        (r) =>
          !r ||
          !externalId(r.id) ||
          !externalId(r.customerId) ||
          !text(r.name) ||
          typeof r.billable !== "boolean",
      ) ||
      new Set(rows.map((r) => r.id)).size !== rows.length
    )
      throw new QboError("project_mapping_conflict");
  }
}
export function verifyProjectCatalog(
  c: ProjectCatalog | undefined,
  m: Mappings,
  now = Date.now(),
) {
  if (
    !c ||
    c.realmId !== m.realmId ||
    c.scope !== "project-management.project" ||
    !digest(c.responseHash) ||
    !digest(c.entitlementHash) ||
    !Number.isSafeInteger(c.observedAt) ||
    !Number.isSafeInteger(c.validUntil) ||
    c.observedAt > now ||
    c.observedAt < 0 ||
    c.validUntil <= now ||
    c.validUntil <= c.observedAt ||
    !Array.isArray(c.projects)
  )
    throw new QboError("project_catalog_or_entitlement_required");
  if (
    c.projects.some(
      (r) =>
        !r ||
        !externalId(r.id) ||
        !text(r.name) ||
        !externalId(r.customerId) ||
        r.active !== true,
    )
  )
    throw new QboError("project_catalog_conflict");
  if (new Set(c.projects.map((r) => r.id)).size !== c.projects.length)
    throw new QboError("project_catalog_conflict");
  for (const p of Object.values(m.dimensions?.projects?.mappings ?? {})) {
    const r = c.projects.find((r) => r.id === p.id);
    if (
      !r ||
      r.active !== true ||
      r.name !== p.name ||
      r.customerId !== p.customerId
    )
      throw new QboError("project_catalog_conflict");
  }
}
export function dimensionsOf(a: AllocationDimensions) {
  const legacy = a.department === undefined && a.project === undefined;
  const department = legacy ? null : a.department;
  const project = legacy ? null : a.project;
  if (
    (department !== null && !text(department)) ||
    (project !== null && !text(project))
  )
    throw new QboError("allocation_dimensions_missing");
  return { department, project };
}
export function classReference(store: unknown, m: Mappings) {
  if (store === null) return {};
  if (!text(store)) throw new QboError("store_dimension_missing");
  const cls = m.classes?.[store];
  if (!cls) throw new QboError("class_mapping_missing");
  return { ClassRef: { value: cls.id } };
}
export function lineDimensions(a: AllocationDimensions, m: Mappings) {
  validateDimensionPolicy(m);
  const { project } = dimensionsOf(a);
  const detail = classReference(a.store, m);
  if (project === null)
    return { line: {}, detail: { ...detail, BillableStatus: "NotBillable" } };
  const p = m.dimensions?.projects;
  if (!p) throw new QboError("project_policy_required");
  verifyProjectCatalog(p.catalog, m);
  const r = p.mappings[project];
  if (!r) throw new QboError("project_mapping_missing");
  return {
    line: { ProjectRef: { value: r.id } },
    detail: {
      ...detail,
      CustomerRef: { value: r.customerId },
      BillableStatus: r.billable ? "Billable" : "NotBillable",
    },
  };
}
export function documentDimensions(
  allocations: AllocationDimensions[],
  m: Mappings,
) {
  validateDimensionPolicy(m);
  const departments = new Set(
    allocations.map((a) => dimensionsOf(a).department),
  );
  if (departments.size > 1)
    throw new QboError("mixed_department_export_unsupported");
  const department = [...departments][0] ?? null;
  if (department === null) return {};
  const p = m.dimensions?.departmentAsLocation;
  if (!p) throw new QboError("department_location_policy_required");
  const location = p.locations[department];
  if (!location) throw new QboError("department_mapping_missing");
  return { DepartmentRef: { value: location.id } };
}
/** JournalEntry has per-line location. A project must never replace the approved vendor Entity. */
export function journalDimensions(a: AllocationDimensions, m: Mappings) {
  const { project } = dimensionsOf(a);
  if (project !== null)
    throw new QboError("journal_project_entity_or_billability_unsupported");
  return { ...classReference(a.store, m), ...documentDimensions([a], m) };
}
export const dimensionErrors = new Set([
  "dimension_policy_required",
  "department_location_policy_required",
  "department_mapping_conflict",
  "department_mapping_missing",
  "mixed_department_export_unsupported",
  "project_policy_required",
  "project_mapping_conflict",
  "project_mapping_missing",
  "project_catalog_or_entitlement_required",
  "project_catalog_conflict",
  "allocation_dimensions_missing",
  "store_dimension_missing",
  "class_mapping_missing",
  "project_catalog_verification_required",
  "department_tracking_required",
  "authoritative_dimension_export_required",
  "department_settlement_authority_required",
  "settlement_accounting_binding_invalid",
  "close_dimension_authority_required",
  "journal_project_entity_or_billability_unsupported",
  "project_customer_mapping_conflict",
]);
