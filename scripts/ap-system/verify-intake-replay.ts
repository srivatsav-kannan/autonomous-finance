import fs from "node:fs";
import {caseDetailSchema} from "../../src/ap-system/contracts";
const directory="var/ap97-20261025-01a1722e",base="http://127.0.0.1:8823/api/ap-system";
const session=await fetch(base+"/cases");if(!session.ok)throw Error("Local AP unavailable");
const cookie=session.headers.get("set-cookie")!.split(";")[0]!;
const runtime=await (await fetch(base+"/runtime")).json();if(runtime.scope?.provider!=="fake"||runtime.runId!=="ap97-20261025-01a1722e")throw Error("Owned FakeBank run required");
const original=JSON.parse(fs.readFileSync(directory+"/I1-upload-result.json","utf8")).body;
const read=async()=>caseDetailSchema.parse(await (await fetch(base+"/cases/"+original.caseId,{headers:{cookie}})).json());
const before=await read();
const upload=async(key:string,rename=false)=>{
 const form=new FormData();for(const name of ["invoice","purchase-order","receipt","contract"]){const bytes=fs.readFileSync(`fixtures/ap-system/golden-state-v1/input/${name}.pdf`);form.append("documents",new Blob([bytes],{type:"application/pdf"}),`${rename?"resent-":""}${name}.pdf`);}
 form.append("kinds",JSON.stringify(["invoice","purchase_order","receipt","contract"]));form.append("idempotencyKey",key);
 const r=await fetch(base+"/intake",{method:"POST",headers:{cookie,origin:"http://127.0.0.1:5190","X-AP-System-Session":"1"},body:form});const data=await r.json();return {status:r.status,body:data};
};
const replay=await upload("i1-original-upload-20261025-v1");
if(replay.status!==201||replay.body.caseId!==original.caseId||JSON.stringify(replay.body)!==JSON.stringify(original))throw Error("Restart replay must return the saved backend response unchanged");
const conflict=await upload("i1-original-upload-20261025-v1",true);if(conflict.status<400)throw Error("Same key changed request must reject");
const renamed=await upload("i1-renamed-delivery-20261025-v1",true);if(renamed.status!==201||renamed.body.caseId!==original.caseId||!renamed.body.duplicate)throw Error("Renamed delivery must associate to the original obligation");
const after=await read();
for(const key of ["revision","snapshotHash","states","amounts","links","journals","payments"] as const)if(JSON.stringify(after[key])!==JSON.stringify(before[key]))throw Error(`Duplicate delivery changed economic state: ${key}`);
const duplicateEvents=after.timeline.filter(e=>e.kind==="source_delivery"&&e.summary.startsWith("Received resent-"));if(duplicateEvents.length!==4)throw Error("Duplicate delivery audit missing");
const proof={checkedAt:new Date().toISOString(),codeRevision:runtime.sourceRevision,caseId:original.caseId,replay,conflict:{status:conflict.status,code:conflict.body.error?.code},renamed,unchanged:["revision","snapshotHash","states","amounts","links","journals","payments"],duplicateEvents:duplicateEvents.length};
fs.writeFileSync(directory+"/I1-intake-replay.json",JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
