import {contactChangeOperationSchemas,type ContactChangeOperation} from "./supplier-contact-contracts";
import type {SupplierContactOperations} from "./supplier-contact-operations";
import type {OperationalTimings} from "./operational-timing";
import {closeExportRequestSchema} from "./close-contracts";
import type {QBOCloseBridge} from "./quickbooks/close-runtime";
import http, {type IncomingMessage,type ServerResponse} from "node:http";
import {createHash,randomBytes,timingSafeEqual} from "node:crypto";
import {readFile,realpath} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {ConvexError} from "convex/values";
import {billApprovalRequestSchema,reviewRequestSchema,type APCaseDetail,type APIntake,type SourceDocument,type CoordinateFrame} from "./contracts";

import type { PaymentRunOperations, AccountingOperations } from "./workspace-operations";
import { domainOperationSchemas, type DomainOperations, type DomainOperation } from "./domain-operations";
import { closeOperationSchemas, periodSchema, type CloseOperations, type CloseOperation } from "./close-operations";
import {accountingCorrectionRequestSchema,domainVoteSchema,type CorrectionOperations} from "./correction-operations";
import { QboError } from "./quickbooks/private-store";
const PREFIX="/api/ap-system";
const MAX_ORIGINAL_BYTES=8*1024*1024;
const MAX_BYTES=MAX_ORIGINAL_BYTES+64*1024;
export class APHttpError extends Error {constructor(readonly code:string,readonly status:number,reason:string){super(reason);}}
export type UploadDocument={bytes:Uint8Array;name:string;mimeType:string;kind:SourceDocument["kind"]};
export interface APWorkspaceService {
 list():Promise<APCaseDetail[]>;
 detail(caseId:string):Promise<APCaseDetail>;
 ingest(input:APIntake):Promise<{caseId:string}>;
 parseUploads(input:{uploads:UploadDocument[];idempotencyKey:string;explicitRevisionOf?:string|null}):Promise<APIntake>;
 review(input:z.infer<typeof reviewRequestSchema>):Promise<unknown>;
 approve(input:z.infer<typeof billApprovalRequestSchema>):Promise<unknown>;
 requestPayment(input:{caseId:string;expectedRevision:number;snapshotHash:string;idempotencyKey:string;executionDate?:string;amountCents?:number;credits?:{creditId:string;amountCents:number}[]}):Promise<unknown>;
 authorizePayment(input:{caseId:string;versionId:string;expectedRevision:number;snapshotHash:string;paymentSnapshotHash:string}):Promise<unknown>;
 cancelPayment(input:{caseId:string;versionId:string;expectedRevision:number;snapshotHash:string}):Promise<unknown>;
 paymentDetail(versionId:string):Promise<unknown>;
 source(sourceId:string,revision:number,sha256:string):Promise<SourceDocument>;
 renderPage?(source:SourceDocument,page:number):Promise<{bytes:Uint8Array;mimeType:"image/png";frame:CoordinateFrame}>;
 paymentRuns?:PaymentRunOperations;
 accounting?:AccountingOperations;
 domain?:DomainOperations;
 close?:CloseOperations;
 closeAccounting?:QBOCloseBridge;
 corrections?:CorrectionOperations;
 operationalTimings?():Promise<OperationalTimings>;
 supplierContacts?:SupplierContactOperations;
 runtime():unknown;
}
export type APExternalAuthentication = {
 publicConfig:{mode:"auth0";domain:string;clientId:string}|{mode:"local_simulation";actors:{id:string;name:string}[]};
 authenticate:(token:string)=>Promise<{subject:string;issuer:string;approved:boolean;service:APWorkspaceService}>;
};
const privateProcessor=(p:unknown)=>{if(!p||typeof p!=="object")return p;return {...p,configArtifact:null,rawArtifact:null,tokenArtifact:null,rasterArtifact:null};};
/** Keep originals and provider artifacts on the server. Version/hash stay visible. */
export function publicCase(detail:APCaseDetail):APCaseDetail {
 const copy=structuredClone(detail);
 for(const s of copy.sources){s.originalRef="authenticated_source_route";delete s.originalBase64;if(s.parser)s.parser=privateProcessor(s.parser) as typeof s.parser;}
 for(const e of [...(copy.candidate?.evidence??[]),...copy.extraction.evidence])e.grounding.processor=privateProcessor(e.grounding.processor) as typeof e.grounding.processor;
 return copy;
}
async function bodyBytes(req:IncomingMessage){let n=0;const parts:Buffer[]=[];for await(const data of req){const b=Buffer.from(data);n+=b.length;if(n>MAX_BYTES)throw new APHttpError("body_too_large",413,"Upload exceeds the 8 MiB original-file limit.");parts.push(b);}return Buffer.concat(parts);}
async function json(req:IncomingMessage){if(!/^application\/json(?:;|$)/i.test(req.headers["content-type"]??""))throw new APHttpError("json_required",415,"Use application/json.");try{return JSON.parse((await bodyBytes(req)).toString("utf8"));}catch(e){if(e instanceof APHttpError)throw e;throw new APHttpError("invalid_json",400,"Request is not valid JSON.");}}
function send(res:ServerResponse,value:unknown,status=200){res.statusCode=status;res.setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify(value));}
const binding=z.object({expectedRevision:z.number().int().positive(),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/)});
const executionDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value,"Valid calendar date required");
const positiveCents=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const paymentRequest=binding.extend({idempotencyKey:z.string().trim().min(1),executionDate:executionDate.optional(),amountCents:positiveCents.optional(),credits:z.array(z.object({creditId:z.string().trim().min(1),amountCents:positiveCents})).refine(rows=>new Set(rows.map(r=>r.creditId)).size===rows.length,"Duplicate credit reference").optional()});
const kind=z.enum(["invoice","purchase_order","receipt","contract","credit_note","correction","other"]);
async function originalBytes(source:SourceDocument,storageRoot:string){
 let bytes:Buffer;
 if(source.originalBase64)bytes=Buffer.from(source.originalBase64,"base64");
 else{
  const root=await realpath(storageRoot);const candidate=await realpath(path.resolve(source.originalRef));
  if(!candidate.startsWith(root+path.sep))throw new APHttpError("source_unavailable",404,"Original is outside the owned source store.");
  bytes=await readFile(candidate);
 }
 if(bytes.length!==source.byteLength||createHash("sha256").update(bytes).digest("hex")!==source.sha256)throw new APHttpError("source_integrity",409,"Original bytes no longer match this source revision.");
 return bytes;
}
export function createAPSystemServer(baseService:Pick<APWorkspaceService,"runtime">,options:{port:number;runId:string;storageRoot:string;allowedOrigins:string[];auth?:APExternalAuthentication}){
 if(!options.auth && !("list" in baseService))throw new Error("Local AP service is missing its implementation");
 const cookieName=`ap_system_${createHash("sha256").update(options.runId).digest("hex").slice(0,16)}`;
 const session=randomBytes(32).toString("hex");const origins=new Set(options.allowedOrigins);
 const externalSessions=new Map<string,{subject:string;expiresAt:number}>();
 const cookieValue=(req:IncomingMessage)=>(req.headers.cookie??"").split(/;\s*/).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
 const sessionValid=(req:IncomingMessage,subject?:string)=>{
  if(options.auth){const saved=externalSessions.get(cookieValue(req)??"");return !!saved && saved.subject===subject && saved.expiresAt>Date.now();}const value=(req.headers.cookie??"").split(/;\s*/).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);return !!value&&value.length===session.length&&timingSafeEqual(Buffer.from(value),Buffer.from(session));};
 const server=http.createServer(async(req,res)=>{
  res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","no-referrer");
  try{
   if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(req.socket.remoteAddress??""))throw new APHttpError("forbidden",403,"Loopback access required.");
   const url=new URL(req.url??"/",`http://${req.headers.host}`);
   if(!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||url.username||url.password)throw new APHttpError("host_forbidden",403,"Loopback host required.");
   const origin=req.headers.origin;
   if((origin&&!origins.has(origin))||req.headers["sec-fetch-site"]==="cross-site")throw new APHttpError("origin_forbidden",403,"Origin is not allowed.");
   if(!url.pathname.startsWith(PREFIX+"/"))throw new APHttpError("not_found",404,"Unknown AP route.");
   if(req.method==="GET"&&url.pathname===PREFIX+"/runtime")return send(res,options.auth ? {...baseService.runtime() as object,auth:options.auth.publicConfig} : baseService.runtime());
   let service=baseService as APWorkspaceService;
   let subject:string|undefined;
   if(options.auth){
    const authorization=req.headers.authorization;
    if(!authorization || !/^Bearer [^\s]+$/.test(authorization) || authorization.length>16_384)throw new APHttpError("authentication_required",401,"Sign in to access the AP workspace.");
    const context=await options.auth.authenticate(authorization.slice(7));
    subject=context.subject;service=context.service;
    if(req.method==="GET"&&url.pathname===PREFIX+"/whoami")return send(res,{tokenIdentifier:subject,issuer:context.issuer,approved:context.approved});
    if(req.method!=="POST"||url.pathname!==PREFIX+"/logout")if(!context.approved)throw new APHttpError("owner_binding_required",403,"Your signed-in identity has not been approved for this AP workspace.");
   }
   if(req.method!=="GET"&&(!origin||!origins.has(origin)||!sessionValid(req,subject)||req.headers["x-ap-system-session"]!=="1"))throw new APHttpError("session_required",403,"Open the AP workspace before making changes.");
   if(req.method==="GET"&&url.pathname===PREFIX+"/cases"){
    const cases=await service.list();
    let value=session;
    if(options.auth){
     for(const [key,saved] of externalSessions)if(saved.expiresAt<=Date.now())externalSessions.delete(key);
     value=sessionValid(req,subject)?cookieValue(req)!:randomBytes(32).toString("hex");
     externalSessions.set(value,{subject:subject!,expiresAt:Date.now()+8*60*60*1000});
    }
    res.setHeader("Set-Cookie",`${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=${PREFIX}; Max-Age=28800`);return send(res,cases.map(publicCase));
   }
   if(req.method==="POST"&&url.pathname===PREFIX+"/logout"&&options.auth){
    externalSessions.delete(cookieValue(req)??"");res.setHeader("Set-Cookie",`${cookieName}=; HttpOnly; SameSite=Strict; Path=${PREFIX}; Max-Age=0`);return send(res,{ok:true});
   }
   // A browser cookie alone never authenticates an external human.
   if(req.method==="GET"&&!sessionValid(req,subject))throw new APHttpError("session_required",403,"Open the AP workspace before reading source or case details.");
   if(req.method==="GET"&&url.pathname===PREFIX+"/metrics"){
    if(!service.operationalTimings)throw new APHttpError("capability_unavailable",503,"Operational event timings are unavailable on this service.");
    return send(res,await service.operationalTimings());
   }
   const contacts=/^\/api\/ap-system\/supplier-contacts(?:\/([a-z]+))?$/.exec(url.pathname);
   if(contacts){
    if(!service.supplierContacts)throw new APHttpError("capability_unavailable",503,"Supplier contact change review is unavailable on this service.");
    if(req.method==="GET"&&!contacts[1])return send(res,await service.supplierContacts.view());
    if(req.method==="POST"&&contacts[1]&&Object.hasOwn(contactChangeOperationSchemas,contacts[1])){
     const operation=contacts[1] as ContactChangeOperation;
     return send(res,await service.supplierContacts.execute(operation,contactChangeOperationSchemas[operation].parse(await json(req))));
    }
   }
   const creditApplication=/^\/api\/ap-system\/cases\/([^/]+)\/credit-applications\/([^/]+)$/.exec(url.pathname);
   if(req.method==="GET"&&creditApplication){
    if(!service.corrections)throw new APHttpError("capability_unavailable",503,"Credit application evidence is unavailable.");
    const id=z.string().trim().min(1).max(180);
    return send(res,await service.corrections.creditApplication(id.parse(decodeURIComponent(creditApplication[1]!)),id.parse(decodeURIComponent(creditApplication[2]!))));
   }
   const costState=/^\/api\/ap-system\/close\/cost-state\/([^/]+)$/.exec(url.pathname);
   if(req.method==="GET"&&costState){
    if(!service.close)throw new APHttpError("capability_unavailable",503,"Current cost allocation evidence is unavailable.");
    const originalEntryId=z.string().trim().min(1).max(240).parse(decodeURIComponent(costState[1]!));
    return send(res,await service.close.costState(originalEntryId));
   }
   const close=/^\/api\/ap-system\/close\/([^/]+)$/.exec(url.pathname);
   if(close){
    if(!service.close)throw new APHttpError("capability_unavailable",503,"Period close is not available on this AP service.");
    if(req.method==="GET")return send(res,await service.close.view(periodSchema.parse(decodeURIComponent(close[1]!))));
    if(req.method==="POST"&&Object.hasOwn(closeOperationSchemas,close[1]!)){
     const operation=close[1] as CloseOperation,data=await json(req);
     if(data&&typeof data==="object"&&["actor","subject","scope","seatId","token","approvedBy"].some(k=>k in data))throw new APHttpError("invalid_request",400,"Caller identity and scope cannot be supplied in close requests.");
     return send(res,await service.close.execute(operation,closeOperationSchemas[operation].parse(data)));
    }
   }
   const closeAccounting=/^\/api\/ap-system\/close\/accounting\/(status|preview|submit|verify)$/.exec(url.pathname);
   if(req.method==="POST"&&closeAccounting){
    if(!service.closeAccounting)throw new APHttpError("capability_unavailable",503,"Period accounting synchronization is unavailable.");
    const body=z.object({request:closeExportRequestSchema.strict(),expectedPlanHash:binding.shape.snapshotHash.optional()}).strict().parse(await json(req));
    if(closeAccounting[1]==="submit"){if(!body.expectedPlanHash)throw new APHttpError("approved_preview_required",400,"Preview and confirm the current period accounting plan first.");return send(res,await service.closeAccounting.submit(body.request,body.expectedPlanHash));}
    return send(res,await service.closeAccounting[closeAccounting[1] as "status"|"preview"|"verify"](body.request));
   }
   const domain=/^\/api\/ap-system\/business(?:\/([a-zA-Z]+))?$/.exec(url.pathname);
   if(domain){
    if(!service.domain)throw new APHttpError("capability_unavailable",503,"Business governance is not available on this AP service.");
    if(req.method==="GET"&&!domain[1])return send(res,await service.domain.view());
    if(req.method==="GET"&&domain[1]==="proposals")return send(res,await service.domain.proposals());
    if(req.method==="POST"&&domain[1]&&Object.hasOwn(domainOperationSchemas,domain[1])){
     const operation=domain[1] as DomainOperation, data=await json(req);
     // Identity, scope and agent credentials are server-owned for every operation.
     if(data&&typeof data==="object"&&["actor","subject","scope","seatId","token","approvedBy"].some(k=>k in data))throw new APHttpError("invalid_request",400,"Caller identity and scope cannot be supplied in business requests.");
     return send(res,await service.domain.execute(operation,domainOperationSchemas[operation].parse(data)));
    }
   }
   const runs=/^\/api\/ap-system\/payment-runs(?:\/([^/]+)(?:\/(authorize|cancel))?)?$/.exec(url.pathname);
   if(runs){
    if(!service.paymentRuns)throw new APHttpError("capability_unavailable",503,"Payment runs are not available on this AP service.");
    if(req.method==="GET"&&!runs[1])return send(res,await service.paymentRuns.list());
    if(req.method==="GET"&&runs[1]&&!runs[2])return send(res,await service.paymentRuns.detail(decodeURIComponent(runs[1])));
    if(req.method==="POST"&&!runs[1]){
     const selection=paymentRequest.omit({idempotencyKey:true,executionDate:true}).extend({caseId:z.string().min(1)});
     const input=z.object({requestKey:z.string().trim().min(1).max(200),selection:z.array(selection).min(1).max(25).refine(items=>new Set(items.map(i=>i.caseId)).size===items.length),executionDate:executionDate.optional()}).parse(await json(req));
     return send(res,await service.paymentRuns.prepare(input));
    }
    if(req.method==="POST"&&runs[1]&&runs[2]){const input={...z.object({snapshotHash:binding.shape.snapshotHash}).parse(await json(req)),runId:decodeURIComponent(runs[1])};return send(res,await service.paymentRuns[runs[2] as "authorize"|"cancel"](input));}
   }
   const correction=/^\/api\/ap-system\/cases\/([^/]+)\/corrections(?:\/(propose|vote))?$/.exec(url.pathname);
   if(correction){
    if(!service.corrections)throw new APHttpError("capability_unavailable",503,"Accounting correction approvals are not available on this AP service.");
    const caseId=decodeURIComponent(correction[1]!);
    if(req.method==="GET"&&!correction[2])return send(res,await service.corrections.list(caseId));
    if(req.method==="POST"&&correction[2]){
     const data=await json(req);
     if(correction[2]==="propose"){const input=accountingCorrectionRequestSchema.parse(data);if(input.caseId!==caseId)throw new APHttpError("case_mismatch",400,"The correction must belong to the selected case.");return send(res,await service.corrections.propose(input));}
     return send(res,await service.corrections.vote(caseId,domainVoteSchema.strict().parse(data)));
    }
   }
   const accounting=/^\/api\/ap-system\/cases\/([^/]+)\/accounting(?:\/(preview|submit|verify))?$/.exec(url.pathname);
   if(accounting){
    if(!service.accounting)throw new APHttpError("capability_unavailable",503,"QuickBooks accounting is not configured on this AP service.");
    const caseId=decodeURIComponent(accounting[1]!);
    if(req.method==="GET"&&!accounting[2])return send(res,await service.accounting.status(caseId));
    if(req.method==="POST"&&accounting[2]){
     const input=z.object({paymentVersionId:z.string().trim().min(1).optional(),creditApplicationId:z.string().trim().min(1).optional(),correctionId:z.string().trim().min(1).optional(),expectedPlanHash:binding.shape.snapshotHash.optional()}).strict().refine(value=>[value.paymentVersionId,value.creditApplicationId,value.correctionId].filter(Boolean).length<=1,"Choose exactly one accounting event selector").parse(await json(req));
     const request={caseId,...(input.paymentVersionId?{paymentVersionId:input.paymentVersionId}:{}),...(input.creditApplicationId?{creditApplicationId:input.creditApplicationId}:{}),...(input.correctionId?{correctionId:input.correctionId}:{})};
     if(accounting[2]==="submit"){if(!input.expectedPlanHash)throw new APHttpError("approved_preview_required",400,"Preview and confirm the current accounting plan before submitting.");return send(res,await service.accounting.submit(request,input.expectedPlanHash));}
     return send(res,await service.accounting[accounting[2] as "preview"|"verify"](request));
    }
   }
   const source=/^\/api\/ap-system\/sources\/([^/]+)\/revisions\/(\d+)(?:\/pages\/(\d+))?$/.exec(url.pathname);
   if(req.method==="GET"&&source){
    const sha=z.string().regex(/^[a-f0-9]{64}$/).parse(url.searchParams.get("sha256"));const revision=Number(source[2]);
    const doc=await service.source(decodeURIComponent(source[1]!),revision,sha);
    if(doc.sourceId!==decodeURIComponent(source[1]!)||doc.revision!==revision||doc.sha256!==sha)throw new APHttpError("source_binding",409,"Source revision does not match the requested evidence.");
    const original=await originalBytes(doc,options.storageRoot);
    res.setHeader("X-AP-Source-SHA256",sha);res.setHeader("X-AP-Source-Revision",revision);
    if(source[3]){
     const page=Number(source[3]);if(page<1||page>doc.pageCount)throw new APHttpError("page_not_found",404,"Page is outside this source.");
     if(!service.renderPage)throw new APHttpError("preview_unavailable",503,"Page renderer is unavailable; use original/text evidence.");
     const raster=await service.renderPage(doc,page);res.setHeader("Content-Type",raster.mimeType);res.setHeader("X-AP-Page",page);return res.end(raster.bytes);
    }
    // Untrusted XML/HTML/SVG must download rather than execute in the workspace origin.
    const inline=["application/pdf","image/png","image/jpeg","image/tiff","text/plain"].includes(doc.mimeType);
    res.setHeader("Content-Type",inline?doc.mimeType:"application/octet-stream");res.setHeader("Content-Disposition",`${inline?"inline":"attachment"}; filename*=UTF-8''${encodeURIComponent(path.basename(doc.name))}`);res.setHeader("Content-Security-Policy","sandbox");return res.end(original);
   }
   if(req.method==="POST"&&url.pathname===PREFIX+"/intake"){
    const type=req.headers["content-type"]??"";if(!type.startsWith("multipart/form-data;"))throw new APHttpError("multipart_required",415,"Upload original documents as multipart/form-data.");
    let form:FormData;try{form=await new Response(await bodyBytes(req),{headers:{"Content-Type":type}}).formData();}catch(e){if(e instanceof APHttpError)throw e;throw new APHttpError("invalid_upload",400,"Malformed upload.");}
    const files=form.getAll("documents");if(!files.length||files.length>10||files.some(f=>typeof f==="string"))throw new APHttpError("invalid_upload",400,"Supply one to ten original documents.");
    const kinds=z.array(kind).parse(JSON.parse(String(form.get("kinds"))));if(kinds.length!==files.length)throw new APHttpError("invalid_upload",400,"Every document must have a kind.");
    if((files as File[]).reduce((n,f)=>n+f.size,0)>MAX_ORIGINAL_BYTES)throw new APHttpError("body_too_large",413,"Original files exceed 8 MiB total.");
    const uploads=await Promise.all((files as File[]).map(async(f,i)=>({bytes:new Uint8Array(await f.arrayBuffer()),name:f.name,mimeType:f.type||"application/octet-stream",kind:kinds[i]!})));
    const idempotencyKey=z.string().trim().min(1).max(200).parse(form.get("idempotencyKey"));
    const explicitRevisionOf=form.get("explicitRevisionOf")?z.string().min(1).parse(form.get("explicitRevisionOf")):null;
    const input=await service.parseUploads({uploads,idempotencyKey,explicitRevisionOf});return send(res,await service.ingest(input),201);
   }
   const match=/^\/api\/ap-system\/cases\/([^/]+)(?:\/(review|approve|payments)(?:\/([^/]+)\/(authorize|cancel))?)?$/.exec(url.pathname);
   if(match){const caseId=decodeURIComponent(match[1]!);
    if(req.method==="GET"&&!match[2])return send(res,publicCase(await service.detail(caseId)));
    if(req.method==="POST"){
     const data=await json(req);if(!data||typeof data!=="object"||Array.isArray(data))throw new APHttpError("invalid_request",400,"Object request required.");
     if(match[2]==="review")return send(res,await service.review(reviewRequestSchema.parse({...data,caseId})));
     if(match[2]==="approve")return send(res,await service.approve(billApprovalRequestSchema.parse({...data,caseId})));
     if(match[2]==="payments"&&!match[3])return send(res,await service.requestPayment({...paymentRequest.parse(data),caseId}));
     if(match[2]==="payments"&&match[3]&&match[4]==="cancel")return send(res,await service.cancelPayment({...binding.parse(data),caseId,versionId:decodeURIComponent(match[3])}));
     if(match[2]==="payments"&&match[3]&&match[4]==="authorize")return send(res,await service.authorizePayment({...binding.extend({paymentSnapshotHash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(data),caseId,versionId:decodeURIComponent(match[3])}));
    }
   }
   const payment=/^\/api\/ap-system\/payments\/([^/]+)$/.exec(url.pathname);if(req.method==="GET"&&payment)return send(res,await service.paymentDetail(decodeURIComponent(payment[1]!)));
   throw new APHttpError("not_found",404,"Unknown AP route.");
  }catch(e){
   if(res.headersSent){res.end();return;}
   const business=e instanceof ConvexError ? z.object({code:z.string().max(100),reason:z.string().max(2000)}).safeParse(e.data) : null;
   const status=e instanceof APHttpError?e.status:e instanceof z.ZodError?400:409;
   // Convex error messages contain stable business reasons; redact provider/transport error bodies.
   const reason=business?.success?business.data.reason:e instanceof APHttpError?e.message:e instanceof QboError?`QuickBooks: ${e.code.replaceAll("_"," ")}. Refresh status and review the accounting setup.`:e instanceof z.ZodError?"Request does not match the AP contract.":"The backend rejected this action or is unavailable. Refresh the case and review its current evidence.";
   send(res,{error:{code:business?.success?business.data.code:e instanceof APHttpError?e.code:e instanceof QboError?e.code:e instanceof z.ZodError?"invalid_request":"backend_rejected",reason}},status);
  }
 });
 server.requestTimeout=180_000;server.headersTimeout=10_000;return server;
}
