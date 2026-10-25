import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import * as ap from "../../convex/ap";
import * as asks from "../../convex/asks";
import * as ledger from "../../convex/ledger";
import * as payments from "../../convex/payments";
import * as seats from "../../convex/seats";
import * as tasks from "../../convex/tasks";
import { sha256Hex } from "../../convex/lib/kernel";
import { SeatClient } from "../../src/core/kernel-client";
import type { Role } from "../../src/core/roles";
import { kernelHarness } from "./kernelHarness";

const MODULES: Record<string, Record<string, unknown>> = { ap, asks, ledger, payments, seats, tasks };

/**
 * A ConvexHttpClient stand-in that runs the real legacy kernel handlers against the
 * harness DB, so seat runtimes and the human gateway can be exercised end to end.
 */
export function legacyKernel() {
  const h = kernelHarness();
  const runId = "regression-run";
  const call = async (ref: unknown, args: Record<string, unknown>) => {
    const [module, name] = getFunctionName(ref as never).split(":") as [string, string];
    const fn = MODULES[module]?.[name] as { _handler?: (ctx: unknown, args: unknown) => unknown } | undefined;
    if (!fn?._handler) throw new Error(`legacyKernel: ${module}:${name} is not wired`);
    return structuredClone(await fn._handler(h.ctx, args));
  };
  const client = { query: call, mutation: call } as unknown as ConvexHttpClient;
  return {
    h,
    runId,
    client,
    async init(policy?: Record<string, number>) {
      await h.ctx.db.insert("runs", { runId, label: "Regression", company: "test", simDate: "2026-01-02", status: "active", createdAt: 0, config: policy ? { policy } : undefined });
      await h.ctx.db.insert("periods", { runId, period: "2026-01", status: "open" });
    },
    /** Add a seat and return its authenticated client. */
    async seat(seatId: string, role: Role, kind: "agent" | "human" = "agent") {
      const token = `${seatId}-token`;
      await h.ctx.db.insert("seats", { runId, seatId, role, name: seatId, kind, capabilities: {}, status: "active", tokenHash: await sha256Hex(token), createdAt: 0 });
      return new SeatClient(runId, seatId, token, client);
    },
  };
}
