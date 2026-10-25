/** Local dimensions describe approved cost allocations; they do not infer AP/cash dimensions. */
export type GLCoordinates = {
  store?: string | null;
  department?: string | null;
  project?: string | null;
};
export type GLDimensionPolicy = {
  version: "ap-gl-dimensions-v1";
  scope: "cost_allocations" | "cost_and_settlement";
  settlementDepartment?: "homogeneous_approved_department";
  departments: string[];
  projects: string[];
};
export function dimensionPolicyProblem(
  a: GLCoordinates,
  policy: { dimensions?: GLDimensionPolicy },
): string | null {
  if (a.department == null && a.project == null) return null;
  const p = policy.dimensions;
  if (
    !p ||
    p.version !== "ap-gl-dimensions-v1" ||
    !["cost_allocations", "cost_and_settlement"].includes(p.scope)
  )
    return "unsupported_dimension";
  if (
    a.department != null &&
    (!a.department.trim() || !p.departments.includes(a.department))
  )
    return "unknown_department";
  if (
    a.project != null &&
    (!a.project.trim() || !p.projects.includes(a.project))
  )
    return "unknown_project";
  return null;
}
/** Preserve legacy null/null serialization; an extended allocation always emits both fields. */
export function extendedDimensions(a: GLCoordinates) {
  return a.department != null || a.project != null
    ? { department: a.department ?? null, project: a.project ?? null }
    : {};
}
export function journalDimensions(a: GLCoordinates, vendor?: string | null) {
  return {
    ...(vendor ? { vendor } : {}),
    ...(a.store ? { store: a.store } : {}),
    ...(a.department ? { department: a.department } : {}),
    ...(a.project ? { project: a.project } : {}),
  };
}
export function sameCoordinates(a: GLCoordinates, b: GLCoordinates) {
  return (
    (a.store ?? null) === (b.store ?? null) &&
    (a.department ?? null) === (b.department ?? null) &&
    (a.project ?? null) === (b.project ?? null)
  );
}
export const supportedGLDimensionKeys = [
  "vendor",
  "store",
  "department",
  "project",
];
