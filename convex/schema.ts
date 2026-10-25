import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { demoTables } from "./demoSchema";
import { demoEvidenceTables } from "./demoEvidenceSchema";

// Every table is scoped by runId (a scenario namespace) so eval runs and demo resets never mix.

export const sourceValidator = v.object({
  kind: v.string(), // e.g. "bill", "payment_settlement", "bank_match", "revenue_daily", "payroll", "lease", "adjustment"
  ref: v.optional(v.string()),
});

export const lineValidator = v.object({
  account: v.string(),
  debit: v.number(), // integer cents
  credit: v.number(), // integer cents
  memo: v.optional(v.string()),
  dims: v.optional(
    v.object({
      store: v.optional(v.string()),
      vendor: v.optional(v.string()),
      channel: v.optional(v.string()),
      employee: v.optional(v.string()),
    }),
  ),
});

export default defineSchema({
  ...demoTables,
  ...demoEvidenceTables,
  runs: defineTable({
    runId: v.string(),
    label: v.string(),
    company: v.string(),
    simDate: v.string(), // YYYY-MM-DD, the world's current day
    status: v.union(v.literal("active"), v.literal("finished")),
    createdAt: v.number(),
    config: v.optional(v.any()),
  }).index("by_runId", ["runId"]),

  seats: defineTable({
    runId: v.string(),
    seatId: v.string(), // e.g. "ap-clerk-2"
    role: v.string(),
    name: v.string(),
    kind: v.union(v.literal("agent"), v.literal("human")),
    capabilities: v.any(), // Capabilities from src/core/roles.ts, validated in code
    reportsTo: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("retired")),
    tokenHash: v.string(),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    spawnedBy: v.optional(v.string()),
    createdAt: v.number(),
    retiredAt: v.optional(v.number()),
  })
    .index("by_run_seat", ["runId", "seatId"])
    .index("by_run_role", ["runId", "role", "status"]),

  idempotency: defineTable({
    runId: v.string(),
    key: v.string(),
    scope: v.string(), // which operation
    payloadHash: v.string(),
    result: v.any(),
    createdAt: v.number(),
  }).index("by_run_key", ["runId", "key"]),

  periods: defineTable({
    runId: v.string(),
    period: v.string(), // YYYY-MM
    status: v.union(v.literal("open"), v.literal("closed")),
    closedBy: v.optional(v.array(v.string())),
    closeSnapshotHash: v.optional(v.string()), // Scoped AP signatures apply only to this reviewed state.
    closedAt: v.optional(v.number()),
    ledgerHead: v.optional(v.string()),
    memoryTag: v.optional(v.string()),
  }).index("by_run_period", ["runId", "period"]),

  ledgerHeads: defineTable({
    runId: v.string(),
    hash: v.string(),
    sequence: v.number(),
  }).index("by_run", ["runId"]),

  journalEntries: defineTable({
    runId: v.string(),
    sequence: v.number(),
    date: v.string(),
    period: v.string(),
    memo: v.string(),
    source: sourceValidator,
    lines: v.array(lineValidator),
    totalCents: v.number(),
    postedBy: v.string(),
    taskId: v.optional(v.string()),
    decisionPath: v.optional(v.string()),
    memorySha: v.optional(v.string()),
    idempotencyKey: v.string(),
    status: v.union(v.literal("posted"), v.literal("reversed")),
    reversalOf: v.optional(v.id("journalEntries")),
    reversedBy: v.optional(v.id("journalEntries")),
    prevHash: v.string(),
    hash: v.string(),
    postedAt: v.number(),
  })
    .index("by_run_sequence", ["runId", "sequence"])
    .index("by_run_period", ["runId", "period"])
    .index("by_run_source", ["runId", "source.kind", "source.ref"]),

  balances: defineTable({
    runId: v.string(),
    account: v.string(),
    period: v.string(),
    debits: v.number(),
    credits: v.number(),
  }).index("by_run_account_period", ["runId", "account", "period"]),

  events: defineTable({
    runId: v.string(),
    type: v.string(), // e.g. "document.received", "bank.transaction", "receiving.logged", "sales.daily"
    externalId: v.string(), // dedupe key from the outside world
    occurredOn: v.string(), // sim date
    payload: v.any(),
    recordedAt: v.number(),
  })
    .index("by_run_external", ["runId", "externalId"])
    .index("by_run_type", ["runId", "type", "occurredOn"]),

  tasks: defineTable({
    runId: v.string(),
    type: v.string(), // e.g. "ap.process_document"
    role: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("leased"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("waiting"), // waiting on an ask or another task
    ),
    priority: v.number(),
    payload: v.any(),
    idempotencyKey: v.string(),
    createdBy: v.string(),
    parentTaskId: v.optional(v.id("tasks")),
    leaseOwner: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    attempts: v.number(),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    notBefore: v.optional(v.number()),
  })
    .index("by_run_role_status", ["runId", "role", "status", "priority"])
    .index("by_run_key", ["runId", "idempotencyKey"])
    .index("by_run_status", ["runId", "status"]),

  bills: defineTable({
    runId: v.string(),
    vendor: v.string(),
    invoiceNumber: v.string(),
    invoiceDate: v.string(),
    dueDate: v.string(),
    store: v.optional(v.string()),
    deliveryId: v.optional(v.string()),
    totalCents: v.number(),
    lines: v.array(
      v.object({
        sku: v.optional(v.string()),
        description: v.string(),
        quantity: v.number(),
        unitCents: v.number(),
        amountCents: v.number(),
      }),
    ),
    documentEventId: v.string(),
    status: v.union(
      v.literal("approved"),
      v.literal("held"),
      v.literal("rejected"),
      v.literal("paid"),
    ),
    decisionPath: v.optional(v.string()),
    exceptions: v.array(v.string()),
    createdBy: v.string(),
    entryId: v.optional(v.id("journalEntries")),
    paymentIntentId: v.optional(v.id("paymentIntents")),
  })
    .index("by_run_vendor_invoice", ["runId", "vendor", "invoiceNumber"])
    .index("by_run_status", ["runId", "status"]),

  paymentIntents: defineTable({
    runId: v.string(),
    payee: v.string(), // vendor id or employee batch id
    amountCents: v.number(),
    method: v.string(), // "ach" | "wire"
    remitTo: v.object({ bank: v.string(), accountLast4: v.string(), memorySha: v.string() }),
    billIds: v.array(v.id("bills")),
    dueDate: v.string(),
    requestedBy: v.string(),
    approvals: v.array(v.object({ seatId: v.string(), at: v.number(), kind: v.string() })),
    requiredApprovals: v.number(),
    requiresHuman: v.boolean(),
    status: v.union(
      v.literal("pending_approval"),
      v.literal("approved"),
      v.literal("submitted"),
      v.literal("settled"),
      v.literal("voided"),
    ),
    bankRef: v.optional(v.string()),
    idempotencyKey: v.string(),
    createdAt: v.number(),
    voidReason: v.optional(v.string()),
  })
    .index("by_run_status", ["runId", "status"])
    .index("by_run_key", ["runId", "idempotencyKey"]),

  asks: defineTable({
    runId: v.string(),
    from: v.string(), // seat id
    to: v.string(), // seat id or role, e.g. "human_cfo"
    severity: v.union(v.literal("info"), v.literal("decision"), v.literal("urgent")),
    title: v.string(),
    body: v.string(),
    evidence: v.array(v.object({ label: v.string(), ref: v.string() })),
    options: v.array(v.object({ id: v.string(), label: v.string() })),
    status: v.union(v.literal("open"), v.literal("answered"), v.literal("withdrawn")),
    answer: v.optional(v.object({ optionId: v.string(), note: v.optional(v.string()), by: v.string(), at: v.number() })),
    taskId: v.optional(v.id("tasks")),
    proposalBranch: v.optional(v.string()),
    paymentIntentId: v.optional(v.id("paymentIntents")),
    createdAt: v.number(),
  })
    .index("by_run_status", ["runId", "status"])
    .index("by_run_to", ["runId", "to", "status"]),

  memoryCommits: defineTable({
    runId: v.string(),
    sha: v.string(),
    branch: v.string(),
    author: v.string(),
    message: v.string(),
    paths: v.array(v.string()),
    trailers: v.any(),
    at: v.number(),
  })
    .index("by_run_at", ["runId", "at"])
    .index("by_run_sha", ["runId", "sha"]),

  agentRuns: defineTable({
    runId: v.string(),
    seatId: v.string(),
    taskId: v.optional(v.id("tasks")),
    kind: v.string(), // "deterministic" | "llm"
    model: v.optional(v.string()),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.number(),
    costMicros: v.number(), // millionths of a dollar
    latencyMs: v.number(),
    toolCalls: v.number(),
    outcome: v.string(),
    summary: v.optional(v.string()),
    at: v.number(),
  }).index("by_run_at", ["runId", "at"]),

  activity: defineTable({
    runId: v.string(),
    seatId: v.string(),
    kind: v.string(), // "posted", "held", "asked", "spawned", "committed", "approved", "blocked", ...
    text: v.string(),
    refs: v.optional(v.any()),
    at: v.number(),
  }).index("by_run_at", ["runId", "at"]),

  violations: defineTable({
    runId: v.string(),
    seatId: v.string(),
    operation: v.string(),
    reason: v.string(),
    sourceDocumentId: v.optional(v.string()),
    relatedBillId: v.optional(v.id("bills")),
    at: v.number(),
  }).index("by_run_at", ["runId", "at"]),

  goals: defineTable({
    runId: v.string(),
    text: v.string(),
    metric: v.optional(v.string()),
    target: v.optional(v.number()),
    setBy: v.string(),
    status: v.union(v.literal("active"), v.literal("met"), v.literal("dropped")),
    createdAt: v.number(),
  }).index("by_run", ["runId"]),
});
