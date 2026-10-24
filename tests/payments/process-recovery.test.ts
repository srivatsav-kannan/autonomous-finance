import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../demo-fixture";
import { PAYMENT_EXECUTOR_VERSION, type BankCommand } from "../../src/payments/contracts";
import { EvidenceWorker, type KernelTransport } from "../../src/payments/evidence";
import { recoveryFixture } from "./fixtures";
import { paymentKernelBridge, runPaymentChild } from "./process-fixture";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("actual dispatcher process restart with durable bank and in-memory kernel bridge", () => {
  it.each(["before-send", "after-send"] as const)("recovers death %s with lookup before any resend and one cash posting", async crash => {
    const f = await recoveryFixture(crash === "after-send" ? [{ operation: "createTransfer", call: 1, kind: "accept_then_lost_response" }] : []);
    const bridge = await paymentKernelBridge(f.t as KernelTransport);
    try {
      const q = await f.queued();
      const original = (await f.t.run(ctx => ctx.db.get(q.commandId)))!.command;
      const tracePath = join(f.directory, "calls.jsonl"), configPath = join(f.directory, "worker.json");
      writeFileSync(configPath, JSON.stringify({ url: bridge.url, bridgeToken: bridge.token, scope: f.scope,
        token: f.dispatcherToken, bankPath: f.bankPath, tracePath, seed: f.seed }), { mode: 0o600 });
      expect((await runPaymentChild(configPath, crash)).code).toBe(86);
      const first = (await f.t.run(ctx => ctx.db.get(q.commandId)))!;
      expect(first).toMatchObject({ execution: "in_flight", attemptCount: 1, posting: "unposted" });
      expect(first.command).toEqual(original);
      expect(f.bank.harness.inspect().transfers).toHaveLength(crash === "before-send" ? 0 : 1);
      expect((await f.state()).journals.filter(entry => entry.lines.some(line => line.account === "1000"))).toEqual([]);
      // Only the parent kernel clock advances. This is not a backend restart:
      // the real persistent Convex proof lives in ci:recovery.
      vi.spyOn(Date, "now").mockReturnValue(first.leaseExpiresAt! + 1);
      f.restartBank();
      expect((await runPaymentChild(configPath, "none")).code).toBe(0);
      const trace = readFileSync(tracePath, "utf8").trim().split("\n").map(line => JSON.parse(line) as { operation: string; command: BankCommand });
      expect(trace.map(call => call.operation)).toEqual(crash === "before-send" ? ["submit-enter", "lookup", "submit-enter"] : ["submit-enter", "lookup"]);
      for (const call of trace) {
        expect(call.command).toEqual(original);
        expect(call.command.providerRequest).toBe(original.providerRequest);
      }
      const bank = f.bank.harness.inspect();
      expect(bank.transfers).toHaveLength(1);
      expect(bank.calls.createTransfer).toBe(1);
      expect(bank.calls.lookupTransfer).toBe(1);
      const resumed = (await f.t.run(ctx => ctx.db.get(q.commandId)))!;
      expect(resumed).toMatchObject({ command: original, generation: first.generation + 1, attemptCount: 2, firstAttemptAt: first.firstAttemptAt, execution: "pending", posting: "unposted" });
      await expect(f.t.mutation(api.demoPayments.complete, { scope: f.scope, token: f.dispatcherToken,
        paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
        commandId: q.commandId, generation: first.generation, leaseToken: first.leaseToken!, providerTransferId: bank.transfers[0]!.id })).rejects.toThrow(/stale/i);
      expect(await f.t.run(ctx => ctx.db.get(q.billId))).toMatchObject({ paidCents: 0, reservedVersionId: q.versionId });
      f.bank.harness.settle(bank.transfers[0]!.id);
      f.bank.harness.drainNotifications({ drop: true });
      const evidence = new EvidenceWorker(f.t as KernelTransport, f.scope, f.evidenceToken, f.provider);
      expect(await evidence.tick()).toEqual({ posted: 1, errors: [] });
      expect(await evidence.tick()).toEqual({ posted: 0, errors: [] });
      const settled = await f.state();
      expect(settled.journals.filter(entry => entry.lines.some(line => line.account === "1000"))).toHaveLength(1);
      expect(settled.commands[0]).toMatchObject({ execution: "settled", posting: "posted", reconciliation: "matched" });
      expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
    } finally {
      await bridge.close(); f.dispose();
    }
  }, 25_000);
});
