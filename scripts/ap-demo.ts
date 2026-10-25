import { createConvexPaymentCommands } from "../src/payments/adapters/convex-payment-commands";
import { createPaymentCommandService } from "../src/payments/application/payment-commands";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import "../src/core/env";
import { api } from "../convex/_generated/api";
import { openFakeBank } from "../src/integrations/banking/fake";
import { IncreaseSandboxBank } from "../src/integrations/banking/increase";
import { IncreaseSandboxHarness, sandboxConfiguration } from "./testing/increase-sandbox-harness";
import { PaymentDispatcher } from "../src/payments/dispatcher";
import { EvidenceWorker } from "../src/payments/evidence";
import { DemoAPAgent, DemoPaymentsAgent } from "../src/payments/agents";
import { demoInvoice } from "../src/payments/demo-invoice";
import increaseProvenance from "../src/integrations/fixtures/increase/provenance.json";
import { BankProviderError, canonicalJson, type BankScope, type BankTransaction } from "../src/integrations/contracts";

const profile = process.argv[2] ?? "local";
if (!["local", "sandbox"].includes(profile)) throw new Error("Usage: npm run demo:local | npm run demo:sandbox");
const sandbox = sandboxConfiguration();
const required = ["CONVEX_URL", "KERNEL_ADMIN_SECRET", "AP_DISPATCH_SECRET", "AP_EVIDENCE_SECRET", "AP_HUMAN_JWT", "AP_HUMAN_SUBJECT", "AP_RUN_ID", "AP_ORGANIZATION_ID", "AP_SANDBOX_FUNDING"];
if (profile === "sandbox") {
  const missing = [...(sandbox.status === "not_run" ? sandbox.missing : []), ...required.filter(k => !process.env[k])];
  if (missing.length) { console.log(JSON.stringify({ profile, status: "not_run", missing, reason: "Live Increase and authenticated human approval prerequisites are required; simulator tests do not count." }, null, 2)); process.exit(2); }
}
const stamp = `${Date.now()}`;
const runStartedAt = new Date(Number(stamp)).toISOString();
const runId = process.env.AP_RUN_ID ?? `ap-${profile}-${stamp}`;
const scope: BankScope = profile === "sandbox" && sandbox.status === "ready" ? { ...sandbox.configuration.scope, runId } : { organizationId: "ap-demo", runId, provider: "fake", environment: "local", accountId: "usd-operating" };
const artifactDir = path.resolve("var/ap-demo", runId);
fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
const random = () => randomBytes(32).toString("hex");
let url = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
const secrets = { admin: process.env.KERNEL_ADMIN_SECRET ?? random(), dispatcher: process.env.AP_DISPATCH_SECRET ?? random(), evidence: process.env.AP_EVIDENCE_SECRET ?? random() };
const humanSubject = process.env.AP_HUMAN_SUBJECT ?? "https://ap-demo.invalid|local-human-fixture";
let localAdminKey: string | undefined;
let identityMode = "verified_jwt";
if (profile === "local") {
  const configPath = path.resolve(".convex/local/default/config.json");
  if (!fs.existsSync(configPath)) throw new Error("Start npm run backend in a separate terminal before the local demo");
  const deployment = JSON.parse(fs.readFileSync(configPath, "utf8")) as { ports: { cloud: number }; adminKey: string };
  url = `http://127.0.0.1:${deployment.ports.cloud}`;
  // Explicitly a simulator identity fixture. Never available for Increase or to agent processes.
  identityMode = "local_admin_simulated_human";
  localAdminKey = deployment.adminKey;
  const changes = Object.entries({ KERNEL_ADMIN_SECRET: secrets.admin, AP_DISPATCH_SECRET: secrets.dispatcher, AP_EVIDENCE_SECRET: secrets.evidence, AP_BANK_SCOPE: JSON.stringify(scope) }).map(([name,value]) => ({name,value}));
  const configured = await fetch(`${url}/api/update_environment_variables`, {method:"POST",headers:{Authorization:`Convex ${deployment.adminKey}`,"Content-Type":"application/json"},body:JSON.stringify({changes}),redirect:"error"});
  if (!configured.ok) throw new Error(`Local environment setup failed (HTTP ${configured.status}); verify npm run backend is running`);
}
if (!url) throw new Error("CONVEX_URL required");
const client = new ConvexHttpClient(url);
const human = new ConvexHttpClient(url);
if (localAdminKey) (human as unknown as { setAdminAuth(key: string, identity: {issuer: string; subject: string; tokenIdentifier: string}): void }).setAdminAuth(localAdminKey, { issuer: "https://ap-demo.invalid", subject: "local-human-fixture", tokenIdentifier: humanSubject });
else human.setAuth(process.env.AP_HUMAN_JWT!);
const source = demoInvoice(7, "2026-01-05");
const today = profile === "sandbox" ? new Date().toISOString().slice(0, 10) : source.invoice.invoiceDate;
const evidenceAuth = {scope,token:secrets.evidence};
const sandboxProvider = profile === "sandbox" && sandbox.status === "ready"
  ? new IncreaseSandboxBank({scope,apiKey:sandbox.configuration.apiKey,signingSecret:sandbox.configuration.signingSecret,resolveCommand:key=>client.query(api.demoEvidence.resolveCommand,{...evidenceAuth,idempotencyKey:key})})
  : undefined;
const fundingTransactions: BankTransaction[] = [];
if (sandboxProvider) {
  // Operator-selected transaction IDs and amounts are an explicit classification, not a filter
  // that hides other account activity. Every other statement transaction remains a close blocker.
  const approvals = z.array(z.object({ transactionId: z.string().regex(/^transaction_[a-zA-Z0-9]+$/), amountCents: z.number().int().positive() }).strict()).min(1).parse(JSON.parse(process.env.AP_SANDBOX_FUNDING!));
  if (new Set(approvals.map(a=>a.transactionId)).size !== approvals.length) throw new Error("Funding transaction IDs must be distinct");
  for (const approval of approvals) {
    const transaction = await sandboxProvider.getTransaction(scope, approval.transactionId);
    if (transaction.sourceCategory !== "inbound_wire_transfer" || transaction.purpose !== "other" || transaction.commandId || transaction.transferId || transaction.amountCents !== approval.amountCents) throw new Error("Selected sandbox funding differs from the reviewed wire and amount");
    fundingTransactions.push(transaction);
  }
}
const periods = [...new Set([source.invoice.invoiceDate.slice(0,7),today.slice(0,7),...fundingTransactions.map(t=>t.postedAt!.slice(0,7))])];
const tokens = { ap: random(), payments: random(), controller: random() };
const seats = [
  ...Object.entries(tokens).map(([seatId, token]) => ({ seatId, role: seatId === "ap" ? "ap_clerk" : seatId, kind: "agent" as const, name: seatId, tokenHash: createHash("sha256").update(token).digest("hex") })),
  { seatId: "human", role: "human_cfo", kind: "human" as const, name: "Human CFO", tokenHash: createHash("sha256").update(random()).digest("hex") },
];
const created = await client.mutation(api.admin.createRun, { secret: secrets.admin, runId, label: `AP ${profile} recovery demo`, company: "AP Demo", simDate: today, seats, periods });
if (!created.ok) throw new Error(created.error);
const externalAccountId = profile === "sandbox" && sandbox.status === "ready" ? sandbox.configuration.externalAccountId : "external-vendor";
await client.mutation(api.demoPayments.configure, { scope, secret: secrets.admin, beneficiary: {vendor: source.vendor, externalAccountId, version: "beneficiary-v1"}, policyVersion: "ap-demo-v1", controllerLimitCents: 5_000_000, humanSubjects: [{subject: humanSubject, seatId: "human"}],
  // A reused sandbox account carries earlier runs' activity. Bind this run to its start so that
  // history is retained as prior activity instead of blocking close (selected funding still posts).
  ...(profile === "sandbox" ? { activitySince: runStartedAt } : {}) });
if (fundingTransactions.length) {
  await client.mutation(api.demoEvidence.importPage, { ...evidenceAuth, expectedCursor: null, cursor: null, transactions: fundingTransactions });
  for (const transaction of fundingTransactions) await human.mutation(api.demoEvidence.approveSandboxFunding, {
    scope, transactionId: transaction.id, expectedAmountCents: transaction.amountCents,
    reason: "Operator-selected AP_SANDBOX_FUNDING wire contributed as sandbox demo capital",
  });
}
const ap = new DemoAPAgent(client, {scope,seatId:"ap",token:tokens.ap});
const payments = new DemoPaymentsAgent(client, {scope,seatId:"payments",token:tokens.payments});
fs.writeFileSync(path.join(artifactDir,"invoice.json"), JSON.stringify(source.event,null,2));
const {billId} = await ap.recordInvoice({vendor:source.vendor,invoiceNumber:source.invoice.invoiceNumber,invoiceDate:source.invoice.invoiceDate,originalCents:source.invoice.totalCents,evidence:[source.event.externalId]});
await client.mutation(api.demoPayments.acceptBill, {scope,seatId:"controller",token:tokens.controller,billId,approvedCents:source.invoice.totalCents});
const requested = await payments.requestPayment([billId], `invoice:${source.event.externalId}`);
const approved = await createPaymentCommandService(createConvexPaymentCommands(human, scope, { kind: "human" })).approveAndQueue({
  commandId: `approve:${requested.versionId}`, command: { type: "ApprovePayment", ...requested },
});
let bankEvidence: unknown;
let processRecovery: unknown;
if (profile === "local") {
  const bankPath = path.join(artifactDir,"bank.sqlite");
  const bank = openFakeBank({path:bankPath,scope,seed:7,startTime:`${source.invoice.invoiceDate}T12:00:00.000Z`,initialBalanceCents:10_000_000,faults:[{operation:"createTransfer",call:1,kind:"accept_then_lost_response"}]});
  const workerConfig = path.join(artifactDir,"dispatcher.json");
  fs.writeFileSync(workerConfig,JSON.stringify({url,scope,token:secrets.dispatcher,bankPath,seed:7}),{mode:0o600});
  const initialReview = await human.query(api.demoPayments.humanReview, { scope });
  const frozenCommandSha256 = createHash("sha256").update(canonicalJson(initialReview.commands[0]!.command)).digest("hex");
  type ChildResult = { exitCode: number | null; signal: NodeJS.Signals | null; acceptedCommandSha256?: string; lookupCommandSha256?: string; checkpointVerified: boolean;
    recoveredTransferId?: string | null; createTransferCalls?: number };
  const marker = z.object({ event: z.enum(["accepted-before-record", "lookup-start"]), commandSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
  const dispatchResult = z.object({ event: z.literal("dispatch-result"), providerTransferId: z.string().nullable(), createTransferCalls: z.number().int().nonnegative() }).strict();
  const child = (crash = false) => new Promise<ChildResult>((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "scripts/testing/demo-dispatch-child.ts", workerConfig, ...(crash ? ["--crash-after-submit"] : [])], {
      stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
    });
    let failure: Error | undefined;
    const observed: Omit<ChildResult, "exitCode" | "signal"> = { checkpointVerified: false };
    const fail = (reason: string) => { failure = new Error(reason); proc.kill("SIGKILL"); };
    const deadline = setTimeout(() => fail("Dispatcher child timed out"), 30_000);
    // Do not propagate raw worker output or exception payloads into CI artifacts.
    proc.stdout?.resume(); proc.stderr?.resume();
    proc.on("error", () => { clearTimeout(deadline); reject(new Error("Dispatcher child failed to start")); });
    proc.on("message", (data: unknown) => {
      const result = dispatchResult.safeParse(data);
      if (result.success) {
        if (crash || observed.createTransferCalls !== undefined) { fail("Unexpected dispatch result"); return; }
        observed.recoveredTransferId = result.data.providerTransferId;
        observed.createTransferCalls = result.data.createTransferCalls;
        return;
      }
      const parsed = marker.safeParse(data);
      if (!parsed.success || parsed.data.commandSha256 !== frozenCommandSha256) { fail("Invalid frozen-command checkpoint"); return; }
      if (parsed.data.event === "lookup-start") {
        if (crash || observed.lookupCommandSha256) { fail("Unexpected recovery lookup checkpoint"); return; }
        observed.lookupCommandSha256 = parsed.data.commandSha256;
        return;
      }
      if (!crash || observed.acceptedCommandSha256) { fail("Unexpected bank acceptance checkpoint"); return; }
      observed.acceptedCommandSha256 = parsed.data.commandSha256;
      void (async () => {
        // The child is paused in createTransfer. Inspect persisted state before killing it.
        const review = await human.query(api.demoPayments.humanReview, { scope });
        const evidence = await human.query(api.demoEvidence.humanView, { scope });
        assert.equal(bank.harness.inspect().transfers.length, 1);
        assert.equal(review.commands.length, 1);
        const row = review.commands[0]!;
        assert.equal(row.execution, "in_flight"); assert.equal(row.posting, "unposted");
        assert.equal(row.providerTransferId, undefined); assert.equal(row.attemptCount, 1);
        assert.equal(createHash("sha256").update(canonicalJson(row.command)).digest("hex"), frozenCommandSha256);
        assert.ok(review.bills.every(bill => bill.paidCents === 0));
        assert.equal(evidence.transactions.length, 0);
        observed.checkpointVerified = true;
        proc.kill("SIGKILL");
      })().catch(() => fail("Accepted-before-record checkpoint failed"));
    });
    proc.on("close", (exitCode, signal) => {
      clearTimeout(deadline);
      if (failure) { reject(failure); return; }
      if (crash ? signal !== "SIGKILL" || !observed.checkpointVerified : exitCode !== 0 || !observed.lookupCommandSha256 || observed.createTransferCalls === undefined) {
        reject(new Error("Dispatcher child did not complete the required recovery checkpoint")); return;
      }
      resolve({ ...observed, exitCode, signal });
    });
  });
  try {
  const killed = await child(true);
  assert.equal(killed.signal, "SIGKILL"); assert.equal(killed.exitCode, null);
  assert.equal(bank.harness.inspect().transfers.length,1);
  console.log("Bank accepted; parent SIGKILLed the paused worker before local completion. Waiting for the 30-second lease to expire.");
  await new Promise(resolve=>setTimeout(resolve,31_000));
  const restarted = await child();
  assert.equal(restarted.exitCode, 0); assert.equal(restarted.signal, null);
  const pending = await human.query(api.demoPayments.humanReview, { scope });
  assert.equal(pending.commands[0]!.execution, "pending"); assert.equal(pending.commands[0]!.posting, "unposted");
  assert.ok(pending.bills.every(bill => bill.paidCents === 0));
  const transfer=bank.harness.inspect().transfers[0]!;
  // Replay the lost request exactly: same frozen command, key and request bytes. A durable
  // provider must return the ORIGINAL transfer. Record the outcome; CI asserts it (#77).
  let replay: { transferId: string | null; errorClass: string | null };
  try { replay = { transferId: (await bank.provider.createTransfer(initialReview.commands[0]!.command)).id, errorClass: null }; }
  catch (error) {
    const code = error instanceof BankProviderError ? error.errorClass : (error as { code?: unknown })?.code;
    replay = { transferId: null, errorClass: typeof code === "string" && /^[A-Za-z_]{1,40}$/.test(code) ? code : "error" };
  }
  processRecovery = { signal: killed.signal, exitCode: killed.exitCode, acceptedBeforeKill: killed.checkpointVerified,
    completionAbsentBeforeKill: true, unpaidBeforeSettlement: true, frozenCommandSha256,
    acceptedCommandSha256: killed.acceptedCommandSha256, lookupCommandSha256: restarted.lookupCommandSha256,
    recoveredTransferId: restarted.recoveredTransferId, restartCreateTransferCalls: restarted.createTransferCalls,
    recordedTransferId: pending.commands[0]!.providerTransferId ?? null, originalTransferId: transfer.id, replay };
  bank.harness.settle(transfer.id);
  const generatedNotifications=bank.harness.inspect().events.length;
  const delivered=bank.harness.drainNotifications({drop:true});
  const worker=new EvidenceWorker(client,scope,secrets.evidence,bank.provider);
  const first=await worker.tick();assert.deepEqual(first.errors,[]);assert.equal(first.posted,1);
  assert.equal((await worker.tick()).posted,0);
  const state=bank.harness.inspect();assert.equal(state.transfers.length,1);assert.equal(state.transactions.filter(t=>t.status==="posted"&&t.purpose==="debit").length,1);
  bankEvidence={transfers:state.transfers,transactions:state.transactions,calls:state.calls,notifications:{generated:generatedNotifications,delivered:delivered.length}};
  } finally { bank.close(); fs.unlinkSync(workerConfig); } // Credential artifact is not part of the evidence report.
} else if (sandbox.status === "ready" && sandboxProvider) {
  const provider=sandboxProvider;
  const dispatched=await new PaymentDispatcher(client,scope,secrets.dispatcher,provider,"sandbox-dispatcher").tick();
  if (!dispatched.providerTransferId) throw new Error(`Sandbox dispatch incomplete: ${JSON.stringify(dispatched)}`);
  const harness=new IncreaseSandboxHarness({scope,apiKey:sandbox.configuration.apiKey});
  await harness.submit(dispatched.providerTransferId);await harness.settle(dispatched.providerTransferId);
  const worker=new EvidenceWorker(client,scope,secrets.evidence,provider);
  let result=await worker.tick();
  for(let i=0;i<10&&result.posted===0;i++){await new Promise(r=>setTimeout(r,1000));result=await worker.tick();}
  const transfer=await provider.getTransfer(scope,dispatched.providerTransferId);
  if(!transfer.originalTransactionId) throw new Error("Sandbox settlement transaction missing");
  bankEvidence={transfer,transaction:await provider.getTransaction(scope,transfer.originalTransactionId)};
}
const review=await human.query(api.demoPayments.humanReview,{scope});
const evidence=await human.query(api.demoEvidence.humanView,{scope});
const paymentEvidence=evidence.transactions.filter(t=>t.transaction.commandId===requested.versionId&&t.transaction.purpose==="debit");
assert.equal(review.commands.length,1);assert.equal(review.commands[0]?.execution,"settled");assert.equal(review.commands[0]?.posting,"posted");assert.equal(review.commands[0]?.reconciliation,"matched");assert.equal(paymentEvidence.length,1);assert.equal(evidence.blockers.length,0);
assert.ok(fundingTransactions.every(tx=>evidence.transactions.some(t=>t.transaction.id===tx.id&&t.fundingApproval&&t.entryId)));
const closeResults=[];
for (const period of periods) {
  assert.equal((await client.mutation(api.demoEvidence.signClose,{scope,period,seatId:"controller",token:tokens.controller})).status,"open");
  const closed=await human.mutation(api.demoEvidence.signClose,{scope,period});
  assert.equal(closed.status,"closed");closeResults.push({period,...closed});
}
const providerContract=profile==="sandbox"?{provider:"increase",environment:"sandbox",specVersion:increaseProvenance.upstreamInfoVersion,specSha256:increaseProvenance.upstreamSha256,pinnedSubsetSha256:increaseProvenance.subsetSha256,fixtureSha256:increaseProvenance.fixtureSha256}:{provider:"fake",environment:"local",contractVersion:1,storage:"sqlite"};
const report={profile,status:"passed",identityMode,commit:spawnSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim(),scope,providerContract,seed:7,fixtureHash:createHash("sha256").update(JSON.stringify(source.event)).digest("hex"),faultSchedule:profile==="local"?["accept_then_lost_response","worker_exit","missing_webhook"]:[],versionId:requested.versionId,commandId:approved.commandId,bankEvidence,review,evidence,closeResults,processRecovery};
const reportPath=path.join(artifactDir,"report.json");fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({profile,status:"passed",identityMode,reportPath,commandId:approved.commandId,transactionId:paymentEvidence[0]?.transaction.id,entryId:paymentEvidence[0]?.entryId,closeResults},null,2));
