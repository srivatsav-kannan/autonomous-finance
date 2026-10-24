// Test harness only: pause after durable acceptance so the parent can SIGKILL
// this worker before its dispatcher records the response in Convex.
import fs from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { PaymentDispatcher } from "../../src/payments/dispatcher";
import { canonicalJson, type BankScope, type BankCommand } from "../../src/integrations/contracts";
const config = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as { url: string; scope: BankScope; token: string; bankPath: string; seed: number };
const bank = openFakeBank({ path: config.bankPath, scope: config.scope, seed: config.seed });
const fingerprint = (command: BankCommand) => createHash("sha256").update(canonicalJson(command)).digest("hex");
const submitting = {
  recovery: bank.provider.recovery,
  lookupTransfer: async (command: BankCommand, providerTransferId?: string) => {
    process.send?.({ event: "lookup-start", commandSha256: fingerprint(command) });
    return bank.provider.lookupTransfer(command, providerTransferId);
  },
  createTransfer: async (command: BankCommand) => {
    try { return await bank.provider.createTransfer(command); }
    finally {
      if (process.argv.includes("--crash-after-submit")) {
        process.on("disconnect", () => process.exit(87)); // Do not orphan a paused worker if its parent dies.
        const accepted = bank.harness.inspect().transfers;
        assert.equal(accepted.length, 1);
        assert.equal(accepted[0]!.commandId, command.commandId);
        assert.equal(accepted[0]!.idempotencyKey, command.idempotencyKey);
        assert.equal(accepted[0]!.requestHash, command.requestHash);
        assert.ok(process.send, "Crash checkpoint requires parent IPC");
        process.send({ event: "accepted-before-record", commandSha256: fingerprint(command) });
        // A real external SIGKILL bypasses every finally block and SQLite close.
        await new Promise<never>(() => { setInterval(() => {}, 1000); });
      }
    }
  },
};
try { console.log(JSON.stringify(await new PaymentDispatcher(new ConvexHttpClient(config.url), config.scope, config.token, submitting, "demo-dispatch-process").tick())); }
finally { bank.close(); }
