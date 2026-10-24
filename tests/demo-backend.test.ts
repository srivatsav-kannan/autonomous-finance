import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, demoFixture, paymentLeaseProof } from "./demo-fixture";
import { buildIncreaseRequestBody, commandRequestHash } from "../src/integrations/contracts";

import { PAYMENT_EXECUTOR_VERSION } from "../src/payments/contracts";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("AP backend authority and immutable approval", () => {
  it("enforces role, human JWT, organization/account and legacy boundaries", async () => {
    const f = await demoFixture();
    const billId = await f.bill();
    const p = await f.t.mutation(api.demoPayments.requestPayment, { ...f.payments, requestKey: "p1", billIds: [billId], credits: [] });
    for (const role of ["ap_clerk", "payments", "treasury", "fpa", "integrations_engineer", "auditor"]) {
      await expect(f.t.mutation(api.demoPayments.acceptBill, { ...f.auth(role), billId, approvedCents: 10_000 })).rejects.toThrow("Forbidden");
      await expect(f.t.mutation(api.demoPayments.approveWithinPolicy, { ...f.auth(role), ...p })).rejects.toThrow("Forbidden");
    }
    await expect(f.t.mutation(api.demoPayments.approveAndQueue, { scope: f.scope, ...p })).rejects.toThrow("authenticated human");
    await expect(f.t.withIdentity({ subject: "human", issuer: "https://evil.invalid", tokenIdentifier: "https://evil.invalid|human" }).mutation(api.demoPayments.approveAndQueue, { scope: f.scope, ...p })).rejects.toThrow("authenticated human");
    await expect(f.human.mutation(api.demoPayments.approveAndQueue, { scope: f.scope, ...p, snapshotHash: "different" })).rejects.toThrow("Stale");
    for (const scope of [{...f.scope, accountId:"other"},{...f.scope, organizationId:"other"},{...f.scope,runId:"other"}]) {
      await expect(f.t.query(api.demoPayments.view, { ...f.payments, scope })).rejects.toThrow("mismatch");
      await expect(f.human.query(api.demoPayments.humanReview, { scope })).rejects.toThrow("mismatch");
      await expect(f.t.mutation(api.demoPayments.claim, { scope, token: f.dispatcherToken, paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, workerId:"w",leaseToken:"unique-lease-token" })).rejects.toThrow("mismatch");
    }
    for (const endpoint of [api.ap.bills, api.payments.intents, api.observe.overview, api.ledger.entries, api.seats.list, api.asks.list, api.tasks.queueStats]) {
      await expect(f.t.query(endpoint, { runId:f.scope.runId })).rejects.toThrow("scoped demo APIs");
    }
    expect(await f.t.query(api.admin.runs, {})).toEqual([]);
    // Seed a valid historical ID to prove the legacy authority guard, not an ID validator, blocks settlement.
    const intentId = await f.t.run(ctx => ctx.db.insert("paymentIntents", {runId:f.scope.runId,payee:"vendor-1",amountCents:10000,method:"ach",remitTo:{bank:"fake",accountLast4:"1234",memorySha:"v1"},billIds:[],dueDate:"2026-10-23",requestedBy:"payments",approvals:[],requiredApprovals:1,requiresHuman:true,status:"submitted",idempotencyKey:"legacy",createdAt:Date.now()}));
    await expect(f.t.mutation(api.payments.settlePayment, { runId:f.scope.runId,seatId:"payments",token:"token-payments",intentId,bankRef:"fake",settledOn:"2026-10-23" })).rejects.toThrow("scoped demo APIs");
    await expect(f.t.mutation(api.ledger.postEntry, { runId:f.scope.runId,seatId:"controller",token:"token-controller",idempotencyKey:"forge",date:"2026-10-23",memo:"forged",source:{kind:"payment_settlement"},lines:[{account:"2000",debit:100,credit:0},{account:"1000",debit:0,credit:100}] })).rejects.toThrow("scoped demo APIs");
    await expect(f.t.mutation(api.demoPayments.claim, {scope:f.scope,token:"token-payments",workerId:"w",leaseToken:"unique-lease-token"})).rejects.toThrow("dispatcher credential");
    expect((await f.t.run(ctx => ctx.db.query("demoCommands").collect()))).toHaveLength(0);
  });

  it("rejects foreign account rows, self approval and wrong service capability", async () => {
    const f = await demoFixture(); const billId = await f.bill();
    const foreign = await f.t.run(async ctx => { const b = (await ctx.db.get(billId))!; const { _id: _, _creationTime: __, ...row } = b; return ctx.db.insert("demoBills", {...row,scope:{...f.scope,accountId:"foreign"},invoiceNumber:"foreign"}); });
    await expect(f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:"foreign",billIds:[foreign],credits:[]})).rejects.toThrow("outside account scope");
    const p = await f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:"self",billIds:[billId],credits:[]});
    // The public requester API cannot create this condition; verify the approval guard independently.
    await f.t.run(ctx => ctx.db.patch(p.versionId,{requestedBy:"human_cfo"}));
    await expect(f.human.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...p})).rejects.toThrow("Requester cannot approve");
    await expect(f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:f.evidenceToken,workerId:"w",leaseToken:"unique-lease-token"})).rejects.toThrow("dispatcher credential");
    await expect(f.t.mutation(api.demoEvidence.ingestNotice,{scope:f.scope,token:f.dispatcherToken,eventId:"e",transferId:"t",bodyHash:"0".repeat(64)})).rejects.toThrow("evidence credential");
    vi.stubEnv("AP_BANK_SCOPE",JSON.stringify({...f.scope,accountId:"another-configured-account"}));
    await expect(f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:"w",leaseToken:"unique-lease-token"})).rejects.toThrow("service account scope mismatch");
    expect(await f.t.run(ctx=>ctx.db.query("demoCommands").collect())).toHaveLength(0);
  });

  it("controller and CFO policy approval cannot replace independent human approval", async () => {
    const f = await demoFixture(); const billId = await f.bill();
    const p = await f.t.mutation(api.demoPayments.requestPayment, {...f.payments,requestKey:"p",billIds:[billId],credits:[]});
    await f.t.mutation(api.demoPayments.approveWithinPolicy, {...f.controller,...p});
    await f.t.mutation(api.demoPayments.approveWithinPolicy, {...f.auth("cfo_agent"),...p});
    expect(await f.t.mutation(api.demoPayments.claim, {scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:"w",leaseToken:"unique-lease-token"})).toBeNull();
    await f.human.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...p});
    expect((await f.t.run(ctx => ctx.db.query("demoCommands").collect()))).toHaveLength(1);
  });

  it("replays the original invoice after evidence is attached without losing attachments", async () => {
    const f = await demoFixture();const args={...f.ap,vendor:"vendor-1",invoiceNumber:"INV-100",invoiceDate:"2026-10-23",originalCents:1000,expenseAccount:"5000",evidence:["invoice.pdf"]};
    const first=await f.t.mutation(api.demoPayments.recordBill,args);
    await f.t.mutation(api.demoPayments.attachEvidence,{...f.ap,billId:first.billId,evidence:"receipt.pdf"});
    expect(await f.t.mutation(api.demoPayments.recordBill,args)).toMatchObject({billId:first.billId,replayed:true});
    expect((await f.t.run(ctx=>ctx.db.get(first.billId)))?.evidence).toEqual(["invoice.pdf","receipt.pdf"]);
    await expect(f.t.mutation(api.demoPayments.recordBill,{...args,originalCents:2000})).rejects.toThrow("idempotency conflict");
  });

  it("deduplicates requests and conflicts on reused key with changed immutable bill set", async () => {
    const f = await demoFixture();const a = await f.bill(), b = await f.bill();
    const args = {...f.payments,requestKey:"same",billIds:[a],credits:[]};
    const p = await f.t.mutation(api.demoPayments.requestPayment,args);
    expect(await f.t.mutation(api.demoPayments.requestPayment,args)).toEqual(p);
    await expect(f.t.mutation(api.demoPayments.requestPayment,{...args,billIds:[b]})).rejects.toThrow("idempotency conflict");
    await expect(f.t.mutation(api.demoPayments.requestPayment,{...args,requestKey:"double",billIds:[a,a]})).rejects.toThrow("Distinct");
    await f.t.mutation(api.demoPayments.flagException,{...f.ap,billId:a,reason:"amount disputed"});
    await expect(f.human.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...p})).rejects.toThrow("Stale payment approval");
    expect((await f.t.run(ctx=>ctx.db.get(a)))?.reservedVersionId).toBeUndefined();
  });

  it("persists exact Increase raw request bytes before dispatch and binds them into the hash", async () => {
    const f = await demoFixture("sandbox-test", {provider:"increase",environment:"sandbox"});const q=await f.queued();
    const before=await f.t.run(ctx=>ctx.db.get(q.commandId));
    expect(before!.command.providerRequest).toBe(buildIncreaseRequestBody(before!.command));
    expect(before!.command.requestHash).toBe(await commandRequestHash(before!.command));
    const claim=await f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:"w",leaseToken:"unique-lease-token"});
    assert(claim);
    expect(claim.command).toEqual(before!.command);
    expect((await f.human.query(api.demoPayments.humanReview,{scope:f.scope})).operator).toEqual({seatId:"human_cfo",name:"human_cfo"});
  });

  it("rolls back a failed bill acceptance and rejects invalid dates and unsafe totals", async () => {
    const f = await demoFixture();
    await expect(f.t.mutation(api.demoPayments.recordBill,{...f.ap,vendor:"vendor-1",invoiceNumber:"bad",invoiceDate:"2026-02-31",originalCents:100,expenseAccount:"5000",evidence:["e"]})).rejects.toThrow("Invalid");
    const {billId} = await f.t.mutation(api.demoPayments.recordBill,{...f.ap,vendor:"vendor-1",invoiceNumber:"outside",invoiceDate:"2026-11-01",originalCents:100,expenseAccount:"5000",evidence:["e"]});
    await expect(f.t.mutation(api.demoPayments.acceptBill,{...f.controller,billId,approvedCents:100})).rejects.toThrow("not been opened");
    const row = await f.t.run(ctx=>ctx.db.get(billId));expect(row).toMatchObject({status:"recorded",version:1});expect((row as any).entryId).toBeUndefined();
    expect(await f.t.run(ctx=>ctx.db.query("journalEntries").collect())).toHaveLength(0);
    const enormous = [];
    for (const i of [1,2]) {
      const {billId} = await f.t.mutation(api.demoPayments.recordBill,{...f.ap,vendor:"vendor-1",invoiceNumber:`huge-${i}`,invoiceDate:"2026-10-23",originalCents:Number.MAX_SAFE_INTEGER,expenseAccount:"5000",evidence:["e"]});
      if(i === 1) await f.human.mutation(api.demoPayments.humanAcceptBill,{scope:f.scope,billId,approvedCents:Number.MAX_SAFE_INTEGER});
      else {
        await expect(f.human.mutation(api.demoPayments.humanAcceptBill,{scope:f.scope,billId,approvedCents:Number.MAX_SAFE_INTEGER})).rejects.toThrow("Unsafe cumulative accounting cents");
        expect(await f.t.run(ctx => ctx.db.get(billId))).toMatchObject({status:"recorded",version:1});
        // Corrupt fixture only: payment must fail safely even if historical metadata is bad.
        await f.t.run(ctx => ctx.db.patch(billId, {status:"approved",approvedCents:Number.MAX_SAFE_INTEGER}));
      }
      enormous.push(billId);
    }
    await expect(f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:"overflow",billIds:enormous,credits:[]})).rejects.toThrow("Unsafe cumulative");
  });

  it("atomically rejects concurrent bill and credit allocations without partial reservations", async () => {
    const f = await demoFixture();
    const {creditId} = await f.human.mutation(api.demoPayments.recordCredit,{scope:f.scope,reference:"credit-1",amountCents:6000,evidence:"credit.pdf",date:"2026-10-23",expenseAccount:"5000"});
    await expect(f.human.mutation(api.demoPayments.recordCredit,{scope:f.scope,reference:"credit-1",amountCents:6000,evidence:"credit.pdf",date:"2026-10-24",expenseAccount:"5000"})).rejects.toThrow("idempotency conflict");
    const [a,b] = await Promise.all([f.bill(),f.bill()]);
    const requests = await Promise.allSettled([a,b].map((billId,i)=>f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:`credit-${i}`,billIds:[billId],credits:[{creditId,amountCents:6000}]})));
    expect(requests.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(await f.t.run(ctx=>ctx.db.query("demoCommands").collect())).toHaveLength(0);
    const request=requests.find(r=>r.status==="fulfilled")!;
    assert(request.status==="fulfilled");
    await f.human.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...request.value});
    expect((await f.t.run(ctx=>ctx.db.get(creditId))) as any).toMatchObject({reservedCents:6000,consumedCents:0});
    expect((await f.t.run(ctx=>ctx.db.query("demoBills").collect())).filter(b=>b.reservedVersionId)).toHaveLength(1);
    expect(await f.t.run(ctx=>ctx.db.query("demoCommands").collect())).toHaveLength(1);
  });
});

describe("durable fenced dispatch", () => {
  it("claims once concurrently and fences restarted workers including same worker ID", async () => {
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    const f = await demoFixture();const q = await f.queued();
    const common={scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:"same-worker"};
    const claims=await Promise.all(["lease-token-first","lease-token-other"].map(leaseToken=>f.t.mutation(api.demoPayments.claim,{...common,leaseToken})));
    expect(claims.filter(Boolean)).toHaveLength(1);const first=claims.find(Boolean)!;
    vi.setSystemTime(Date.now()+30_001);
    const second=await f.t.mutation(api.demoPayments.claim,{...common,leaseToken:"lease-token-restarted"});
    assert(second);
    expect(second.command).toEqual(first.command);expect(second.generation).toBe(first.generation+1);
    const stale=paymentLeaseProof(first);
    await expect(f.t.mutation(api.demoPayments.complete,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,...stale,providerTransferId:"bank-1"})).rejects.toThrow("Stale");
    await expect(f.t.mutation(api.demoPayments.heartbeat,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,...stale})).rejects.toThrow("Stale");
    await expect(f.human.mutation(api.demoPayments.cancel,{scope:f.scope,versionId:q.versionId})).rejects.toThrow("may have started");
    expect((await f.t.run(ctx=>ctx.db.get(q.billId)))?.reservedVersionId).toBe(q.versionId);
  });

  it("cancellation races claim atomically and never releases a possibly sent command", async () => {
    const f=await demoFixture();const q=await f.queued();
    const results=await Promise.allSettled([f.human.mutation(api.demoPayments.cancel,{scope:f.scope,versionId:q.versionId}),f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:"w",leaseToken:"unique-lease-token"})]);
    const c=await f.t.run(ctx=>ctx.db.get(q.commandId));const b=await f.t.run(ctx=>ctx.db.get(q.billId));
    if(c!.execution==="cancelled") {expect(c!.attemptCount).toBe(0);expect(b!.reservedVersionId).toBeUndefined();expect(results[1]).toMatchObject({status:"fulfilled",value:null});}
    else {expect(c!.execution).toBe("in_flight");expect(b!.reservedVersionId).toBe(q.versionId);expect(results[0].status).toBe("rejected");}
  });

  it("AP exception before dispatch invalidates approval; after dispatch preserves the original obligation", async () => {
    const f = await demoFixture();const cancelled=await f.queued();
    await f.t.mutation(api.demoPayments.flagException,{...f.ap,billId:cancelled.billId,reason:"receipt mismatch"});
    expect(await f.t.run(ctx=>ctx.db.get(cancelled.commandId))).toMatchObject({execution:"cancelled",attemptCount:0});
    expect((await f.t.run(ctx=>ctx.db.get(cancelled.billId)))?.reservedVersionId).toBeUndefined();
    const started=await f.queued();await f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:"w",leaseToken:"unique-lease-token"});
    await f.t.mutation(api.demoPayments.flagException,{...f.ap,billId:started.billId,reason:"late receipt mismatch"});
    expect(await f.t.run(ctx=>ctx.db.get(started.commandId))).toMatchObject({execution:"in_flight",attemptCount:1});
    expect(await f.t.run(ctx=>ctx.db.get(started.billId))).toMatchObject({reservedVersionId:started.versionId,flags:["late receipt mismatch"]});
    await expect(f.human.mutation(api.demoPayments.cancel,{scope:f.scope,versionId:started.versionId})).rejects.toThrow("may have started");
  });

  it("persists retry-after and bounded unknown failures while preserving the original request and reservations", async () => {
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    const f=await demoFixture();const q=await f.queued();let original:any;
    for(let i=0;i<8;i++) {
      const claim=await f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:"w",leaseToken:`unique-lease-token-${i}`});
      assert(claim);
      original??=claim.command;expect(claim.command).toEqual(original);
      const lease=paymentLeaseProof(claim);
      const failed=await f.t.mutation(api.demoPayments.fail,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,...lease,errorClass:i===0?"rate_limit":"transport",error:"response lost",retryAfterMs:i===0?5000:undefined});
      if(i===0)expect(failed.nextAttemptAt-Date.now()).toBeGreaterThanOrEqual(5000);
      expect(await f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:"w",leaseToken:`premature-lease-token-${i}`})).toBeNull();
      vi.setSystemTime(failed.nextAttemptAt+1);
    }
    const row=await f.t.run(ctx=>ctx.db.get(q.commandId));expect(row).toMatchObject({execution:"exception",attemptCount:8});expect((await f.t.run(ctx=>ctx.db.get(q.billId)))?.reservedVersionId).toBe(q.versionId);
    const firstAttemptAt=row!.firstAttemptAt;
    await f.human.mutation(api.demoPayments.resume,{scope:f.scope,commandId:q.commandId,reason:"operator verified configuration and requests recovery"});
    const c=await f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:"w",leaseToken:"operator-recovery-lease"});assert(c);expect(c.command).toEqual(original);
    expect(await f.t.run(ctx=>ctx.db.get(q.commandId))).toMatchObject({attemptCount:9,firstAttemptAt});
  });

  it("pauses auth/configuration/idempotency failures and never treats them as bank rejection", async () => {
    const f=await demoFixture();
    for(const errorClass of ["authentication","configuration","validation","idempotency_conflict"]) {
      const q=await f.queued();const c=await f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:"w",leaseToken:`lease-token-${errorClass}`});
      assert(c);
      const lease=paymentLeaseProof(c);
      expect(await f.t.mutation(api.demoPayments.fail,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,...lease,errorClass,error:"operator action required"})).toMatchObject({execution:"exception"});
      expect((await f.t.run(ctx=>ctx.db.get(q.billId)))?.reservedVersionId).toBe(q.versionId);
    }
  });
});
