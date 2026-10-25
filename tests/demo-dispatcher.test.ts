import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getFunctionName } from "convex/server";
import { demoFixture } from "./demo-fixture";
import { PaymentDispatcher } from "../src/payments/dispatcher";
import { openFakeBank } from "../src/integrations/banking/fake";
import type { KernelTransport } from "../src/payments/evidence";

const paths: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const path of paths.splice(0)) rmSync(path,{recursive:true,force:true}); });
const bankPath = () => { const path = mkdtempSync(join(tmpdir(),"ap-dispatch-"));paths.push(path);return join(path,"bank.sqlite"); };

describe("real dispatcher recovery against independent durable FakeBank", () => {
  it("concurrent dispatchers submit once, and operating capability has no simulator or credentials", async () => {
    const f=await demoFixture();await f.queued();const bank=openFakeBank({path:bankPath(),scope:f.scope,seed:39});
    try {
      expect(Object.keys(bank.provider).sort()).toEqual(["createTransfer","getBalance","getTransfer","getTransaction","listTransactions","lookupTransfer","recovery","scanForPossibleSend"].sort());
      expect("harness" in bank.provider).toBe(false);expect("settle" in bank.provider).toBe(false);expect("secret" in bank.provider).toBe(false);
      const results=await Promise.all(["one","two"].map(worker=>new PaymentDispatcher(f.t as KernelTransport,f.scope,f.dispatcherToken,bank.provider,worker).tick()));
      expect(results.filter(r=>r.dispatched)).toHaveLength(1);
      expect(bank.harness.inspect().transfers).toHaveLength(1);expect(bank.harness.inspect().calls.createTransfer).toBe(1);
      expect(await f.t.run(ctx=>ctx.db.query("demoCommands").collect())).toEqual([expect.objectContaining({execution:"pending",attemptCount:1,posting:"unposted"})]);
    } finally {bank.close();}
  });

  it("recovers lost acceptance response after both worker and bank handle restart with exactly original bytes/key", async () => {
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    const f=await demoFixture();const q=await f.queued();const path=bankPath();
    let bank=openFakeBank({path,scope:f.scope,seed:39,faults:[{operation:"createTransfer",call:1,kind:"accept_then_lost_response"}]});
    try {
      expect(await new PaymentDispatcher(f.t as KernelTransport,f.scope,f.dispatcherToken,bank.provider,"worker").tick()).toMatchObject({error:"transport"});
      const before=await f.t.run(ctx=>ctx.db.get(q.commandId));expect(before!.execution).toBe("unknown");expect(before!.providerTransferId).toBeUndefined();
      expect(bank.harness.inspect().transfers).toHaveLength(1);
      bank.close();bank=openFakeBank({path,scope:f.scope,seed:39});
      vi.setSystemTime(before!.nextAttemptAt+1);
      const restarted=new PaymentDispatcher(f.t as KernelTransport,f.scope,f.dispatcherToken,bank.provider,"worker");
      expect(await restarted.tick()).toMatchObject({dispatched:true,providerTransferId:bank.harness.inspect().transfers[0]!.id});
      const after=await f.t.run(ctx=>ctx.db.get(q.commandId));expect(after!.command).toEqual(before!.command);expect(after!.attemptCount).toBe(2);expect(after!.posting).toBe("unposted");
      expect(bank.harness.inspect().transfers).toHaveLength(1);expect(bank.harness.inspect().calls.createTransfer).toBe(1);expect(bank.harness.inspect().calls.lookupTransfer).toBe(1);
    } finally {bank.close();}
  });

  it("recovers a crash after bank acceptance before both local result writes", async () => {
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    const f=await demoFixture();const q=await f.queued();const bank=openFakeBank({path:bankPath(),scope:f.scope,seed:39});
    try {
      const disconnected:KernelTransport={query:(ref,args)=>(f.t as KernelTransport).query(ref,args),mutation:(ref,args)=>{
        if(["demoPayments:complete","demoPayments:fail"].includes(getFunctionName(ref)))return Promise.reject(new Error("worker terminated before persisting result"));
        return (f.t as KernelTransport).mutation(ref,args);
      }};
      expect(await new PaymentDispatcher(disconnected,f.scope,f.dispatcherToken,bank.provider,"same-seat").tick()).toMatchObject({stale:true});
      const before=await f.t.run(ctx=>ctx.db.get(q.commandId));expect(before!.execution).toBe("in_flight");expect(before!.providerTransferId).toBeUndefined();expect(bank.harness.inspect().transfers).toHaveLength(1);
      vi.setSystemTime(before!.leaseExpiresAt!+1);
      expect(await new PaymentDispatcher(f.t as KernelTransport,f.scope,f.dispatcherToken,bank.provider,"same-seat").tick()).toMatchObject({dispatched:true});
      const after=await f.t.run(ctx=>ctx.db.get(q.commandId));expect(after!.generation).toBe(before!.generation+1);expect(after!.command).toEqual(before!.command);expect(bank.harness.inspect().transfers).toHaveLength(1);
      expect(await f.t.run(ctx=>ctx.db.query("journalEntries").collect())).toHaveLength(1); // Accrual only: a transfer response cannot post cash.
    } finally {bank.close();}
  });
});
