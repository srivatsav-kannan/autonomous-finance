import {afterEach,describe,it,expect,vi} from "vitest";
import {makeFunctionReference} from "convex/server";
import {br} from "./business-fixture";
import {creditFixture} from "./quickbooks-business-fixture";
const read=makeFunctionReference<"query">("apAccountingCorrections:creditApplication");
afterEach(()=>vi.unstubAllEnvs());
describe("current-human grouped credit application read",()=>{
 it("returns the exact group from either component without creating authority or journals",async()=>{
  const f=await creditFixture(),a=await f.credit("GROUP-A"),b=await f.credit("GROUP-B"),detail=(await f.load()).detail;
  await f.humans.finance!.mutation(br.applyCredits!,{scope:f.scope,caseId:detail.caseId,expectedRevision:detail.revision,snapshotHash:detail.snapshotHash,billVersion:detail.links.billVersion,idempotencyKey:"two-credit-group",reason:"Explicit two-credit application",credits:[{creditId:a.creditId,amountCents:500},{creditId:b.creditId,amountCents:600}]});
  const rows=await f.t.run(ctx=>ctx.db.query("apCreditApplications").collect());expect(rows).toHaveLength(2);
  const history=()=>f.t.run(async ctx=>({journals:await ctx.db.query("journalEntries").collect(),commands:await ctx.db.query("demoCommands").collect(),corrections:await ctx.db.query("apAccountingCorrections").collect()}));const before=await history();
  const args={scope:f.scope,caseId:detail.caseId,creditApplicationId:rows[0]!._id};
  const group=await f.humans.finance!.query(read,args),second=await f.humans.finance!.query(read,{...args,creditApplicationId:rows[1]!._id});
  expect(group).toEqual(second);expect(group.amountCents).toBe(1100);expect(group.applicationIds).toEqual(rows.map(r=>r._id).sort());expect(group.credits.map((c:any)=>c.amountCents).sort()).toEqual([500,600]);expect(await history()).toEqual(before);
  await expect(f.t.query(read,args)).rejects.toThrow();await expect(f.humans.finance!.query(read,{...args,caseId:a.caseId})).rejects.toThrow(/recognized_bill|recognized_invoice|case mismatch/i);await expect(f.humans.finance!.query(read,{...args,scope:{...f.scope,accountId:"other-account"}})).rejects.toThrow();
  await f.t.run(async ctx=>{const row=(await ctx.db.query("demoConfigs").first())!;await ctx.db.patch(row._id,{humanSubjects:row.humanSubjects.filter(h=>!h.subject.endsWith("|finance"))});});
  await expect(f.humans.finance!.query(read,args)).rejects.toThrow();
 });
});
