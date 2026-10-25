import "../../src/core/env";
import {writeFileSync} from "node:fs";
import path from "node:path";
import {prepareLocalB3Runtime} from "../../src/ap-system/local-b3-runtime";
import {openFakeBank} from "../../src/integrations/banking/fake";
import {createPaymentDispatcher,createEvidenceWorker} from "../../src/payments/bootstrap";
const runtime=await prepareLocalB3Runtime();
const bank=openFakeBank({path:path.join(runtime.directory,"fakebank.sqlite"),scope:runtime.scope,seed:973,startTime:"2026-10-25T12:00:00Z",initialBalanceCents:10_000_000});
try{
 const dispatcher=createPaymentDispatcher(runtime.agent,runtime.scope,runtime.dispatchToken,bank.provider,"ap97-b3-dispatcher"),evidence=createEvidenceWorker(runtime.agent,runtime.scope,runtime.evidenceToken,bank.provider,"ap97-b3-evidence");
 const dispatched=await dispatcher.tick();
 if(process.argv.includes("--simulate-settlement"))for(const transfer of bank.harness.inspect().transfers)if(transfer.status==="pending")bank.harness.settle(transfer.id);
 const observed=await evidence.tick(),snapshot=bank.harness.inspect();
 writeFileSync(path.join(runtime.directory,"worker-evidence.json"),JSON.stringify({checkedAt:new Date().toISOString(),runId:runtime.scope.runId,provider:"fake",identityMode:"simulated_human",simulatedSettlement:process.argv.includes("--simulate-settlement"),dispatch:dispatched,evidence:observed,...snapshot},null,2),{mode:0o600});
 console.log(JSON.stringify({runId:runtime.scope.runId,provider:"fake",transferCount:snapshot.transfers.length,postedDebits:snapshot.transactions.filter(t=>t.purpose==="debit"&&t.status==="posted").length,evidenceErrors:observed.errors?.length??0}));
}finally{bank.close();}
