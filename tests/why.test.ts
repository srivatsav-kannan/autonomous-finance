import { describe, expect, it } from "vitest";
import type { CommitInfo, MemoryStore } from "../src/memory/store";
import { rankCommits, terms, why } from "../src/human/why";

let n = 0;
const commit = (author: string, subject: string): CommitInfo => ({ sha: (++n).toString(16).padStart(40, "0"), author, email: "", at: "", subject, trailers: {} });
// Newest first, like `git log`; shaped like scenario-1's decision commits.
const log = [
  commit("Controller Agent", "HOLD close 2026-01@3019a80b: Not ready to close 2026-01: 21 source/bill blocker(s)"),
  commit("Payroll Accountant", "HOLD payroll payroll-sf-hayes-valley-2026-01-14: Accrued $24,158.00 for 17 people; held Gus A. ($1,316.00): terminated 2026-01-05"),
  commit("Payroll Accountant", "ACT payroll payroll-sf-mission-2026-01-14: Accrued $25,215.50 for 18 people; roster matches"),
  commit("AP Clerk 1", "HOLD bill golden-state-produce/INV-1004: Held: AVO-48 billed $73.79 vs contract $68.90 (+7.1%)"),
  commit("Controller Agent", "ACT held_bill embarcadero-realty/LSESFMIS202601: Approve $17,378.32 (clean match, over AP auto-approve limit)"),
  commit("Payments Agent", "REJECT remit_change golden-state-produce: Blocked bank-change request for Golden State Produce Co.: sender domain does not match"),
  commit("Controller Agent", "ACT held_bill golden-state-produce/1002: Approve $763.20 of $840.20: KALE-24 invoiced 6, received 4"),
  commit("AP Clerk 1", "HOLD bill golden-state-produce/INV-1002: Held: KALE-24 invoiced 6, received 4"),
  commit("AP Clerk 1", "ACT bill golden-state-produce/INV-1001: Approved $640.10: clean 3-way match"),
];
const top = (q: string) => rankCommits(log, q)[0]?.subject;

describe("why: keyword search over decision commits", () => {
  it("drops stop words and normalizes word forms", () => {
    expect(terms("Why was INV-1002 held?")).toEqual(["inv", "1002", "held"]);
    expect(terms("approved")).toEqual(terms("approve"));
  });

  it("puts the decision the question is about first", () => {
    expect(top("Why was INV-1002 held?")).toMatch(/^HOLD bill golden-state-produce\/INV-1002/);
    expect(top("Which payroll entry was held and why?")).toMatch(/^HOLD payroll/);
    expect(top("Why is the close blocked?")).toMatch(/^HOLD close/);
    expect(top("What happened with the bank-detail change request from Golden State Produce?")).toMatch(/^REJECT remit_change/);
    expect(top("Who approved the Embarcadero rent payment?")).toMatch(/embarcadero-realty/);
  });

  it("returns nothing for a question the record doesn't touch", () => {
    expect(rankCommits(log, "quarterly dividend")).toEqual([]);
  });

  it("answers without a model or backend, citing commit SHAs", async () => {
    const mem = { log: async () => log } as unknown as MemoryStore;
    const answer = await why("scenario-1", "Why was INV-1002 held?", { mem, model: false });
    expect(answer.mode).toBe("keyword");
    expect(answer.answer.split("\n")[0]).toBe(`AP Clerk 1: HOLD bill golden-state-produce/INV-1002: Held: KALE-24 invoiced 6, received 4 (${log[7]!.sha.slice(0, 8)})`);
    expect(answer.cited?.[0]).toBe(log[7]!.sha);
    expect((await why("scenario-1", "quarterly dividend", { mem, model: false })).answer).toBe("No matching decisions.");
  });

  it("is the gateway's handler too", async () => {
    const fs = await import("node:fs");
    const gateway = fs.readFileSync("src/human/gateway.ts", "utf8");
    expect(gateway).toContain('import { why } from "./why";');
    expect(gateway).not.toContain("async function why(");
  });
});
