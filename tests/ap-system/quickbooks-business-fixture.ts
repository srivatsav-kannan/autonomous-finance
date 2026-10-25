import type { BankScope } from "../../src/integrations/contracts";
import { makeFunctionReference } from "convex/server";
import { createHash } from "node:crypto";
import {
  businessFixture,
  br,
  binding,
  syncPrimary,
  acceptance,
  policy,
} from "./business-fixture";
import { packet } from "./accounting-fixture";
import { canonical, sha256Hex } from "../../convex/lib/kernel";
import {
  buildIncreaseRequestBody,
  commandRequestHash,
} from "../../src/integrations/contracts";
import type { Id } from "../../convex/_generated/dataModel";
import type {
  AccountingExport,
  Operation,
  Plan,
} from "../../src/ap-system/quickbooks/types";
export const current = makeFunctionReference<"query">(
  "apAccountingExport:current",
);
export const successful = (plan: Plan, id: string): Operation => ({
  ...plan,
  requestId: "test-operation",
  payloadHash: "test-hash",
  state: "succeeded",
  createdAt: 1,
  updatedAt: 1,
  attempts: 1,
  externalId: id,
  syncToken: "0",
  lastError: null,
  responseHash: "test-response",
});
export async function creditFixture(
  discountCents = 0,
  dimensions?: {
    department: string | null;
    scope: "cost_allocations" | "cost_and_settlement";
  },
) {
  const originalInput = packet();
  const originalCandidate = originalInput.candidate!;
  if (dimensions)
    originalCandidate.lines[0]!.allocations[0]!.department =
      dimensions.department;
  originalCandidate.discountCents = discountCents;
  originalCandidate.discountAllocations = discountCents
    ? [
        {
          ...originalCandidate.lines[0]!.allocations[0]!,
          account: "5100",
          amountCents: discountCents,
        },
      ]
    : [];
  originalCandidate.totalCents -= discountCents;
  syncPrimary(originalInput);
  const configuredPolicy = policy();
  if (dimensions)
    configuredPolicy.dimensions = {
      version: "ap-gl-dimensions-v1",
      scope: dimensions.scope,
      departments: dimensions.department ? [dimensions.department] : [],
      projects: [],
      ...(dimensions.scope === "cost_and_settlement"
        ? { settlementDepartment: "homogeneous_approved_department" }
        : {}),
    };
  configuredPolicy.accounts.push({ account: "5100", treatment: "expense" });
  const f = await businessFixture({
    input: originalInput,
    policy: configuredPolicy,
  });
  const accepted = acceptance(originalInput);
  accepted.discountCents = discountCents;
  accepted.discountAllocations = originalCandidate.discountAllocations;
  const original = await f.recognize(f.detail, accepted);
  async function credit(number = "CREDIT-1") {
    const input = packet(number);
    const c = input.candidate!;
    c.kind = "credit_note";
    c.lines[0]!.quantity.decimal = "1";
    c.lines[0]!.amountCents = 3850;
    c.lines[0]!.allocations[0]!.amountCents = 3850;
    c.subtotalCents = 3850;
    c.discountCents = discountCents / 2;
    c.discountAllocations = c.discountCents
      ? [
          {
            ...c.lines[0]!.allocations[0]!,
            account: "5100",
            amountCents: c.discountCents,
          },
        ]
      : [];
    c.totalCents = 3850 - c.discountCents;
    input.documents[0]!.kind = "credit_note";
    // This is a distinct, explicitly synthetic return original, not the invoice's receiving record.
    const returned = input.documents[2]!;
    const body = `Synthetic return ${number}: receiving-owner accepted returned KALE-24 1 case on 2026-10-19`;
    returned.sourceId = `return-${number}`;
    returned.name = `${returned.sourceId}.pdf`;
    returned.deliveryId = `delivery-${returned.sourceId}`;
    returned.originalRef = `/private/ap/${returned.name}`;
    returned.provenance.originalFilename = returned.name;
    returned.extractedText = body;
    returned.originalBase64 = Buffer.from(body).toString("base64");
    returned.byteLength = Buffer.byteLength(body);
    returned.sha256 = createHash("sha256").update(body).digest("hex");
    input.purchasingEvidence[1]!.source = binding(returned);
    input.purchasingEvidence[1]!.lines[0]!.quantity.decimal = "1";
    syncPrimary(input);
    const d = await f.reviewed(input);
    const proposed = await f.t.mutation(br.propose!, {
      ...f.ap,
      input: {
        caseId: d.caseId,
        expectedRevision: d.revision,
        snapshotHash: d.snapshotHash,
        idempotencyKey: `approve-${number}`,
        policyVersion: f.policy.version,
        supplierRevision: 1,
        credit: {
          originalCaseId: f.detail.caseId,
          originalApprovalId: original.proposal.proposalId,
          freightCents: 0,
          discountCents: c.discountCents,
          lines: [
            {
              creditLineId: "line-1",
              originalLineId: "line-1",
              basis: "quantity_return",
              quantity: "1",
              netCents: 3850,
              taxCents: 0,
              returnEvidence: [binding(input.documents[2]!)],
            },
          ],
          reason: "Supported original return",
        },
      },
    });
    const result = await f.vote(proposed);
    return { caseId: d.caseId, creditId: result.creditId as Id<"demoCredits"> };
  }
  const load = (caseId = f.detail.caseId, extra: Record<string, string> = {}) =>
    f.humans.finance!.query(current, {
      scope: f.scope,
      caseId,
      ...extra,
    }) as Promise<AccountingExport>;
  return { ...f, original, credit, load };
}
/** Test-only conversion; never reads provider credentials or contacts Increase. */
export async function promoteIncrease(
  f: Pick<
    Awaited<ReturnType<typeof creditFixture>>,
    "t" | "humans" | "detail" | "original" | "policy"
  > & {
    scope: BankScope;
  },
) {
  const scope = {
    ...f.scope,
    provider: "increase" as const,
    environment: "sandbox" as const,
  };
  await f.t.run(async (ctx) => {
    for (const table of [
      "demoConfigs",
      "apCaseRecords",
      "apCaseRevisions",
      "apCaseSources",
      "apCaseDeliveries",
      "apCaseDecisions",
      "apCaseOperations",
      "demoBills",
      "demoCredits",
      "apBusinessPolicies",
      "apSupplierContacts",
      "apSuppliers",
      "apSupplierRevisions",
      "apApprovalProposals",
      "apCreditLinks",
      "apCreditApplications",
    ] as const) {
      for (const row of await ctx.db.query(table).collect())
        await ctx.db.patch(row._id, { scope });
    }
    for (const row of await ctx.db.query("apCaseRecords").collect())
      await ctx.db.patch(row._id, { identityMode: "authenticated_human" });
  });
  return {
    scope,
    load: (caseId = f.detail.caseId, extra: Record<string, string> = {}) =>
      f.humans.finance!.query(current, {
        scope,
        caseId,
        ...extra,
      }) as Promise<AccountingExport>,
  };
}
/** Synthetic immutable bank evidence, introduced only through test-owned Convex DB. */
export async function seedSettled(
  f: Pick<
    Awaited<ReturnType<typeof creditFixture>>,
    "t" | "humans" | "detail" | "original" | "policy"
  > & {
    scope: BankScope;
  },
  cash: number,
  gross: number,
  credits: Array<{ creditId: Id<"demoCredits">; amountCents: number }> = [],
  suffix = "",
) {
  const { scope } = await promoteIncrease(f);
  const result = await f.t.run(async (ctx) => {
    const bill = (await ctx.db.get(f.original.billId as Id<"demoBills">))!;
    const snapshot = {
      scope,
      bills: [{ billId: bill._id, version: bill.version, amountCents: gross }],
      credits,
      amountCents: cash,
      currency: "USD" as const,
      destination: {
        externalAccountId: "external-supplier-v1",
        version: "golden-state-produce:r1",
      },
      policyVersion: f.policy.version,
    };
    const snapshotHash = await sha256Hex(canonical(snapshot));
    const versionId = await ctx.db.insert("demoVersions", {
      scope,
      snapshot,
      snapshotHash,
      requestedBy: "payments",
      requestKey: `cash-${cash}${suffix}`,
      status: "settled",
      approvals: [
        {
          seatId: "human-finance",
          subject: "https://ap-demo.invalid|finance",
          kind: "human",
          snapshotHash,
          at: 1,
        },
      ],
      reservations: "consumed",
      createdAt: 1,
    });
    const command = {
      commandId: versionId,
      scope,
      amountCents: cash,
      currency: "USD" as const,
      destination: snapshot.destination,
      approvalVersion: versionId,
      idempotencyKey: `demo:${versionId}`,
      providerRequest: buildIncreaseRequestBody({
        commandId: versionId,
        scope,
        amountCents: cash,
        destination: snapshot.destination,
      }),
      requestHash: "",
    };
    command.requestHash = await commandRequestHash(command);
    const commandId = await ctx.db.insert("demoCommands", {
      scope,
      command,
      versionId,
      execution: "settled",
      posting: "posted",
      reconciliation: "matched",
      generation: 1,
      attemptCount: 1,
      nextAttemptAt: 0,
      firstAttemptAt: 1,
      providerTransferId: `transfer-business${suffix}`,
      createdAt: 1,
    });
    await ctx.db.insert("demoObservations", {
      scope,
      transferId: `transfer-business${suffix}`,
      observation: {
        id: `transfer-business${suffix}`,
        scope,
        commandId: versionId,
        requestHash: command.requestHash,
        idempotencyKey: command.idempotencyKey,
        amountCents: cash,
        currency: "USD",
        destination: command.destination,
        status: "settled",
        createdAt: "2026-10-19T12:00:00Z",
        updatedAt: "2026-10-19T12:00:00Z",
        originalTransactionId: `tx-business${suffix}`,
      },
      importedAt: 1,
    });
    const key = `${scope.organizationId}:${scope.runId}:${scope.provider}:${scope.environment}:${scope.accountId}:tx-business${suffix}:debit`;
    const old = (await ctx.db.get(bill.entryId!))!;
    const { _id, _creationTime, ...base } = old;
    const entryId = await ctx.db.insert("journalEntries", {
      ...base,
      source: { kind: "payment_settlement", ref: key },
      sequence: 99,
      idempotencyKey: key,
      lines: [
        { account: "2000", debit: cash, credit: 0 },
        { account: "1000", debit: 0, credit: cash },
      ],
      hash: "b".repeat(64),
    });
    await ctx.db.insert("demoTransactions", {
      scope,
      commandRowId: commandId,
      entryId,
      state: "posted",
      transaction: {
        id: `tx-business${suffix}`,
        scope,
        transferId: `transfer-business${suffix}`,
        commandId: versionId,
        amountCents: -cash,
        currency: "USD",
        status: "posted",
        purpose: "debit",
        createdAt: "2026-10-19T12:00:00Z",
        postedAt: "2026-10-19T12:00:00Z",
      },
      importedAt: 1,
      matchedAt: 1,
    });
    await ctx.db.patch(bill._id, {
      paidCents: gross,
      status: gross === bill.approvedCents ? "paid" : "approved",
    });
    for (const c of credits)
      await ctx.db.patch(c.creditId, { consumedCents: c.amountCents });
    return { versionId, commandId, entryId };
  });
  return {
    ...result,
    scope,
    load: (caseId = f.detail.caseId, extra: Record<string, string> = {}) =>
      f.humans.finance!.query(current, {
        scope,
        caseId,
        ...extra,
      }) as Promise<AccountingExport>,
  };
}
