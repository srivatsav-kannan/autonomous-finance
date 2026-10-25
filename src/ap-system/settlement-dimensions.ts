import type { BusinessAcceptance, BusinessPolicy } from "./domain-contracts";
import type { GLCoordinates } from "./gl-dimensions";
export type SettlementDimensions = {
  version: "ap-settlement-dimensions-v1";
  mode: "department_as_location";
  department: string | null;
};
export type RecognitionSettlementAuthority = SettlementDimensions & {
  approvalHash: string;
  policyHash: string;
  journalHash: string;
};
export const acceptanceAllocations = (a: BusinessAcceptance) => [
  ...a.lines.flatMap((l) => l.allocations),
  ...a.freightAllocations,
  ...a.discountAllocations,
];
/** Only an explicit recognition policy can assign department to AP and eventual cash. */
export function settlementDimensions(
  allocations: GLCoordinates[],
  policy: Pick<BusinessPolicy, "dimensions">,
): SettlementDimensions | undefined {
  if (policy.dimensions?.scope !== "cost_and_settlement") return undefined;
  if (
    policy.dimensions.settlementDepartment !==
      "homogeneous_approved_department" ||
    !allocations.length
  )
    throw Error("settlement_dimension_policy_required");
  const departments = allocations.map((a) => a.department ?? null);
  if (
    new Set(departments).size !== 1 ||
    departments.some(
      (d) => d !== null && !policy.dimensions!.departments.includes(d),
    )
  )
    throw Error("settlement_department_mixed_or_unknown");
  return {
    version: "ap-settlement-dimensions-v1",
    mode: "department_as_location",
    department: departments[0]!,
  };
}
export function payableDimensions(
  vendor: string,
  dimensions?: SettlementDimensions,
) {
  return {
    vendor,
    ...(dimensions?.department ? { department: dimensions.department } : {}),
  };
}
