/** Test-only worker for process death before send and after provider acceptance. */
import { appendFileSync, readFileSync } from "node:fs";
import { getFunctionName } from "convex/server";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { PaymentDispatcher } from "../../src/payments/dispatcher";
import type { KernelTransport } from "../../src/payments/evidence";
import type { BankCommand, BankScope } from "../../src/payments/contracts";

const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  url: string; bridgeToken: string; scope: BankScope; token: string;
  bankPath: string; tracePath: string; seed: number;
};
if (new URL(config.url).hostname !== "127.0.0.1") throw new Error("Test bridge must be loopback");
const crash = process.argv[3];
const kernel: KernelTransport = {
  query: async () => { throw new Error("Dispatcher test worker has no query capability"); },
  mutation: async (reference, args) => {
    const response = await fetch(`${config.url}/mutation`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: getFunctionName(reference), args }),
    });
    const result = await response.json() as { value?: unknown; error?: string };
    if (!response.ok) throw new Error(result.error ?? "Test bridge failed");
    return result.value as never;
  },
};
const bank = openFakeBank({ path: config.bankPath, scope: config.scope, seed: config.seed });
const trace = (operation: string, command: BankCommand) => appendFileSync(config.tracePath, `${JSON.stringify({ operation, command })}\n`, { mode: 0o600 });
const provider = {
  ...bank.provider,
  createTransfer: async (command: BankCommand) => {
    trace("submit-enter", command);
    if (crash === "before-send") process.exit(86);
    try { return await bank.provider.createTransfer(command); }
    finally { if (crash === "after-send") process.exit(86); }
  },
  lookupTransfer: (command: BankCommand, providerTransferId?: string) => {
    trace("lookup", command);
    return bank.provider.lookupTransfer(command, providerTransferId);
  },
};
try {
  const result = await new PaymentDispatcher(kernel, config.scope, config.token, provider, "independent-subprocess").tick();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { bank.close(); }
