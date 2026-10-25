import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AddressInfo } from "node:net";
import { APAccountingReceipt } from "../../console/src/APSystemQuickBooks";
import { closeSyncPermissions, APCloseSyncReadiness } from "../../console/src/APSystemCloseQuickBooks";
import { configureAPSession } from "../../console/src/apAuthSession";
import { apSystemApi } from "../../console/src/apSystemApi";
import { createAPSystemServer, type APWorkspaceService } from "../../src/ap-system/server";
import type { QBOCloseStatus } from "../../src/ap-system/quickbooks/close-runtime";
import type { QBOReceipt } from "../../src/ap-system/quickbooks/runtime";

const servers: ReturnType<typeof createAPSystemServer>[] = [];
afterEach(async()=>{configureAPSession(null);vi.unstubAllGlobals();await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>{s.closeAllConnections();s.close(()=>r());})));});
const status: QBOCloseStatus = {authority:"historical_receipt_only",externalReadsAllowed:true,externalWritesAllowed:true,configuration:"configured",grant:"available",mappings:"configured",exportId:"tax_reclassification:journal-v14",receipts:[],holds:[],complete:true,externalVerification:"not_checked"};
const receipt: QBOReceipt = {entity:"JournalEntry",requestId:"v14-old-request",state:"unknown",externalId:null,syncToken:null,updatedAt:1,lastError:null,links:{caseId:"case",billId:"bill",recognitionJournalId:"journal",paymentVersionId:null,commandId:null,bankTransactionId:null,settlementJournalId:null,creditId:null,closeActionId:"tax-action",closeExportId:"tax_reclassification:journal-v14"}};

it("V14 historical UI authority dominates all contradictory configuration, grant and write flags",()=>{
  for(const configuration of ["not_configured","incomplete","configured"] as const) for(const grant of ["authorization_required","available"] as const) for(const externalWritesAllowed of [true,false]) {
    expect(closeSyncPermissions({...status,configuration,grant,externalWritesAllowed})).toEqual({preview:false,submit:false,read:true});
    expect(closeSyncPermissions({...status,configuration,grant,externalWritesAllowed,externalReadsAllowed:false})).toEqual({preview:false,submit:false,read:false});
  }
  const html=renderToStaticMarkup(<APCloseSyncReadiness status={status}/>);
  expect(html).toContain("Historical receipt access only");expect(html).toContain("cannot create or resend");expect(html).not.toContain("unsupported in Local FakeBank");
});
it("V14 receipt action states never turn a prepared, rejected or conflicted record into recovery",()=>{
  for(const state of ["prepared","rejected","conflict"] as const){const html=renderToStaticMarkup(<APAccountingReceipt receipt={{...receipt,state}} busy={false} canVerify canRecover onVerify={()=>{}}/>);expect(html).not.toContain("Recover existing external request");expect(html).not.toContain("Verify external readback");}
  for(const state of ["sending","unknown"] as const){const html=renderToStaticMarkup(<APAccountingReceipt receipt={{...receipt,state}} busy canVerify canRecover onVerify={()=>{}}/>);expect(html).toContain('disabled="">Recover existing external request');}
});
it("V14 browser recovery sends only the action selector and current session, never a receipt or authorizer",async()=>{
 const calls: {url:string;init:RequestInit}[]=[];vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{calls.push({url,init});return new Response(JSON.stringify({hold:{code:"unknown_not_found_no_repost"}}));}));
 configureAPSession({mode:"auth0",token:async()=>"v14-synthetic-current-token",expired:()=>{}});
 await apSystemApi.closeAccountingVerify({actionId:"tax-action"});
 expect(calls).toHaveLength(1);expect(calls[0]!.url).toBe("/api/ap-system/close/accounting/verify");expect(JSON.parse(String(calls[0]!.init.body))).toEqual({request:{actionId:"tax-action"}});
 expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer v14-synthetic-current-token");
 expect(()=>apSystemApi.closeAccountingVerify({actionId:"tax-action",subject:"old-writer"} as any)).toThrow();expect(calls).toHaveLength(1);
});
it("V14 changing login while the browser obtains a token prevents recovery dispatch",async()=>{
 let finish!: (s:string)=>void;const token=new Promise<string>(r=>{finish=r;}), fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
 configureAPSession({mode:"auth0",token:()=>token,expired:()=>{}});const pending=apSystemApi.closeAccountingVerify({actionId:"tax-action"});
 configureAPSession({mode:"auth0",token:async()=>"new-synthetic-token",expired:()=>{}});finish("old-synthetic-token");
 await expect(pending).rejects.toMatchObject({code:"session_changed"});expect(fetcher).not.toHaveBeenCalled();
});
it("V14 HTTP recovery reauthenticates the current subject and refuses stale cookies or caller-controlled authority",async()=>{
 const verify=vi.fn(async()=>({operation:receipt,verifiedAt:1})),submit=vi.fn(),preview=vi.fn(),readStatus=vi.fn();
 const service={list:async()=>[],runtime:()=>({}),closeAccounting:{verify,submit,preview,status:readStatus}} as unknown as APWorkspaceService;
 const subjects:string[]=[];
 const server=createAPSystemServer({runtime:()=>({})},{port:0,runId:"v14-http",storageRoot:"/private/tmp",allowedOrigins:["http://127.0.0.1:5194"],auth:{publicConfig:{mode:"auth0",domain:"synthetic.example",clientId:"v14"},authenticate:async token=>{subjects.push(token);return {subject:token,issuer:"synthetic",approved:true,service};}}});servers.push(server);
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ap-system`;
 const opened=await fetch(base+"/cases",{headers:{Authorization:"Bearer reader-one"}}),cookie=opened.headers.get("set-cookie")!.split(";")[0]!;
 const headers={Authorization:"Bearer reader-one",cookie,origin:"http://127.0.0.1:5194","Content-Type":"application/json","X-AP-System-Session":"1"};
 const post=(body:unknown,h=headers)=>fetch(base+"/close/accounting/verify",{method:"POST",headers:h,body:JSON.stringify(body)});
 expect((await post({request:{actionId:"tax-action"}},{...headers,Authorization:"Bearer reader-two"})).status).toBe(403);
 for(const body of [{request:{actionId:"tax-action",scope:{runId:"forged"}}},{request:{actionId:"tax-action"},subject:"old-authorizer"},{request:{actionId:"tax-action"},operation:receipt}]) expect((await post(body)).status).toBe(400);
 expect(verify).not.toHaveBeenCalled();
 expect((await post({request:{actionId:"tax-action"}})).status).toBe(200);expect(verify).toHaveBeenCalledExactlyOnceWith({actionId:"tax-action"});expect(submit).not.toHaveBeenCalled();expect(preview).not.toHaveBeenCalled();expect(readStatus).not.toHaveBeenCalled();
 expect(subjects).toEqual(["reader-one","reader-two","reader-one","reader-one","reader-one","reader-one"]);
});
