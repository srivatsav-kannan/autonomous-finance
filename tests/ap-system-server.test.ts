import {afterEach,describe,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import type {AddressInfo} from "node:net";
import {createAPSystemServer,type APWorkspaceService} from "../src/ap-system/server";
import type {SourceDocument} from "../src/ap-system/contracts";
const servers:ReturnType<typeof createAPSystemServer>[]=[];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(resolve=>s.close(()=>resolve()));}});
async function fixture(){
 const data=Buffer.from('original invoice bytes');const sha=createHash('sha256').update(data).digest('hex');
 const doc={sourceId:'source-1',revision:1,sha256:sha,name:'invoice.txt',mimeType:'text/plain',originalBase64:data.toString('base64'),byteLength:data.length,pageCount:1} as SourceDocument;
 const service={list:vi.fn(async()=>[]),runtime:()=>({provider:'fake',identityMode:'simulated_human'}),source:vi.fn(async()=>doc),review:vi.fn(),approve:vi.fn(),detail:vi.fn(),ingest:vi.fn(),parseUploads:vi.fn(),requestPayment:vi.fn(),authorizePayment:vi.fn(),paymentDetail:vi.fn()} as unknown as APWorkspaceService;
 const server=createAPSystemServer(service,{port:0,runId:'server-test',storageRoot:'/private/tmp',allowedOrigins:['http://127.0.0.1:5190']});servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ap-system`;
 const opened=await fetch(base+'/cases');const cookie=opened.headers.get('set-cookie')!.split(';')[0]!;
 return{base,cookie,sha,doc,service};
}
describe('AP HTTP source/session boundary',()=>{
 it('requires an established per-run session for originals',async()=>{
  const f=await fixture();const url=f.base+`/sources/source-1/revisions/1?sha256=${f.sha}`;
  expect((await fetch(url)).status).toBe(403);
  const result=await fetch(url,{headers:{cookie:f.cookie}});expect(result.status).toBe(200);expect(await result.text()).toBe('original invoice bytes');expect(result.headers.get('x-ap-source-sha256')).toBe(f.sha);
 });
 it('rejects cross-origin mutation and stale original hash',async()=>{
  const f=await fixture();const bad=await fetch(f.base+'/cases/case/review',{method:'POST',headers:{origin:'https://external.invalid',cookie:f.cookie,'X-AP-System-Session':'1','Content-Type':'application/json'},body:'{}'});expect(bad.status).toBe(403);expect(f.service.review).not.toHaveBeenCalled();
  const result=await fetch(f.base+`/sources/source-1/revisions/2?sha256=${f.sha}`,{headers:{cookie:f.cookie}});expect(result.status).toBe(409);
 });
 it('refuses changed bytes and reports unavailable raster honestly',async()=>{
  const f=await fixture();f.doc.originalBase64=Buffer.from('changed').toString('base64');
  const result=await fetch(f.base+`/sources/source-1/revisions/1?sha256=${f.sha}`,{headers:{cookie:f.cookie}});expect(result.status).toBe(409);expect(await result.json()).toMatchObject({error:{code:'source_integrity'}});
 });
});
