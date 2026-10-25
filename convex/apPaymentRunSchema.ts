import { defineTable } from "convex/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
export const paymentRunSelection = v.object({caseId:v.id("apCaseRecords"),expectedRevision:v.number(),snapshotHash:v.string(),amountCents:v.optional(v.number()),credits:v.optional(v.array(v.object({creditId:v.id("demoCredits"),amountCents:v.number()})))});
export const apPaymentRunTables = {
  apPaymentRuns: defineTable({scope:scopeValidator,requestKey:v.string(),requestedBy:v.string(),selection:v.array(paymentRunSelection),executionDate:v.optional(v.string()),
    items:v.array(v.object({caseId:v.id("apCaseRecords"),caseRevision:v.number(),caseSnapshotHash:v.string(),versionId:v.id("demoVersions"),paymentSnapshotHash:v.string()})),
    snapshotHash:v.string(),createdAt:v.number()}).index("by_key",["scope.runId","requestKey"]).index("by_run",["scope.runId"]),
};
