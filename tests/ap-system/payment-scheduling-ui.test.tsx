import { describe,expect,it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { APAccounting } from "../../console/src/APSystemWorkspace";
import { paymentAmountInput } from "../../console/src/apSystemView";
import { apUIFixture } from "../ap-system-ui.fixture";
describe("payment selection presentation",()=>{
 it("renders the due date as an explicit initiation choice and supports another payment after partial settlement",()=>{
  const d=apUIFixture();d.states.business="approved";d.links.billId="bill";d.amounts.outstandingCents=4000;d.payments=[{versionId:"previous",commandId:"command",amountCents:4000,status:"settled",beneficiaryVersion:"v1",providerTransferId:"bank",authorizedBy:["human"]}];
  const html=renderToStaticMarkup(<APAccounting detail={d}/>);expect(html).toContain("Initiate on (UTC)");expect(html).toContain("Bill amount to pay (USD)");expect(html).toContain("Prepare payment proposal");expect(html).toContain("bank settlement timing can differ");expect(html).toContain('placeholder="40.00"');
 });
 it("does not offer a second proposal while a payment outcome is unknown",()=>{
  const d=apUIFixture();d.states.business="approved";d.links.billId="bill";d.amounts.outstandingCents=10000;d.payments=[{versionId:"unknown",commandId:"command",amountCents:4000,status:"queued",beneficiaryVersion:"v1",providerTransferId:null,authorizedBy:["human"]}];
  expect(renderToStaticMarkup(<APAccounting detail={d}/>)).not.toContain("Prepare payment proposal");
 });
 it("parses cents exactly without rounding or allowing more than the approved remainder",()=>{
  expect(paymentAmountInput("",67860)).toBe(67860);expect(paymentAmountInput("0.29",67860)).toBe(29);expect(paymentAmountInput(" 10.5 ",67860)).toBe(1050);
  for(const value of ["0","-1","1.009","Infinity","1e2","10,000","678.61","99999999999999999999999999"]){expect(()=>paymentAmountInput(value,67860)).toThrow();}
 });
});
