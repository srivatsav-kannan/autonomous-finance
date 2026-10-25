import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { PAYMENT_EXECUTOR_VERSION } from "../../src/payments/contracts";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { caseDetailSchema, intakeSchema, type APIntake, type SourceOutcome } from "../../src/ap-system/contracts";
import { fixture, packet, refs } from "./accounting-fixture";
import { businessFixture, binding } from "./business-fixture";

const record = makeFunctionReference<"mutation">("apCases:recordSourceOutcome");
const requestCase = makeFunctionReference<"mutation">("apCasePayments:request");
const outcome = (p: APIntake): SourceOutcome => ({status:"historical_paid",amountCents:p.candidate!.totalCents,currency:p.candidate!.currency,sourceReference:"historical-ledger:bill-2024-001",evidence:[binding(p.documents[0]!)],reason:"Retained ledger records this invoice fully paid before this run."});
afterEach(() => vi.unstubAllEnvs());

describe("historical source payment is evidence, never fresh payment authority", () => {
  it("requires exact invoice binding and matching amount/currency", () => {
    const p=packet();p.sourceOutcome=outcome(p);
    expect(intakeSchema.safeParse(p).success).toBe(true);
    for(const sourceOutcome of [{...p.sourceOutcome,amountCents:1},{...p.sourceOutcome,currency:"EUR"},{...p.sourceOutcome,evidence:[binding(p.documents[1]!)]},{...p.sourceOutcome,evidence:[{...binding(p.documents[0]!),sha256:"f".repeat(64)}]}]) {
      expect(intakeSchema.safeParse({...p,sourceOutcome}).success).toBe(false);
    }
  });

  it("retains and reviews paid source originals but blocks direct bill recognition and case payment", async () => {
    const f=await fixture(), p=packet();p.sourceOutcome=outcome(p);
    const d=await f.reviewed(p);
    expect(caseDetailSchema.parse(d).sourceOutcome).toEqual(p.sourceOutcome);
    expect(d.exceptions).toContainEqual(expect.objectContaining({code:"historical_source_paid",blocking:true}));
    expect(d.amounts.settledCents).toBe(0);expect(d.payments).toEqual([]);expect(d.journals).toEqual([]);
    await expect(f.human.mutation(refs.approve,{scope:f.scope,input:{...f.request(d,"recognize"),acceptedCents:7700}})).rejects.toThrow(/historical_source_paid/);
    await expect(f.t.mutation(requestCase,{scope:f.scope,seatId:"payments",token:"token-payments",caseId:d.caseId,expectedRevision:d.revision,snapshotHash:d.snapshotHash,idempotencyKey:"pay"})).rejects.toThrow(/historical_source_paid/);
    const rows=await f.t.run(async ctx=>({bills:await ctx.db.query("demoBills").collect(),commands:await ctx.db.query("demoCommands").collect()}));
    expect(rows).toEqual({bills:[],commands:[]});
  });

  it("blocks the governed business route too", async () => {
    const p=packet();p.sourceOutcome=outcome(p);const f=await businessFixture({input:p});
    await expect(f.propose()).rejects.toThrow(/historical_source_paid/);
    expect(await f.t.run(ctx=>ctx.db.query("apApprovalProposals").collect())).toEqual([]);
  });

  it("rechecks historical status when voting on an already prepared business proposal", async () => {
    const f=await businessFixture(),proposal=await f.propose();
    await f.t.mutation(record,{...f.ap,caseId:f.detail.caseId,sourceOutcome:outcome(f.input)});
    await expect(f.vote(proposal)).rejects.toThrow(/historical_source_paid/);
    expect(await f.t.run(ctx=>ctx.db.query("demoBills").collect())).toEqual([]);
  });

  it("backfills old imports idempotently and cannot be cleared by renamed reimport or revision", async () => {
    const f=await fixture(),p=packet(),d=await f.reviewed(p),sourceOutcome=outcome(p);
    const args={...f.ap,caseId:d.caseId,sourceOutcome};
    expect(await f.t.mutation(record,args)).toMatchObject({replayed:false});
    expect(await f.t.mutation(record,args)).toMatchObject({replayed:true});
    expect((await f.get(d.caseId)).revision).toBe(d.revision);
    await expect(f.t.mutation(record,{...args,sourceOutcome:{...sourceOutcome,sourceReference:"different"}})).rejects.toThrow(/immutable/);
    const renamed=structuredClone(p);renamed.idempotencyKey="renamed";renamed.documents.forEach(s=>{s.name=`copy-${s.name}`;s.deliveryId=`copy-${s.deliveryId}`;});
    expect(await f.t.mutation(refs.ingest,{...f.ap,input:renamed})).toMatchObject({caseId:d.caseId,duplicate:true});
    const revised=structuredClone(p);revised.idempotencyKey="revision";revised.explicitRevisionOf=d.caseId;revised.candidate!.revision=2;
    await f.t.mutation(refs.ingest,{...f.ap,input:revised});
    const next=await f.get(d.caseId);expect(next.sourceOutcome).toEqual(sourceOutcome);
    await expect(f.human.mutation(refs.approve,{scope:f.scope,input:{...f.request(next,"recognize-revision"),acceptedCents:7700}})).rejects.toThrow(/historical_source_paid/);
  });

  it("requires AP authority and exact retained source for backfill", async () => {
    const f=await fixture(),p=packet(),d=await f.reviewed(p),sourceOutcome=outcome(p);
    await expect(f.t.mutation(record,{...f.ap,token:"wrong",caseId:d.caseId,sourceOutcome})).rejects.toThrow();
    await expect(f.t.mutation(record,{...f.ap,caseId:d.caseId,sourceOutcome:{...sourceOutcome,evidence:[binding(p.documents[1]!)]}})).rejects.toThrow(/current invoice original/);
    expect((await f.get(d.caseId)).sourceOutcome).toBeUndefined();
  });

  it("prevents payment engine bypass after historical status is discovered on an already recognized bill", async () => {
    const f=await fixture(),p=packet(),d=await f.reviewed(p);
    const bill=await f.human.mutation(refs.approve,{scope:f.scope,input:{...f.request(d,"recognize"),acceptedCents:7700}});
    const pay={scope:f.scope,seatId:"payments",token:"token-payments",requestKey:"payment-before-discovery",billIds:[bill.billId as Id<"demoBills">],credits:[]};
    const version=await f.t.mutation(api.demoPayments.requestPayment,pay);
    await f.t.mutation(record,{...f.ap,caseId:d.caseId,sourceOutcome:outcome(p)});
    await expect(f.human.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...version})).rejects.toThrow(/historical_source_paid/);
    await expect(f.t.mutation(api.demoPayments.requestPayment,{...pay,requestKey:"bypass-case-api"})).rejects.toThrow(/historical_source_paid/);
    expect(await f.t.run(ctx=>ctx.db.query("demoCommands").collect())).toEqual([]);
  });

  it("blocks first dispatch if historical status arrives after queued approval", async () => {
    const f=await fixture(),p=packet(),d=await f.reviewed(p);
    const bill=await f.human.mutation(refs.approve,{scope:f.scope,input:{...f.request(d,"recognize"),acceptedCents:7700}});
    const version=await f.t.mutation(api.demoPayments.requestPayment,{scope:f.scope,seatId:"payments",token:"token-payments",requestKey:"queued-before-discovery",billIds:[bill.billId as Id<"demoBills">],credits:[]});
    await f.human.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...version});
    await f.t.mutation(record,{...f.ap,caseId:d.caseId,sourceOutcome:outcome(p)});
    const claimed=await f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:"test-dispatch",paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,workerId:"test",leaseToken:"historical-paid-test-lease-0001"});
    expect(claimed).toBeNull();
    const commands=await f.t.run(ctx=>ctx.db.query("demoCommands").collect());
    expect(commands).toHaveLength(1);expect(commands[0]).toMatchObject({execution:"exception",attemptCount:0});
  });
});
