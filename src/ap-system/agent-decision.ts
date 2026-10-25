import { z } from "zod";

export const apModelDecisionOutputSchema = z.object({
  action: z.enum(["advance", "wait", "handoff"]),
  reason: z.string().trim().min(1).max(800),
  evidenceIds: z.array(z.string().min(1)).max(40),
}).strict();
export const modelDecisionSchema = apModelDecisionOutputSchema.extend({
  version: z.literal("ap-model-decision-v1"),
  runId: z.string().min(1).max(160),
  mode: z.literal("model"),
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1).max(160),
  inspectedRevision: z.number().int().positive(),
  inspectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), costMicros: z.number().int().nonnegative() }).strict(),
  latencyMs: z.number().int().nonnegative(),
}).strict();
export type APModelDecision = z.infer<typeof modelDecisionSchema>;
