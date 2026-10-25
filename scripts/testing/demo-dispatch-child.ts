// Test harness process. --crash-after-submit kills only the application worker, never the bank.
import fs from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { PaymentDispatcher } from "../../src/payments/dispatcher";
import type { BankScope } from "../../src/integrations/contracts";
const config = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as { url: string; scope: BankScope; token: string; bankPath: string; seed: number };
const bank = openFakeBank({ path: config.bankPath, scope: config.scope, seed: config.seed });
const submitting = { createTransfer: async (command: Parameters<typeof bank.provider.createTransfer>[0]) => {
  try { return await bank.provider.createTransfer(command); }
  finally { if (process.argv.includes("--crash-after-submit")) process.exit(86); }
} };
try { console.log(JSON.stringify(await new PaymentDispatcher(new ConvexHttpClient(config.url), config.scope, config.token, submitting, "demo-dispatch-process").tick())); }
finally { bank.close(); }
