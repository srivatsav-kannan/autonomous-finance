import { query } from "./_generated/server";
import { ConvexError } from "convex/values";

/** Identity discovery only. It never creates a seat, role, run, or owner binding. */
export const whoami = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ code: "authentication_required", reason: "Sign in to identify your account." });
    return { tokenIdentifier: identity.tokenIdentifier, issuer: identity.issuer, subject: identity.subject };
  },
});

// Agent-backed intake/proposal routes also require the current scoped human binding.
// This query grants no seats and cannot enroll the first signed-in user.
import { scopeValidator } from "./demoSchema";
import { requirePaymentHuman } from "./lib/demoAuth";
export const workspaceAccess = query({
 args: { scope: scopeValidator },
 handler: async (ctx, args) => { await requirePaymentHuman(ctx, args.scope); return { authorized: true }; },
});
