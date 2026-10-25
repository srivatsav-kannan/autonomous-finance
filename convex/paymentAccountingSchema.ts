import { v } from "convex/values";
const authority = {
  recognitionEntryId: v.string(),
  approvalId: v.string(),
  approvalHash: v.string(),
  policyHash: v.string(),
  accountingAuthorityHash: v.string(),
  appliedCents: v.number(),
};
export const accountingBindingValidator = v.object({
  version: v.literal("ap-payment-accounting-v1"),
  mode: v.literal("department_as_location"),
  department: v.union(v.string(), v.null()),
  bills: v.array(v.object({ billId: v.string(), ...authority })),
  credits: v.array(v.object({ creditId: v.string(), ...authority })),
});
