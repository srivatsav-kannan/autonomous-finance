import { describe, expect, it } from "vitest";
import type { Doc } from "../convex/_generated/dataModel";
import { caseRecords } from "../console/src/case-model";
const bill = (id: string, decisionPath: string) => ({ _id: id, vendor: "same-vendor", decisionPath, documentEventId: `source-${id}` }) as Doc<"bills">;
const payment = (id: string, billIds: string[]) => ({ _id: id, billIds }) as Doc<"paymentIntents">;
const ask = (extra: object = {}) => ({ evidence: [], ...extra }) as Doc<"asks">;
describe("case identity", () => {
  const bills = [bill("a", "decisions/a.yaml"), bill("b", "decisions/b.yaml")];
  const payments = [payment("pa", ["a"]), payment("pb", ["b"])];
  it("never connects unrelated bills from the same vendor", () => {
    expect(caseRecords(ask(), bills, payments)).toEqual({ bills: [], payments: [] });
  });
  it("connects exact decision evidence to its bill and original payment", () => {
    expect(caseRecords(ask({ evidence: [{ ref: "decisions/a.yaml" }] }), bills, payments)).toEqual({ bills: [bills[0]], payments: [payments[0]] });
  });
  it("keeps every bill of a multi-bill payment", () => {
    const bundled = payment("bundle", ["a", "b"]);
    expect(caseRecords(ask({ paymentIntentId: "bundle" }), bills, [bundled])).toEqual({ bills, payments: [bundled] });
  });
  it("does not make up missing records while data loads", () => {
    expect(caseRecords(ask({ paymentIntentId: "pa" }), [], [])).toEqual({ bills: [], payments: [] });
  });
});
