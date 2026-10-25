import {expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {closeActionSchema} from "../src/ap-system/close-contracts";
import {APAccountingReceipt} from "../console/src/APSystemQuickBooks";
import {APSystemCloseQuickBooks,APCloseSyncReadiness,closeSyncPermissions} from "../console/src/APSystemCloseQuickBooks";
import {taxReceiptUIFixture,taxReceiptFixtureResponse,taxReceiptActionId,type TaxReceiptScenario} from "./ap-system-tax-receipt-ui.fixture";
const authorities=["current","historical_receipt_only"] as const,states=["prepared","sending","unknown","succeeded"] as const;
it("provides every desktop matrix state using a valid tax action and exact existing journal selector",()=>{
 for(const authority of authorities)for(const state of states)for(const reads of [false,true]){
  const f=taxReceiptUIFixture({authority,state,reads}),r=f.status.receipts[0]!;
  expect(closeActionSchema.parse(f.view.actions[0]!.payload).kind).toBe("tax_adjustment");expect(f.view.actions).toHaveLength(1);expect(f.view.accrualApplications).toEqual([]);expect(r.state).toBe(state);expect(r.links.closeActionId).toBe(taxReceiptActionId);expect(r.links.closeJournalId).toBe("synthetic-tax-receipt-journal");expect(r.links.commandId).toBeNull();expect(r.externalId!==null).toBe(state==="succeeded");expect(f.status.externalWritesAllowed).toBe(authority==="current");expect(f.status.externalReadsAllowed).toBe(reads);
  expect(closeSyncPermissions(f.status)).toEqual({preview:authority==="current",submit:authority==="current",read:reads});
 }
});
it("renders historical authority clearly and gives sending/unknown recovery only the explicit read permission",()=>{
 for(const state of states)for(const reads of [false,true]){
  const f=taxReceiptUIFixture({authority:"historical_receipt_only",state,reads});const permissions=closeSyncPermissions(f.status);
  const message=renderToStaticMarkup(<APCloseSyncReadiness status={f.status}/>);expect(message).toContain("Current write authority is unavailable");expect(message).not.toContain("unsupported in Local FakeBank");
  const html=renderToStaticMarkup(<APAccountingReceipt receipt={f.status.receipts[0]!} busy={false} canVerify={permissions.read} canRecover={f.status.externalReadsAllowed===true} onVerify={()=>{}}/>);
  expect(html.includes("Recover existing external request")).toBe(reads&&(state==="sending"||state==="unknown"));if(state==="succeeded")expect(html.includes('disabled=""')).toBe(!reads);
 }
 const f=taxReceiptUIFixture({authority:"historical_receipt_only",state:"unknown",reads:true}),html=renderToStaticMarkup(<APSystemCloseQuickBooks view={f.view} busy={false} onBusy={()=>{}}/>);expect(html).toContain(`value="action:${taxReceiptActionId}"`);expect(html).not.toContain('value="action:synthetic-accrual-action"');
});
it("intercepts all provider and financial actions without mutating the selected receipt",()=>{
 const request={request:{actionId:taxReceiptActionId}},path="/api/ap-system/close/accounting/";
 for(const authority of authorities)for(const state of states)for(const reads of [false,true]){
  const scenario:TaxReceiptScenario={authority,state,reads},before=taxReceiptUIFixture(scenario);
  expect(taxReceiptFixtureResponse(scenario,path+"status","POST",request).status).toBe(200);
  expect(taxReceiptFixtureResponse(scenario,path+"preview","POST",request).status).toBe(authority==="current"?200:403);
  expect(taxReceiptFixtureResponse(scenario,path+"submit","POST",request).status).toBe(403);
  const verify=taxReceiptFixtureResponse(scenario,path+"verify","POST",request);expect(verify.status).toBe(409);expect(JSON.stringify(verify.value)).toContain("No provider was contacted");
  expect(taxReceiptFixtureResponse(scenario,"https://external.invalid/action","POST",request).status).toBe(403);expect(taxReceiptUIFixture(scenario)).toEqual(before);
 }
 expect(taxReceiptFixtureResponse({authority:"current",state:"unknown",reads:true},path+"status","POST",{request:{actionId:"other"}}).status).toBe(503);
});
