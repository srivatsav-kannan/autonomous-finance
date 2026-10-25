import "../../src/core/env";
import fs from "node:fs";
import path from "node:path";
import {prepareLocalAPRuntime} from "../../src/ap-system/local-runtime";
import {openFakeBank} from "../../src/integrations/banking/fake";
import {createPaymentDispatcher,createEvidenceWorker} from "../../src/payments/bootstrap";
const runtime=await prepareLocalAPRuntime();
const bank=openFakeBank({path:path.join(runtime.directory,"fakebank.sqlite"),scope:runtime.scope,seed:97,startTime:"2026-10-25T12:00:00Z",initialBalanceCents:10_000_000});
const dispatcher=createPaymentDispatcher(runtime.client,runtime.scope,runtime.dispatchToken,bank.provider,"ap97-dispatcher");
const evidence=createEvidenceWorker(runtime.client,runtime.scope,runtime.evidenceToken,bank.provider,"ap97-evidence");
const once=process.argv.includes("--once");
// Bank simulation is an explicit test harness action, never a worker inference of settlement.
const simulate=process.argv.includes("--simulate-settlement");
let stopped=false;for(const signal of ["SIGINT","SIGTERM"] as const)process.on(signal,()=>{stopped=true;});
try{
 do{
  const result=await dispatcher.tick();
  if(simulate)for(const transfer of bank.harness.inspect().transfers)if(transfer.status==="pending")bank.harness.settle(transfer.id);
  const observations=await evidence.tick();
  const snapshot=bank.harness.inspect();
  fs.writeFileSync(path.join(runtime.directory,"worker-evidence.json"),JSON.stringify({sourceCommit:runtime.revision,runId:runtime.scope.runId,provider:"fake",identityMode:runtime.identityMode,simulation:{settlement:simulate},checkedAt:new Date().toISOString(),dispatch:result,evidence:observations,transfers:snapshot.transfers,transactions:snapshot.transactions,calls:snapshot.calls},null,2),{mode:0o600});
  console.log(JSON.stringify({runId:runtime.scope.runId,provider:"fake",simulatedSettlement:simulate,transferCount:snapshot.transfers.length,postedDebits:snapshot.transactions.filter(t=>t.purpose==="debit"&&t.status==="posted").length,evidenceErrors:observations.errors?.length??0}));
  if(!once&&!stopped)await new Promise(resolve=>setTimeout(resolve,2000));
 }while(!once&&!stopped);
}finally{bank.close();}
