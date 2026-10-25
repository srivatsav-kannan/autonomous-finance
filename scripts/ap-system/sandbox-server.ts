import "../../src/core/env";
import { mkdir } from "node:fs/promises";
import { createAPSystemServer } from "../../src/ap-system/server";
import { createAPSandboxRuntime, parseAPSandboxConfig } from "../../src/ap-system/sandbox-runtime";

// This entrypoint never provisions a run, edits deployment environment, impersonates
// a user, starts a worker, or calls Increase. Missing configuration stops startup.
const config=parseAPSandboxConfig(process.env);
const runtime=createAPSandboxRuntime(config,process.env);
await mkdir(config.storageRoot,{recursive:true,mode:0o700});
const port=8825;
const server=createAPSystemServer({runtime:runtime.runtime},{port,runId:config.scope.runId,storageRoot:config.storageRoot,allowedOrigins:["http://127.0.0.1:5192"],auth:runtime.auth});
server.listen(port,"127.0.0.1",()=>console.log("AP Auth0 sandbox gateway ready on 127.0.0.1:8825; browser callback http://127.0.0.1:5192/ap-system. Human approval required; no payment worker started."));
for(const signal of ["SIGINT","SIGTERM"] as const)process.on(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
