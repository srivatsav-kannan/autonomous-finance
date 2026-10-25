import { z } from "zod";
export const AP_WORK_CONTRACT_VERSION = "ap-work-v1" as const;
const id = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const workSnapshotSchema = z.object({
  status: z.enum(["queued", "leased", "waiting", "complete", "escalated", "paused"]),
  stage: id, owner: id, role: z.enum(["ap_clerk", "payments"]), reason: id,
  requirements: z.array(id), generation: z.number().int().nonnegative(),
  waitSince: z.number().nullable(), deadlineAt: z.number().nullable(),
}).strict();
export const workViewSchema = workSnapshotSchema.extend({
  workId: id, caseId: id, version: id, updatedAt: z.number(),
});
const value = z.union([z.string(), z.number(), z.array(z.string()), z.null()]);
export const workTransitionSchema = z.object({
  contractVersion: z.literal(AP_WORK_CONTRACT_VERSION), workId: id, operationId: id,
  action: z.enum(["created", "claimed", "handoff", "advanced", "paused", "resumed", "escalated", "control_denied"]),
  actorKind: z.enum(["agent", "human", "system"]), authority: id, workerVersion: id, policyVersion:id,
  caseRevision: z.number().int().positive(), snapshotHash: hash,
  sourceBindings: z.array(z.object({sourceId:id,revision:z.number().int().positive(),sha256:hash})),
  before: workSnapshotSchema.nullable(), after: workSnapshotSchema,
  changes: z.array(z.object({field:workSnapshotSchema.keyof(),before:value,after:value})),
  outcome: z.enum(["committed", "denied"]),
  // Decision context is validated separately by the shared model-decision contract before persistence.
  decision: z.unknown().optional(),
}).strict();
export const workControlSchema = z.object({
  caseId:id, action:z.enum(["pause", "resume"]), reason:id.max(2000),
  expectedGeneration:z.number().int().nonnegative(), expectedRevision:z.number().int().positive(),
  snapshotHash:hash, idempotencyKey:id.max(160),
}).strict();
export type APWorkSnapshot = z.infer<typeof workSnapshotSchema>;
export type APWorkView = z.infer<typeof workViewSchema>;
export type APWorkTransition = z.infer<typeof workTransitionSchema>;
export type APWorkControl = z.infer<typeof workControlSchema>;
