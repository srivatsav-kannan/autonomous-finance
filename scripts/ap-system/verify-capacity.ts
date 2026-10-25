import "../../src/core/env";
import fs from "node:fs";
import path from "node:path";
import {createHash,randomBytes} from "node:crypto";
import {ConvexHttpClient} from "convex/browser";
import {makeFunctionReference} from "convex/server";
import {AP_CONTRACT_VERSION,AP_POLICY_VERSION,type APIntake,type SourceDocument} from "../../src/ap-system/contracts";
import {PAYMENT_EXECUTOR_VERSION} from "../../src/payments/contracts";
// This creates held test cases in a separate synthetic run, with no bill or payment.
const root=process.cwd();
const deployment=JSON.parse(fs.readFileSync(path.join(root,".convex/local/default/config.json"),"utf8"));
if(deployment.ports.cloud!==3250||deployment.ports.site!==3251)throw Error("Owned backend 3250/3251 required");
const admin=process.env.KERNEL_ADMIN_SECRET;if(!admin)throw Error("Local administrator configuration required");
const client=new ConvexHttpClient("http://127.0.0.1:3250");
const runId=`ap97-capacity-${Date.now()}`, token=randomBytes(32).toString("hex");
const scope={organizationId:"ap97-capacity-test",runId,provider:"fake" as const,environment:"local" as const,accountId:"capacity-no-payment"};
const credential={seatId:"capacity-ap",token};
const hash=(b:Uint8Array|string)=>createHash("sha256").update(b).digest("hex");
await client.mutation(makeFunctionReference<"mutation">("admin:createRun"),{secret:admin,runId,label:"Synthetic storage capacity verification",company:"Test originals only",simDate:"2026-10-25",seats:[{seatId:credential.seatId,role:"ap_clerk",name:"Capacity test",kind:"agent",tokenHash:hash(token)},{seatId:"capacity-human",role:"human_cfo",name:"Unused synthetic identity",kind:"human",tokenHash:hash(randomBytes(32))}],periods:["2026-10"]});
await client.mutation(makeFunctionReference<"mutation">("demoPayments:configure"),{secret:admin,scope,paymentExecutorVersion:PAYMENT_EXECUTOR_VERSION,beneficiary:{vendor:"golden-state-produce",externalAccountId:"capacity-never-paid",version:"v1"},policyVersion:AP_POLICY_VERSION,controllerLimitCents:5_000_000,humanSubjects:[{subject:"https://ap-demo.invalid|capacity-human",seatId:"capacity-human"}]});
const rows:unknown[]=[];
for(const size of [1_200_000,8*1024*1024,8*1024*1024+1]){
 await new Promise(resolve=>setTimeout(resolve,3000));
 const bytes=Buffer.alloc(size,97),sha256=hash(bytes),sourceId=`capacity-${size}`;
 const source:SourceDocument={sourceId,revision:1,sha256,deliveryId:`delivery-${size}`,name:`capacity-${size}.txt`,kind:"invoice",mimeType:"text/plain",originalRef:"private-capacity-fixture",originalBase64:bytes.toString("base64"),byteLength:bytes.length,extractedText:"",provenance:{kind:"synthetic",description:"Binary capacity stand-in, no business content or parser claim",license:"Project-authored synthetic data",originalFilename:`capacity-${size}.txt`},replaces:null,pageCount:1,pageStatus:[{page:1,status:"failed",reason:"Capacity fixture is not an invoice"}],parser:null};
 const input:APIntake={contractVersion:AP_CONTRACT_VERSION,idempotencyKey:`capacity-${size}`,documents:[source],candidate:null,extraction:{status:"failed",evidence:[],reasons:["Capacity fixture is not an invoice"]},purchasingEvidence:[],explicitRevisionOf:null};
 const started=Date.now();
 try{
  const result=await client.mutation(makeFunctionReference<"mutation">("apCases:ingest"),{scope,...credential,input});
  if(size>8*1024*1024)throw Error("Over-limit fixture unexpectedly accepted");
  const original=await client.query(makeFunctionReference<"query">("apCases:source"),{scope,...credential,sourceId,revision:1,sha256});
  const returned=Buffer.from(original.originalBase64,"base64");
  if(hash(returned)!==sha256||returned.length!==size)throw Error("Round-trip integrity failed");
  const detail=await client.query(makeFunctionReference<"query">("apCases:detail"),{scope,...credential,caseId:result.caseId});
  if(detail.links.billId||detail.journals.length||detail.payments.length)throw Error("Storage test created economic effects");
  rows.push({size,caseId:result.caseId,accepted:true,roundTripHash:sha256,economicEffects:0,elapsedMs:Date.now()-started});
 }catch(error){
  fs.writeFileSync(path.join(root,"var/ap97-20261025-01a1722e/capacity-error.private.log"),String(error),{mode:0o600});
  const code=typeof error==="object"&&error&&"data" in error?(error.data as {code?:string})?.code:undefined;
  if(size<=8*1024*1024||code!=="source_too_large")throw Error(`Capacity verification failed at ${size} bytes (${code??"transport_or_assertion"})`);
  rows.push({size,accepted:false,expectedCode:code,elapsedMs:Date.now()-started});
 }
}
const report={runId,provider:"fake/local",identityMode:"agent_test",inputKind:"synthetic binary stand-in, no parser/business acceptance",checkedAt:new Date().toISOString(),results:rows};
const directory=path.join(root,"var/ap97-20261025-01a1722e");fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.writeFileSync(path.join(directory,"capacity-evidence.json"),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
