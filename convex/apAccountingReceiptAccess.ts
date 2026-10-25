import { query } from "./_generated/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import { requirePaymentHuman, assertRowScope } from "./lib/demoAuth";
import { canonical, sha256Hex } from "./lib/kernel";
import {
  closeExportRequestSchema,
  closeActionSchema,
} from "../src/ap-system/close-contracts";
import { assertAccountingJournalHash } from "./lib/apSystem/paymentAccountingBinding";
import type { CloseReceiptAccess } from "../src/ap-system/quickbooks/close-receipt-types";
/** Read an existing tax-posting receipt after policy retirement. This query cannot authorize new accounting. */
export const tax = query({
  args: { scope: scopeValidator, input: v.any() },
  handler: async (ctx, args): Promise<CloseReceiptAccess | null> => {
    const { subject } = await requirePaymentHuman(ctx, args.scope);
    const request = closeExportRequestSchema.parse(args.input);
    if (!request.actionId) throw Error("tax_receipt_action_required");
    const id = ctx.db.normalizeId("apCloseActions", request.actionId);
    const action = id ? await ctx.db.get(id) : null;
    assertRowScope(action, args.scope);
    if (action && action.kind !== "tax_adjustment") return null;
    if (
      !action ||
      action.kind !== "tax_adjustment" ||
      action.status !== "approved" ||
      !action.entryId ||
      !action.completedAt
    )
      throw Error("approved_tax_receipt_required");
    const payload = closeActionSchema.parse(action.payload);
    if (payload.kind !== "tax_adjustment")
      throw Error("tax_receipt_action_required");
    const approvalHash = await sha256Hex(
      canonical({
        action: action.payload,
        policyHash: action.policyHash,
        contextHash: action.contextHash,
        amountCents: action.amountCents,
        route: action.route,
      }),
    );
    if (approvalHash !== action.hash)
      throw Error("tax_receipt_approval_changed");
    const journal = await ctx.db.get(action.entryId);
    if (
      !journal ||
      journal.runId !== args.scope.runId ||
      journal.status !== "posted" ||
      journal.source.kind !== "ap_tax_adjustment" ||
      journal.source.ref !== payload.originalEntryId
    )
      throw Error("tax_receipt_journal_changed");
    await assertAccountingJournalHash(journal);
    return {
      authorizedSubject: subject,
      accessedAt: Date.now(),
      scope: args.scope,
      request,
      exportId: `tax_reclassification:${journal._id}`,
      approvalId: action._id,
      approvalHash,
      journalId: journal._id,
      journalHash: journal.hash,
    };
  },
});
