import {createAPLocalSimulationAuthentication} from "../../src/ap-system/local-simulation-auth";
import {makeFunctionReference} from "convex/server";
import "../../src/core/env";
import fs from "node:fs";
import path from "node:path";
import {createAPSystemServer,type APWorkspaceService} from "../../src/ap-system/server";
import {createAPWorkspaceService} from "../../src/ap-system/service";
import {createDurableAPIntake} from "../../src/ap-system/intake-requests";
import {prepareLocalAPRuntime} from "../../src/ap-system/local-runtime";
import {AP_CONTRACT_VERSION,AP_POLICY_VERSION} from "../../src/ap-system/contracts";
// A module is integrated before this process is eligible to listen. No placeholder parser.
const adapterPath=path.resolve("src/ap-system/ingestion/index.ts");
if(!fs.existsSync(adapterPath))throw Error("AP ingestion adapter is not integrated; server not started");
const adapter=await import(adapterPath);
if(typeof adapter.combineUploads!=="function"||typeof adapter.renderPage!=="function")throw Error("AP ingestion adapter does not meet frozen interface");
const runtime=await prepareLocalAPRuntime();fs.mkdirSync(runtime.storageRoot,{recursive:true,mode:0o700});
function serviceForActor(id:string) {
const human=runtime.humanForActor(id);
const parseUploads:APWorkspaceService["parseUploads"]=createDurableAPIntake({directory:runtime.directory,loadCase:caseId=>service.detail(caseId),parse:input=>adapter.combineUploads({...input,storageRoot:runtime.storageRoot,context:{supplier:{supplierId:"golden-state-produce",legalName:"Golden State Produce Co."},coding:{account:"5000",store:"sf-hayes-valley",department:null,project:null,treatment:"expense"}}})});
const service:APWorkspaceService=createAPWorkspaceService({...runtime,human,agent:runtime.client,parseUploads,renderPage:(source,page)=>adapter.renderPage({source,page,storageRoot:runtime.storageRoot}),runtime:()=>({contractVersion:AP_CONTRACT_VERSION,policyVersion:AP_POLICY_VERSION,sourceCommit:runtime.revision,runId:runtime.scope.runId,scope:runtime.scope,identityMode:runtime.identityMode,parser:"LlamaParse",model:process.env.AGENT_MODEL??"provider_default",providerFileLoaded:Boolean(process.env.LLAMA_CLOUD_API_KEY),accountingIntegration:{provider:"QuickBooks Online US sandbox",status:"not_connected"},providerMode:"local FakeBank",paymentExecution:"separate_worker",practitionerReview:"pending"})});
return service;
}
const service=serviceForActor("field-reviewer");
const auth=createAPLocalSimulationAuthentication({...runtime,serviceForActor,authorizeActor:async id=>{await runtime.humanForActor(id).query(makeFunctionReference<"query">("apIdentity:workspaceAccess"),{scope:runtime.scope});}});
const port=Number(process.env.AP_SYSTEM_PORT??8823);if(port!==8823)throw Error("Owned AP server port 8823 required");
const server=createAPSystemServer(service,{auth,port,runId:runtime.scope.runId,storageRoot:runtime.storageRoot,allowedOrigins:(process.env.AP_SYSTEM_ALLOWED_ORIGINS??"http://127.0.0.1:5190,http://127.0.0.1:5191").split(",")});
server.listen(port,"127.0.0.1",()=>console.log(`AP system ready at http://127.0.0.1:${port}; identity=simulated_human; provider=fake/local`));
for(const signal of ["SIGINT","SIGTERM"] as const)process.on(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
