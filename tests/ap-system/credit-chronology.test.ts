import {afterEach,expect,it,vi} from "vitest";
import {creditFixture} from "./quickbooks-business-fixture";
afterEach(()=>vi.unstubAllEnvs());
it("refuses a credit predating the original invoice and its receiving evidence without posting it",async()=>{
 const f=await creditFixture();const before=await f.t.run(ctx=>ctx.db.query("journalEntries").collect());
 await expect(f.credit("BACKDATED","2026-10-18")).rejects.toThrow(/credit_chronology/);
 expect(await f.t.run(ctx=>ctx.db.query("journalEntries").collect())).toEqual(before);
 expect(await f.t.run(ctx=>ctx.db.query("demoCredits").collect())).toHaveLength(0);
});
it("accepts a credit on the same date as its invoice and return evidence",async()=>{
 const f=await creditFixture();const c=await f.credit("CURRENT","2026-10-19");expect(c.creditId).toBeTruthy();
 expect(await f.t.run(ctx=>ctx.db.query("demoCredits").collect())).toHaveLength(1);
});
