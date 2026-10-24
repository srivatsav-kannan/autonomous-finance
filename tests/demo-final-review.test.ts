import { afterEach, describe, expect, it, vi } from "vitest";
import { api, demoFixture } from "./demo-fixture";
import { openFakeBank } from "../src/integrations/banking/fake";
import { PaymentDispatcher } from "../src/payments/dispatcher";
import { EvidenceWorker, type KernelTransport } from "../src/payments/evidence";

const openBanks: ReturnType<typeof openFakeBank>[]=[];
afterEach(()=>{for(const bank of openBanks.splice(0))bank.close();vi.unstubAllEnvs();});
async function settled() {
  const f=await demoFixture();const q=await f.queued();
  const bank=openFakeBank({path:":memory:",scope:f.scope,seed:39,startTime:"2026-10-23T12:00:00.000Z"});openBanks.push(bank);
  await new PaymentDispatcher(f.t as KernelTransport,f.scope,f.dispatcherToken,bank.provider,"final-review").tick();
  const transfer=bank.harness.inspect().transfers[0]!;bank.harness.settle(transfer.id);
  const worker=new EvidenceWorker(f.t as KernelTransport,f.scope,f.evidenceToken,bank.provider);
  expect(await worker.tick()).toEqual({posted:1,errors:[]});
  return {...f,q,bank,worker,transfer};
}

describe("final authority, close and return review",()=>{
  it("late AP exception on a paid invoice blocks clean close",async()=>{
    const f=await settled();
    expect((await f.human.query(api.demoEvidence.humanView,{scope:f.scope})).blockers).toEqual([]);
    await f.t.mutation(api.demoPayments.flagException,{...f.ap,billId:f.q.billId,reason:"late damaged-goods evidence"});
    expect((await f.human.query(api.demoEvidence.humanView,{scope:f.scope})).blockers).toContainEqual({kind:"bill",id:f.q.billId,reason:"late damaged-goods evidence"});
    await expect(f.t.mutation(api.demoEvidence.signClose,{...f.controller,period:"2026-10"})).rejects.toThrow("late damaged-goods");
    expect((await f.t.run(ctx=>ctx.db.query("periods").first()))!.status).toBe("open");
  });

  it("role-specific evidence queries reveal only authorized views",async()=>{
    const f=await settled();
    for(const role of ["ap_clerk","payments","treasury","fpa","integrations_engineer"]) {
      const view=await f.t.query(api.demoEvidence.view,f.auth(role));
      expect(view).not.toHaveProperty("transactions");
      expect(JSON.stringify(view)).not.toContain(f.q.commandId);
      expect(JSON.stringify(view)).not.toContain('"amountCents"');
      expect(JSON.stringify(view)).not.toContain('"scope"');
    }
    for(const role of ["controller","cfo_agent","auditor","cash_application"]) {
      const view=await f.t.query(api.demoEvidence.view,f.auth(role));
      expect(view.transactions).toHaveLength(1);
    }
    await expect(f.t.query(api.demoEvidence.view,{...f.auth("auditor"),scope:{...f.scope,accountId:"other"}})).rejects.toThrow("mismatch");
    for(const role of ["ap_clerk","payments","treasury","fpa","integrations_engineer","auditor","cash_application"]) {
      await expect(f.t.mutation(api.demoEvidence.proposeMatch,{...f.auth(role),transactionId:f.bank.harness.inspect().transfers[0]!.originalTransactionId!,commandId:f.q.versionId,note:"proposal"})).rejects.toThrow("Forbidden");
    }
  });

  it("unpaid bills and pending payment approval block close without recording a signature",async()=>{
    const f=await demoFixture();const billId=await f.bill();
    await f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:"awaiting",billIds:[billId],credits:[]});
    await expect(f.human.mutation(api.demoEvidence.signClose,{scope:f.scope,period:"2026-10"})).rejects.toThrow("AP close blocked");
    expect((await f.t.run(ctx=>ctx.db.query("periods").first()))!.closedBy).toBeUndefined();
    expect(await f.t.run(ctx=>ctx.db.query("demoCommands").collect())).toHaveLength(0);
  });

  it("request reservation prevents a second outstanding approval for the same invoice",async()=>{
    const f=await demoFixture();const billId=await f.bill();
    const one=await f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:"first",billIds:[billId],credits:[]});
    await expect(f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:"second",billIds:[billId],credits:[]})).rejects.toThrow("not available for payment");
    expect(await f.t.run(ctx=>ctx.db.query("demoVersions").collect())).toHaveLength(1);
    expect(await f.t.run(ctx=>ctx.db.get(billId))).toMatchObject({reservedVersionId:one.versionId});
    expect((await f.human.query(api.demoEvidence.humanView,{scope:f.scope})).blockers.some(b=>b.id===one.versionId)).toBe(true);
    await expect(f.human.mutation(api.demoEvidence.signClose,{scope:f.scope,period:"2026-10"})).rejects.toThrow("AP close blocked");
  });

  it("return after close retains verified evidence and blocks posting without another transfer",async()=>{
    const f=await settled();
    expect(await f.t.mutation(api.demoEvidence.signClose,{...f.controller,period:"2026-10"})).toEqual({status:"open"});
    expect(await f.human.mutation(api.demoEvidence.signClose,{scope:f.scope,period:"2026-10"})).toEqual({status:"closed"});
    f.bank.harness.returnTransfer(f.transfer.id);
    const result=await f.worker.tick();expect(result.posted).toBe(0);expect(result.errors.some(e=>e.includes("closed"))).toBe(true);
    const evidence=await f.human.query(api.demoEvidence.humanView,{scope:f.scope});
    expect(evidence.transactions).toHaveLength(2);
    const returned=evidence.transactions.find((t:any)=>t.transaction.purpose==="return");expect(returned).toMatchObject({state:"exception"});expect(returned!.entryId).toBeUndefined();expect(returned!.error).toContain("period_closed");
    expect(evidence.blockers.some((b:any)=>b.id===returned!.transaction.id)).toBe(true);
    const command=await f.t.run(ctx=>ctx.db.get(f.q.commandId));expect(command).toMatchObject({execution:"returned",posting:"posted",reconciliation:"unmatched"});
    expect(await f.t.run(ctx=>ctx.db.query("journalEntries").collect())).toHaveLength(2);
    expect(f.bank.harness.inspect().transfers).toHaveLength(1);expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
    expect(await new PaymentDispatcher(f.t as KernelTransport,f.scope,f.dispatcherToken,f.bank.provider,"never-resubmit").tick()).toEqual({dispatched:false});
    expect((await f.worker.tick()).posted).toBe(0);
    expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
  });
});
