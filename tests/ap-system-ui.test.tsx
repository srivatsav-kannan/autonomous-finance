import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APSystemWorkspace, APOperationalMetrics, APCaseStatus, APActions, APMatching, APAccounting } from "../console/src/APSystemWorkspace";
import { APAccountingPlan, APAccountingHold, APAccountingReceipt, accountingTarget, receiptTarget } from "../console/src/APSystemQuickBooks";
import type { Plan } from "../src/ap-system/quickbooks/types";
import type { QBOReceipt } from "../src/ap-system/quickbooks/runtime";
import { acceptanceDraft, APAcceptanceSummary, APSystemBusiness } from "../console/src/APSystemBusiness";
import { APPaymentRunReview, runEligible } from "../console/src/APSystemRuns";
import type { PaymentRunDetail } from "../src/ap-system/workspace-operations";
import { APSystemEvidence, EvidencePage } from "../console/src/APSystemEvidence";
import { apFieldLabel, apFieldValue, apMoney, displayedFrame, regionPolygon, reviewPayload, sourceForEvidence, paymentBelongsToCase } from "../console/src/apSystemView";
import { configureAPSession } from "../console/src/apAuthSession";
import { apPageUrl, apSystemApi, loadPage } from "../console/src/apSystemApi";
import { apUIFixture, uiEvidence } from "./ap-system-ui.fixture";

afterEach(()=>{configureAPSession(null);vi.unstubAllGlobals();});
describe("AP case workspace evidence boundaries",()=>{
  it("keeps direct-link detail and upload gated while the initial session is loading",()=>{
    vi.stubGlobal("window",{location:{search:"?case=cold-session-case"}});
    const html=renderToStaticMarkup(<APSystemWorkspace/>);
    expect(html).toContain("Loading linked case evidence");
    expect(html).toMatch(/disabled="" aria-expanded="false">Upload documents<\/button>/);
    expect(html).not.toContain("Case unavailable");
    expect(html).not.toContain("No AP cases yet");
  });
  it("reviews run cash only when every frozen payment is available and excludes queued cases",()=>{
    const c=apUIFixture();c.states.document="reviewed";c.states.business="approved";c.links.recognitionJournalId="recognition";c.amounts.outstandingCents=10550;
    expect(runEligible(c)).toBe(true);
    const run:PaymentRunDetail={runId:"run-fixture",scope:c.scope,requestedBy:"fixture",snapshotHash:c.snapshotHash,executionDate:"2026-11-01",createdAt:c.createdAt,items:[{caseId:c.caseId,caseRevision:1,caseSnapshotHash:c.snapshotHash,versionId:"payment-fixture",paymentSnapshotHash:c.snapshotHash,payment:null}]};
    const html=renderToStaticMarkup(<APPaymentRunReview run={run} cases={[c]} onOpenCase={()=>{}}/>);
    expect(html).toContain("Payment snapshot unavailable");expect(html).toContain("Not established");expect(html).not.toContain("$0.00");expect(html).toContain("2026-11-01 (UTC)");
    c.payments=[{versionId:"p",status:"queued",amountCents:100,commandId:null,beneficiaryVersion:"v1",providerTransferId:null,authorizedBy:[]}];
    expect(runEligible(c)).toBe(false);
  });
  it("does not aggregate duplicate or unknown invoice obligations as established cash",()=>{
    const c=apUIFixture();c.states.business="approved";c.amounts.outstandingCents=10000;
    const duplicate={...c,caseId:"duplicate",links:{...c.links,duplicateOfCaseId:c.caseId}};
    const unknown={...c,caseId:"unknown",amounts:{...c.amounts,outstandingCents:null}};
    const html=renderToStaticMarkup(<APOperationalMetrics cases={[c,duplicate,unknown]}/>);
    expect(html).toContain("$100.00");expect(html).toContain("1 approved case amount unavailable");expect(html).not.toContain("$200.00");
  });
  it("keeps governed business approval separate and requires explicit receipt claims",()=>{
    const c=apUIFixture(),draft=acceptanceDraft(c);
    expect(draft.lines.map(l=>l.quantity)).toEqual(["2","1"]);expect(draft.lines.every(l=>l.agreement===null&&l.receipts.length===0&&l.taxCode==="")).toBe(true);
    draft.lines[0]!.quantity="1";draft.lines[0]!.netCents=3850;expect(c.candidate!.lines[0]!.amountCents).toBe(7700);
    c.domain={policyVersion:"explicit-v1",supplierId:c.candidate!.supplierId,supplierRevision:1,approvalId:"proposal",approvalHash:c.snapshotHash,approvalStatus:"pending",route:[{groupId:"controller",quorum:2,escalateAfterMs:60000,escalationGroupId:null}],stage:0,stageStartedAt:c.createdAt,votes:[],acceptance:draft,credit:null,creditLinks:[],recognizedCents:0,appliedCreditCents:0,availableSupplierCreditCents:0,cashSettledCents:0};
    const html=renderToStaticMarkup(<APActions detail={c} busy={false} onBusy={()=>{}} onChanged={()=>{}}/>)+renderToStaticMarkup(<APSystemBusiness detail={c} cases={[c]} busy={false} onBusy={()=>{}} onChanged={()=>{}} onOpenCase={()=>{}}/>);
    expect(html).not.toContain(">Approve bill");expect(html).toContain("2 distinct approvals");expect(html).toContain("Approve current business stage");expect(html).toContain(c.snapshotHash);
    const summary=renderToStaticMarkup(<APAcceptanceSummary acceptance={draft}/>);expect(summary).toContain("$38.50");expect(summary).toContain("1 accepted");
  });
  it("distinguishes credit recognition, gross credit application and preserved historical receipt authority",()=>{
    const plan:Plan={version:"ap-qbo-operation-v1",realmId:"synthetic-realm",minorVersion:75,entity:"BillPayment",identity:"fixture",mappingHash:"a".repeat(64),links:{caseId:"c",billId:"b",recognitionJournalId:"r",paymentVersionId:null,commandId:null,bankTransactionId:null,settlementJournalId:null,creditId:null,creditApplicationId:"application"},payload:{TotalAmt:0,TxnDate:"2026-10-25",Line:[{Amount:100,LinkedTxn:[{TxnId:"bill",TxnType:"Bill"}]},{Amount:100,LinkedTxn:[{TxnId:"credit",TxnType:"VendorCredit"}]}]}};
    const html=renderToStaticMarkup(<APAccountingPlan plan={plan}/>);
    expect(html).toContain("Record an applied supplier credit");expect(html).toContain("Net cash recorded");expect(html).toContain("$0.00");expect(html).toContain("Gross obligation discharged");expect(html).toContain("$100.00");
    expect(renderToStaticMarkup(<APAccountingPlan plan={{...plan,entity:"VendorCredit"}}/>)).toContain("Record the approved supplier credit");
    const receipt:QBOReceipt={entity:"BillPayment",requestId:"request",state:"succeeded",externalId:"synthetic-external-record",syncToken:"0",links:plan.links,updatedAt:1,lastError:null,submissionAuthorization:{subject:"original-approver",planHash:"b".repeat(64),decidedAt:1}};
    expect(accountingTarget("credit:application")).toEqual({creditApplicationId:"application"});expect(receiptTarget(receipt)).toEqual({creditApplicationId:"application"});
    const hold=renderToStaticMarkup(<APAccountingHold hold={{code:"returned_cash",owner:"controller",reason:"Current return needs an approved correction",relatedIds:["return-event"]}}/>)+renderToStaticMarkup(<APAccountingReceipt receipt={receipt} busy={false} canVerify={false} onVerify={()=>{}}/>);
    expect(hold).toContain("Historical external record");expect(hold).toContain("original-approver");expect(hold).toContain("They do not resolve the current return");expect(hold).toMatch(/disabled="">Verify external record/);
  });
  it("names source fields for readers and formats cents without altering raw citations",()=>{
    expect(apFieldLabel("totalCents")).toBe("Total amount");
    expect(apFieldLabel("invoiceNumber")).toBe("Invoice number");
    expect(apFieldLabel("lines.line-4.unitPriceCents")).toBe("Line 4 / Unit price");
    expect(apFieldValue({fieldPath:"totalCents",normalizedValue:67860})).toBe("$678.60");
    expect(apFieldValue({fieldPath:"taxCents",normalizedValue:0})).toBe("$0.00");
    expect(apFieldValue({fieldPath:"totalCents",normalizedValue:null})).toBe("Unresolved");
    expect(apFieldValue({fieldPath:"invoiceNumber",normalizedValue:"0067860"})).toBe("0067860");
    const f=apUIFixture(),e=uiEvidence("totalCents","native","678.60 USD (original)");
    e.normalizedValue=67860;
    const html=renderToStaticMarkup(<EvidencePage detail={f} evidence={e}/>);
    expect(html).toContain("$678.60");
    expect(html).toContain('class="aps-quote">678.60 USD (original)</blockquote>');
    expect(html).toContain("Field path");
  });
  it("exposes all 35 fields through a labelled compact selector and searchable scroll region",()=>{
    const f=apUIFixture();
    const paths=["extractedSupplierName","invoiceNumber","invoiceDate","dueDate","currency","terms","subtotalCents","taxCents","freightCents","discountCents","totalCents",...Array.from({length:4},(_,index)=>["sku","description","quantity","unit","unitPriceCents","amountCents"].map(name=>`lines.line-${index+1}.${name}`)).flat()];
    f.candidate!.evidence=paths.map((path,index)=>{const e=uiEvidence(path,index===0?"unresolved":index===12?"derived":"native",`Original quote ${index}`);e.normalizedValue=path.endsWith("Cents")?67860:`Value ${index}`;return e;});
    f.extraction.evidence=f.candidate!.evidence;
    const html=renderToStaticMarkup(<APSystemEvidence detail={f}/>);
    expect(paths).toHaveLength(35);
    expect(html.match(/<option /g)).toHaveLength(36);
    expect(html).toContain('type="search"');
    expect(html).toContain('role="region" aria-label="Field search results" tabindex="0"');
    expect(html).toContain("Line 4 / Unit price");
    expect(html).toContain("Derived location");
    expect(html).toContain("Location unresolved");
    expect(html).toContain("Stored original document");
    expect(html).toContain("Field citation");
  });
  it("maps rotated original regions into display coordinates without merging lines",()=>{
    const frame={width:600,height:800,units:"pixel" as const,origin:"top_left" as const,rotation:90 as const,transform:[0,1,-1,0,800,0] as [number,number,number,number,number,number]};
    expect(displayedFrame(frame)).toEqual({x:0,y:0,width:800,height:600});
    expect(regionPolygon(frame,{x:50,y:100,width:200,height:20,granularity:"line",tokenRefs:["a"]})).toBe("700,50 700,250 680,250 680,50");
  });
  it("does not bind a quote to a source with a different revision/hash",()=>{
    const f=apUIFixture(),e=uiEvidence("total","derived","105.50");e.source={...e.source,revision:2};
    expect(sourceForEvidence(f,e)).toBeUndefined();
    f.sources.push({...f.sources[0]!,revision:2});expect(sourceForEvidence(f,e)).toBeUndefined();
    const html=renderToStaticMarkup(<EvidencePage detail={f} evidence={e}/>);
    expect(html).toContain("missing or different source revision");expect(html).not.toContain("<svg");
  });
  it("keeps unresolved geometry explicit and unknown money distinct from zero",()=>{
    const f=apUIFixture(),html=renderToStaticMarkup(<EvidencePage detail={f} evidence={f.candidate!.evidence[2]!}/>);
    expect(html).toContain("Location unresolved");expect(html).toContain("Only coarse context");expect(html).toContain("Supported content");
    expect(apMoney(null)).toBe("Not established");expect(apMoney(0)).toBe("$0.00");
  });
  it("retains all source bindings and exact revision/snapshot in review requests",()=>{
    const f=apUIFixture(),payload=reviewPayload(f,"  Checked original  ","approved","stable-key");
    expect(payload).toMatchObject({caseId:f.caseId,expectedRevision:1,snapshotHash:f.snapshotHash,sourceBindings:f.candidate!.sources,reason:"Checked original",idempotencyKey:"stable-key"});
    expect(payload.evidenceIds).toEqual(["supplier","line_description","total"]);
  });
  it("reviews current supporting documents without rebinding historical sources",()=>{
    const f=apUIFixture(), invoice=f.sources[0]!;
    const receipt={...invoice,sourceId:"supporting-receipt",kind:"receipt" as const};
    f.sources.push(receipt,{...invoice,revision:2});
    f.currentSourceBindings=[{sourceId:invoice.sourceId,revision:2,sha256:invoice.sha256},{sourceId:receipt.sourceId,revision:1,sha256:receipt.sha256}];
    f.extraction.evidence=[uiEvidence("extra-diagnostic","unresolved","review separately")];
    const request=reviewPayload(f,"Current originals inspected","approved","current-key");
    expect(request.sourceBindings).toEqual(f.currentSourceBindings);
    expect(request.sourceBindings).not.toContainEqual({sourceId:invoice.sourceId,revision:1,sha256:invoice.sha256});
    expect(request.evidenceIds).not.toContain("extra-diagnostic");
  });
  it("shows separate accounting and payment dimensions and no invented journal",()=>{
    const f=apUIFixture();f.states.document="reviewed";f.states.business="approved";f.states.accounting="recognized";f.states.authorization="awaiting_approval";
    const html=renderToStaticMarkup(<APCaseStatus detail={f}/>)+renderToStaticMarkup(<APAccounting detail={f}/>);
    expect(html).toContain("Recognized");expect(html).toContain("Awaiting approval");expect(html).toContain("No journal entry is linked");expect(html).toContain("Checking the accounting connection");
  });
  it("keeps incomplete extraction visible and cannot enable bill approval",()=>{
    const f=apUIFixture();f.candidate=null;f.extraction={status:"failed",evidence:[],reasons:["Page 2 missing"]};f.amounts.invoicedCents=null;
    const html=renderToStaticMarkup(<APMatching detail={f}/>)+renderToStaticMarkup(<APActions detail={f} busy={false} onBusy={()=>{}} onChanged={()=>{}}/>);
    expect(html).toContain("Page 2 missing");expect(html).toContain("Incomplete extraction cannot be approved");expect(html).toMatch(/disabled="">Approve bill<\/button>/);
  });
  it("rejects a raster returned for the wrong original hash",async()=>{
    configureAPSession({mode:"local"});
    const f=apUIFixture(),s=f.sources[0]!;
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("raster",{headers:{"Content-Type":"image/png","X-AP-Source-SHA256":"wrong","X-AP-Source-Revision":"1","X-AP-Page":"1"}})));
    await expect(loadPage(s,1,new AbortController().signal)).rejects.toThrow(/does not match/);
    expect(apPageUrl(s,1)).toContain(`sha256=${s.sha256}`);
  });
  it("rejects payment read models from another run or obligation",()=>{
    const f=apUIFixture();f.links.billId="bill-ui";
    const snapshot={scope:f.scope,bills:[{billId:"bill-ui",version:1,amountCents:10550}],credits:[],amountCents:10550,currency:"USD" as const,destination:{externalAccountId:"destination",version:"v1"},policyVersion:f.policyVersion};
    expect(paymentBelongsToCase(f,snapshot)).toBe(true);
    expect(paymentBelongsToCase(f,{...snapshot,scope:{...snapshot.scope,runId:"another-run"}})).toBe(false);
    expect(paymentBelongsToCase(f,{...snapshot,bills:[{billId:"unrelated-bill",version:1,amountCents:10550}]})).toBe(false);
  });
  it("uses the distinct authorize endpoint and both snapshots",async()=>{
    configureAPSession({mode:"local"});
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({commandId:"effect"}),{headers:{"Content-Type":"application/json"}}));vi.stubGlobal("fetch",fetcher);
    const input={expectedRevision:3,snapshotHash:"case-hash",paymentSnapshotHash:"payment-hash"};
    await apSystemApi.authorizePayment("case /1","version /2",input);
    expect(fetcher.mock.calls[0]![0]).toBe("/api/ap-system/cases/case%20%2F1/payments/version%20%2F2/authorize");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({method:"POST",credentials:"same-origin",body:JSON.stringify(input)});
    expect(new Headers(fetcher.mock.calls[0]![1].headers).get("X-AP-System-Session")).toBe("1");
  });
});
