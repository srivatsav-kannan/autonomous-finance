/** Trusted operator harness: release a payment that was claimed but never accepted by the bank.
 * Usage: npm run ops:release-unsent -- <demoCommands id> "<reason>"
 * Needs CONVEX_URL, AP_BANK_SCOPE, AP_HUMAN_JWT and read access to the bank (Increase API key or
 * AP_FAKE_BANK_PATH). It never sends a transfer, mints a key or edits the saved request. */
import fs from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { openFakeBank } from "../src/integrations/banking/fake";
import { IncreaseSandboxBank } from "../src/integrations/banking/increase";
import { createConvexPaymentCommands } from "../src/payments/adapters/convex-payment-commands";
import { createPaymentCommandService } from "../src/payments/application/payment-commands";
import { ReleaseUnsentPayment } from "../src/payments/application/release-unsent-payment";
import { parseBankScope } from "../src/payments/domain/validation";

const [commandId, reason] = process.argv.slice(2);
if (!commandId || !reason?.trim()) throw new Error('Usage: npm run ops:release-unsent -- <commandId> "<reason>"');
if (!process.env.CONVEX_URL || !process.env.AP_BANK_SCOPE || !process.env.AP_HUMAN_JWT) throw new Error("CONVEX_URL, AP_BANK_SCOPE and AP_HUMAN_JWT required");
const scope = parseBankScope(JSON.parse(process.env.AP_BANK_SCOPE));
const human = new ConvexHttpClient(process.env.CONVEX_URL);
human.setAuth(process.env.AP_HUMAN_JWT);
const fakePath = process.env.AP_FAKE_BANK_PATH;
if (scope.provider === "fake" && (!fakePath || !fs.existsSync(fakePath))) throw new Error("Existing AP_FAKE_BANK_PATH required");
const fake = scope.provider === "fake" ? openFakeBank({ path: fakePath!, scope, seed: Number(process.env.AP_SEED ?? 7) }) : undefined;
try {
  const bank = fake?.provider ?? new IncreaseSandboxBank({ scope, apiKey: process.env.INCREASE_SANDBOX_API_KEY ?? "", resolveCommand: async () => null });
  const review = await human.query(api.demoPayments.humanReview, { scope });
  const row = review.commands.find(c => c._id === commandId);
  if (!row) throw new Error("Command not found in this scope");
  const commands = createPaymentCommandService(createConvexPaymentCommands(human, scope, { kind: "human" }));
  const check = await new ReleaseUnsentPayment(commands, bank).release({ commandId: row._id as Id<"demoCommands">, command: row.command,
    execution: row.execution, firstAttemptAt: row.firstAttemptAt, providerTransferId: row.providerTransferId, release: row.release }, reason);
  console.log(JSON.stringify({ released: commandId, providerCheck: check }, null, 2));
} finally { fake?.close(); }
