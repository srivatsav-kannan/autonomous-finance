import "../../src/core/env";
import fs from "node:fs";
import {createHash} from "node:crypto";
import {caseDetailSchema,type APCaseDetail} from "../../src/ap-system/contracts";
// Explicit synthetic local acceptance harness. Evaluation labels are never imported by runtime services.
const directory="var/ap97-20261025-01a1722e",base="http://127.0.0.1:8823/api/ap-system";
const expected=JSON.parse(fs.readFileSync("fixtures/ap-system/golden-state-v1/evaluation/expected-outcomes.json","utf8")).clean;
const opened=await fetch(base+"/cases");if(!opened.ok)throw Error("AP workspace unavailable");
const cookie=opened.headers.get("set-cookie")!.split(";")[0]!;
const get=async(route:string)=>{const r=await fetch(base+route,{headers:{cookie}});if(!r.ok)throw Error(`Read ${route}: ${r.status}`);return r.json();};
const post=async(route:string,body:unknown)=>{const r=await fetch(base+route,{method:"POST",headers:{cookie,origin:"http://127.0.0.1:5190","X-AP-System-Session":"1","Content-Type":"application/json"},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(`Write ${route}: ${r.status} ${data?.error?.code??"failed"}`);return data;};
const runtime=await get("/runtime");if(runtime.scope?.provider!=="fake"||runtime.scope?.environment!=="local"||runtime.identityMode!=="simulated_human"||runtime.runId!=="ap97-20261025-01a1722e")throw Error("Only owned local/simulated run allowed");
const upload=JSON.parse(fs.readFileSync(directory+"/I1-upload-result.json","utf8"));const caseId=upload.body.caseId;
const read=async()=>caseDetailSchema.parse(await get("/cases/"+caseId));let detail=await read();
const save=(name:string,value:unknown)=>fs.writeFileSync(`${directory}/${name}.json`,JSON.stringify(value,null,2),{mode:0o600});
const assert=(condition:unknown,message:string)=>{if(!condition)throw Error(message);};
assert(detail.candidate&&detail.revision===1,"Expected first original candidate");
const candidate=detail.candidate!;
for(const [key,value] of Object.entries(expected.fields)){
 let actual:unknown;
 if(key==="supplier")actual=candidate.extractedSupplierName;
 else if(key.startsWith("lines.")){const [,id,field]=key.split(".");const line=candidate.lines.find(l=>l.lineId===id)!;actual=field==="quantity"?line.quantity.decimal:line[field as keyof typeof line];}
 else actual=candidate[key as keyof typeof candidate];
 assert(actual===value,`Original-derived expected field mismatch: ${key}`);
}
const sourceChecks=[];
for(const source of detail.sources){
 const r=await fetch(base+`/sources/${encodeURIComponent(source.sourceId)}/revisions/${source.revision}?sha256=${source.sha256}`,{headers:{cookie}});
 const bytes=new Uint8Array(await r.arrayBuffer());assert(r.ok&&createHash("sha256").update(bytes).digest("hex")===source.sha256,"Original bytes/hash mismatch");
 sourceChecks.push({sourceId:source.sourceId,revision:source.revision,sha256:source.sha256,bytes:bytes.length});
}
const totals=(d:APCaseDetail,kind:string)=>{const map=new Map<string,{account:string;debit:number;credit:number}>();for(const j of d.journals.filter(j=>j.kind===kind))for(const l of j.lines){const t=map.get(l.account)??{account:l.account,debit:0,credit:0};t.debit+=l.debit;t.credit+=l.credit;map.set(l.account,t);}return [...map.values()].sort((a,b)=>a.account.localeCompare(b.account));};
const checkJournal=(d:APCaseDetail,kind:string)=>assert(JSON.stringify(totals(d,kind))===JSON.stringify([...expected[kind]].sort((a,b)=>a.account.localeCompare(b.account))),`${kind} accounts/amounts mismatch`);
if(process.argv.includes("--settled")){
 assert(detail.states.execution==="settled"&&detail.states.reconciliation==="matched","Settlement not reconciled");
 assert(detail.amounts.outstandingCents===0&&detail.amounts.settledCents===67860,"Outstanding/settled amount mismatch");
 assert(detail.journals.filter(j=>j.kind==="recognition").length===1&&detail.journals.filter(j=>j.kind==="settlement").length===1,"Duplicate/missing economic posting");
 checkJournal(detail,"recognition");checkJournal(detail,"settlement");
 const payment=await get("/payments/"+detail.links.paymentVersionIds[0]);
 assert(payment.transactions.filter((t:{purpose:string;status:string})=>t.purpose==="debit"&&t.status==="posted").length===1,"Expected one posted bank debit");
 const worker=JSON.parse(fs.readFileSync(directory+"/worker-evidence.json","utf8"));assert(worker.transfers.length===1,"Expected one intended transfer");
 save("I1-settled",{runtime,checkedAt:new Date().toISOString(),sourceChecks,detail,payment,worker});console.log(JSON.stringify({caseId,billId:detail.links.billId,paymentId:detail.links.paymentVersionIds[0],commandId:detail.links.commandIds[0],transferCount:worker.transfers.length,bankTransactions:detail.links.bankTransactionIds,recognition:totals(detail,"recognition"),settlement:totals(detail,"settlement"),states:detail.states,outstandingCents:detail.amounts.outstandingCents}));
}else{
 const reason="Synthetic local acceptance: source hashes and actual originals checked against independent V1 review; all 35 fields inspected, two unresolved locations reviewed against original text. Not practitioner sign-off.";
 const review={caseId,expectedRevision:detail.revision,sourceBindings:detail.currentSourceBindings,snapshotHash:detail.snapshotHash,idempotencyKey:"i1-fields-v1",outcome:"approved",reason,evidenceIds:candidate.evidence.map(e=>e.evidenceId)};
 if(!detail.links.billId){
  const blocked=await fetch(base+`/cases/${caseId}/payments`,{method:"POST",headers:{cookie,origin:"http://127.0.0.1:5190","X-AP-System-Session":"1","Content-Type":"application/json"},body:JSON.stringify({expectedRevision:1,snapshotHash:detail.snapshotHash,idempotencyKey:"i1-premature-payment"})});assert(!blocked.ok,"Unreviewed payment should reject");
 }
 await post(`/cases/${caseId}/review`,review);detail=await read();assert(detail.states.document==="reviewed"&&!detail.links.billId,"Field review must not create a bill");save("I1-field-reviewed",detail);
 await post(`/cases/${caseId}/approve`,{...review,idempotencyKey:"i1-bill-v1",acceptedCents:67860});detail=await read();assert(detail.states.business==="approved"&&detail.states.authorization==="not_requested"&&detail.payments.length===0,"Bill approval must not authorize payment");checkJournal(detail,"recognition");save("I1-bill-approved",detail);
 const prepared=await post(`/cases/${caseId}/payments`,{expectedRevision:detail.revision,snapshotHash:detail.snapshotHash,idempotencyKey:"i1-payment-v1"});detail=await read();assert(detail.states.authorization==="awaiting_approval"&&detail.links.commandIds.length===0,"Proposal must await separate authorization");save("I1-payment-prepared",{detail,prepared});
 const authorized=await post(`/cases/${caseId}/payments/${prepared.versionId}/authorize`,{expectedRevision:detail.revision,snapshotHash:detail.snapshotHash,paymentSnapshotHash:prepared.snapshotHash});detail=await read();assert(detail.states.authorization==="authorized"&&detail.links.commandIds.length===1,"Authorization command missing");save("I1-authorized",{runtime,checkedAt:new Date().toISOString(),sourceChecks,detail,prepared,authorized});console.log(JSON.stringify({caseId,billId:detail.links.billId,prepared,authorized,states:detail.states,recognition:totals(detail,"recognition")}));
}
