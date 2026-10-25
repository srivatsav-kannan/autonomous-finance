import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APSystemWorkspace, APCaseStatus, APActions, APMatching, APAccounting } from "../console/src/APSystemWorkspace";
import { APSystemEvidence, EvidencePage } from "../console/src/APSystemEvidence";
import { apFieldLabel, apFieldValue, apMoney, displayedFrame, regionPolygon, reviewPayload, sourceForEvidence, paymentBelongsToCase } from "../console/src/apSystemView";
import { apPageUrl, apSystemApi, loadPage } from "../console/src/apSystemApi";
import { apUIFixture, uiEvidence } from "./ap-system-ui.fixture";

afterEach(()=>vi.unstubAllGlobals());
describe("AP case workspace evidence boundaries",()=>{
  it("keeps direct-link detail and upload gated while the initial session is loading",()=>{
    vi.stubGlobal("window",{location:{search:"?case=cold-session-case"}});
    const html=renderToStaticMarkup(<APSystemWorkspace/>);
    expect(html).toContain("Loading linked case evidence");
    expect(html).toMatch(/disabled="" aria-expanded="false">Upload documents<\/button>/);
    expect(html).not.toContain("Case unavailable");
    expect(html).not.toContain("No AP cases yet");
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
    expect(html.match(/<option /g)).toHaveLength(35);
    expect(html).toContain('type="search"');
    expect(html).toContain('role="region" aria-label="Field search results" tabindex="0"');
    expect(html).toContain("Line 4 / Unit price");
    expect(html).toContain("Derived location");
    expect(html).toContain("Location unresolved");
    expect(html).toContain("Selected source evidence");
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
    expect(html).toContain("Recognized");expect(html).toContain("Awaiting approval");expect(html).toContain("No journal entry is linked");expect(html).toContain("Not connected / not run");
  });
  it("keeps incomplete extraction visible and cannot enable bill approval",()=>{
    const f=apUIFixture();f.candidate=null;f.extraction={status:"failed",evidence:[],reasons:["Page 2 missing"]};f.amounts.invoicedCents=null;
    const html=renderToStaticMarkup(<APMatching detail={f}/>)+renderToStaticMarkup(<APActions detail={f} busy={false} onBusy={()=>{}} onChanged={()=>{}}/>);
    expect(html).toContain("Page 2 missing");expect(html).toContain("Incomplete extraction cannot be approved");expect(html).toMatch(/disabled="">Approve bill<\/button>/);
  });
  it("rejects a raster returned for the wrong original hash",async()=>{
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
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({commandId:"effect"}),{headers:{"Content-Type":"application/json"}}));vi.stubGlobal("fetch",fetcher);
    const input={expectedRevision:3,snapshotHash:"case-hash",paymentSnapshotHash:"payment-hash"};
    await apSystemApi.authorizePayment("case /1","version /2",input);
    expect(fetcher.mock.calls[0]![0]).toBe("/api/ap-system/cases/case%20%2F1/payments/version%20%2F2/authorize");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({method:"POST",credentials:"same-origin",body:JSON.stringify(input),headers:{"X-AP-System-Session":"1"}});
  });
});
