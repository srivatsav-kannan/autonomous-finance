/** Dedicated service process. Deploy separately from agent workers and the operator harness. */
import fs from "node:fs";
import http from "node:http";
import { ConvexHttpClient } from "convex/browser";
import { openFakeBank } from "../src/integrations/banking/fake";
import { IncreaseSandboxBank } from "../src/integrations/banking/increase";
import { createPaymentDispatcher, createEvidenceWorker } from "../src/payments/bootstrap";
import { createConvexPaymentEvidence } from "../src/payments/adapters/convex-payment-evidence";
import { parseBankScope } from "../src/payments/domain/validation";
import type { BankScope } from "../src/integrations/contracts";
const mode = process.argv[2];
if (mode !== "dispatch" && mode !== "evidence") throw new Error("Specify dispatch or evidence");
if (!process.env.AP_BANK_SCOPE || !process.env.CONVEX_URL) throw new Error("AP_BANK_SCOPE and CONVEX_URL required");
const scope: BankScope = parseBankScope(JSON.parse(process.env.AP_BANK_SCOPE));
const token = process.env[mode === "dispatch" ? "AP_DISPATCH_SECRET" : "AP_EVIDENCE_SECRET"];
if (!token) throw new Error(`${mode} service credential required`);
const client = new ConvexHttpClient(process.env.CONVEX_URL);
const fakePath = process.env.AP_FAKE_BANK_PATH;
if (scope.provider === "fake" && (!fakePath || !fs.existsSync(fakePath))) throw new Error("Existing AP_FAKE_BANK_PATH required; workers never reset bank state");
const fake = scope.provider === "fake" ? openFakeBank({path:fakePath!,scope,seed:Number(process.env.AP_SEED ?? 7)}) : undefined;
const evidenceKernel = mode === "evidence" ? createConvexPaymentEvidence(client, scope, token) : undefined;
const increase = scope.provider === "increase" ? new IncreaseSandboxBank({scope,apiKey:process.env.INCREASE_SANDBOX_API_KEY ?? "",signingSecret:process.env.INCREASE_SANDBOX_WEBHOOK_SECRET,resolveCommand: key => evidenceKernel?.resolveCommand({idempotencyKey:key}) ?? Promise.resolve(null)}) : undefined;
const provider = fake?.provider ?? increase!;
const dispatcher = mode === "dispatch" ? createPaymentDispatcher(client,scope,token,provider,`dispatcher-${process.pid}`) : undefined;
const evidence = mode === "evidence" ? createEvidenceWorker(client,scope,token,provider) : undefined;
const once = process.argv.includes("--once");
let stopped = false;
let server: http.Server | undefined;
if (evidence && process.env.AP_WEBHOOK_PORT && !once) {
  const verifier = fake?.events ?? increase!;
  server = http.createServer(async (req,res) => {
    try {
      if (req.method !== "POST" || req.url !== "/webhooks/bank") {res.writeHead(404).end();return;}
      const chunks: Buffer[] = [];let size=0;
      for await (const chunk of req) {size+=chunk.length;if(size>1_048_576)throw new Error("Webhook too large");chunks.push(Buffer.from(chunk));}
      const headers:Record<string,string>={};for(const [key,value] of Object.entries(req.headers))if(typeof value==="string")headers[key]=value;
      await evidence.receive(Buffer.concat(chunks),headers,verifier);
      res.writeHead(204).end();
    } catch {res.writeHead(400).end("Webhook verification or durable ingestion failed");}
  });
  server.listen(Number(process.env.AP_WEBHOOK_PORT),process.env.AP_WEBHOOK_HOST ?? "127.0.0.1");
}
process.on("SIGTERM",()=>{stopped=true;});process.on("SIGINT",()=>{stopped=true;});
try {
  do {
    try { console.log(JSON.stringify(dispatcher ? await dispatcher.tick() : await evidence!.tick())); }
    catch(error) {console.error(error instanceof Error ? error.message : String(error));if(once)process.exitCode=1;}
    if(!once&&!stopped)await new Promise(resolve=>setTimeout(resolve,1000));
  } while(!once&&!stopped);
} finally {server?.close();fake?.close();}
