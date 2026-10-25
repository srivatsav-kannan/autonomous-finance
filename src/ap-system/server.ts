import http, {type IncomingMessage,type ServerResponse} from "node:http";
import {createHash,randomBytes,timingSafeEqual} from "node:crypto";
import {readFile,realpath} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {billApprovalRequestSchema,reviewRequestSchema,type APCaseDetail,type APIntake,type SourceDocument,type CoordinateFrame} from "./contracts";

const PREFIX="/api/ap-system";
const MAX_BYTES=25*1024*1024;
export class APHttpError extends Error {constructor(readonly code:string,readonly status:number,reason:string){super(reason);}}
export type UploadDocument={bytes:Uint8Array;name:string;mimeType:string;kind:SourceDocument["kind"]};
export interface APWorkspaceService {
 list():Promise<APCaseDetail[]>;
 detail(caseId:string):Promise<APCaseDetail>;
 ingest(input:APIntake):Promise<{caseId:string}>;
 parseUploads(input:{uploads:UploadDocument[];idempotencyKey:string;explicitRevisionOf?:string|null}):Promise<APIntake>;
 review(input:z.infer<typeof reviewRequestSchema>):Promise<unknown>;
 approve(input:z.infer<typeof billApprovalRequestSchema>):Promise<unknown>;
 requestPayment(input:{caseId:string;expectedRevision:number;snapshotHash:string;idempotencyKey:string}):Promise<unknown>;
 authorizePayment(input:{caseId:string;versionId:string;expectedRevision:number;snapshotHash:string;paymentSnapshotHash:string}):Promise<unknown>;
 paymentDetail(versionId:string):Promise<unknown>;
 source(sourceId:string,revision:number,sha256:string):Promise<SourceDocument>;
 renderPage?(source:SourceDocument,page:number):Promise<{bytes:Uint8Array;mimeType:"image/png";frame:CoordinateFrame}>;
 runtime():unknown;
}
const privateProcessor=(p:unknown)=>{if(!p||typeof p!=="object")return p;return {...p,configArtifact:null,rawArtifact:null,tokenArtifact:null,rasterArtifact:null};};
/** Keep originals and provider artifacts on the server. Version/hash stay visible. */
export function publicCase(detail:APCaseDetail):APCaseDetail {
 const copy=structuredClone(detail);
 for(const s of copy.sources){s.originalRef="authenticated_source_route";delete s.originalBase64;if(s.parser)s.parser=privateProcessor(s.parser) as typeof s.parser;}
 for(const e of [...(copy.candidate?.evidence??[]),...copy.extraction.evidence])e.grounding.processor=privateProcessor(e.grounding.processor) as typeof e.grounding.processor;
 return copy;
}
async function bodyBytes(req:IncomingMessage){let n=0;const parts:Buffer[]=[];for await(const data of req){const b=Buffer.from(data);n+=b.length;if(n>MAX_BYTES)throw new APHttpError("body_too_large",413,"Upload exceeds 25 MiB.");parts.push(b);}return Buffer.concat(parts);}
async function json(req:IncomingMessage){if(!/^application\/json(?:;|$)/i.test(req.headers["content-type"]??""))throw new APHttpError("json_required",415,"Use application/json.");try{return JSON.parse((await bodyBytes(req)).toString("utf8"));}catch(e){if(e instanceof APHttpError)throw e;throw new APHttpError("invalid_json",400,"Request is not valid JSON.");}}
function send(res:ServerResponse,value:unknown,status=200){res.statusCode=status;res.setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify(value));}
const binding=z.object({expectedRevision:z.number().int().positive(),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/)});
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
export function createAPSystemServer(service:APWorkspaceService,options:{port:number;runId:string;storageRoot:string;allowedOrigins:string[]}){
 const cookieName=`ap_system_${createHash("sha256").update(options.runId).digest("hex").slice(0,16)}`;
 const session=randomBytes(32).toString("hex");const origins=new Set(options.allowedOrigins);
 const sessionValid=(req:IncomingMessage)=>{const value=(req.headers.cookie??"").split(/;\s*/).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);return !!value&&value.length===session.length&&timingSafeEqual(Buffer.from(value),Buffer.from(session));};
 const server=http.createServer(async(req,res)=>{
  res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","no-referrer");
  try{
   if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(req.socket.remoteAddress??""))throw new APHttpError("forbidden",403,"Loopback access required.");
   const url=new URL(req.url??"/",`http://${req.headers.host}`);
   if(!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||url.username||url.password)throw new APHttpError("host_forbidden",403,"Loopback host required.");
   const origin=req.headers.origin;
   if((origin&&!origins.has(origin))||req.headers["sec-fetch-site"]==="cross-site")throw new APHttpError("origin_forbidden",403,"Origin is not allowed.");
   if(!url.pathname.startsWith(PREFIX+"/"))throw new APHttpError("not_found",404,"Unknown AP route.");
   if(req.method!=="GET"&&(!origin||!origins.has(origin)||!sessionValid(req)||req.headers["x-ap-system-session"]!=="1"))throw new APHttpError("session_required",403,"Open the AP workspace before making changes.");
   if(req.method==="GET"&&url.pathname===PREFIX+"/runtime")return send(res,service.runtime());
   if(req.method==="GET"&&url.pathname===PREFIX+"/cases"){
    const cases=await service.list();res.setHeader("Set-Cookie",`${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=${PREFIX}; Max-Age=28800`);return send(res,cases.map(publicCase));
   }
   // Only the session-establishing collection and attestation routes are public on loopback.
   if(req.method==="GET"&&!sessionValid(req))throw new APHttpError("session_required",403,"Open the AP workspace before reading source or case details.");
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
    const uploads=await Promise.all((files as File[]).map(async(f,i)=>({bytes:new Uint8Array(await f.arrayBuffer()),name:f.name,mimeType:f.type||"application/octet-stream",kind:kinds[i]!})));
    const idempotencyKey=z.string().trim().min(1).max(200).parse(form.get("idempotencyKey"));
    const explicitRevisionOf=form.get("explicitRevisionOf")?z.string().min(1).parse(form.get("explicitRevisionOf")):null;
    const input=await service.parseUploads({uploads,idempotencyKey,explicitRevisionOf});return send(res,await service.ingest(input),201);
   }
   const match=/^\/api\/ap-system\/cases\/([^/]+)(?:\/(review|approve|payments)(?:\/([^/]+)\/(authorize))?)?$/.exec(url.pathname);
   if(match){const caseId=decodeURIComponent(match[1]!);
    if(req.method==="GET"&&!match[2])return send(res,publicCase(await service.detail(caseId)));
    if(req.method==="POST"){
     const data=await json(req);if(!data||typeof data!=="object"||Array.isArray(data))throw new APHttpError("invalid_request",400,"Object request required.");
     if(match[2]==="review")return send(res,await service.review(reviewRequestSchema.parse({...data,caseId})));
     if(match[2]==="approve")return send(res,await service.approve(billApprovalRequestSchema.parse({...data,caseId})));
     if(match[2]==="payments"&&!match[3])return send(res,await service.requestPayment({...binding.extend({idempotencyKey:z.string().trim().min(1)}).parse(data),caseId}));
     if(match[2]==="payments"&&match[3]&&match[4])return send(res,await service.authorizePayment({...binding.extend({paymentSnapshotHash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(data),caseId,versionId:decodeURIComponent(match[3])}));
    }
   }
   const payment=/^\/api\/ap-system\/payments\/([^/]+)$/.exec(url.pathname);if(req.method==="GET"&&payment)return send(res,await service.paymentDetail(decodeURIComponent(payment[1]!)));
   throw new APHttpError("not_found",404,"Unknown AP route.");
  }catch(e){
   if(res.headersSent){res.end();return;}
   const status=e instanceof APHttpError?e.status:e instanceof z.ZodError?400:409;
   // Convex error messages contain stable business reasons; redact provider/transport error bodies.
   const reason=e instanceof APHttpError?e.message:e instanceof z.ZodError?"Request does not match the AP contract.":"The backend rejected this action or is unavailable. Refresh the case and review its current evidence.";
   send(res,{error:{code:e instanceof APHttpError?e.code:e instanceof z.ZodError?"invalid_request":"backend_rejected",reason}},status);
  }
 });
 server.requestTimeout=180_000;server.headersTimeout=10_000;return server;
}
