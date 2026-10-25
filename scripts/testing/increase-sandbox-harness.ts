/** Operator/test process only. Never import this module into agent tools or a normal provider. */
import { BankProviderError, type BankScope } from "../../src/integrations/contracts.js";
import { INCREASE_SANDBOX_ORIGIN } from "../../src/integrations/banking/increase.js";

export type IncreaseSandboxConfiguration = {
  apiKey: string; scope: BankScope; externalAccountId: string; signingSecret?: string;
};
export function sandboxConfiguration(env: NodeJS.ProcessEnv = process.env):
  { status: "ready"; configuration: IncreaseSandboxConfiguration } | { status: "not_run"; missing: string[] } {
  const names = ["INCREASE_SANDBOX_API_KEY", "INCREASE_SANDBOX_ACCOUNT_ID", "INCREASE_SANDBOX_EXTERNAL_ACCOUNT_ID"] as const;
  const missing = names.filter(name => !env[name]);
  if (missing.length) return { status: "not_run", missing };
  return { status: "ready", configuration: {
    apiKey: env.INCREASE_SANDBOX_API_KEY!, externalAccountId: env.INCREASE_SANDBOX_EXTERNAL_ACCOUNT_ID!,
    signingSecret: env.INCREASE_SANDBOX_WEBHOOK_SECRET,
    scope: { organizationId: env.AP_ORGANIZATION_ID ?? "ap-demo", runId: env.AP_RUN_ID ?? "increase-demo", provider: "increase", environment: "sandbox", accountId: env.INCREASE_SANDBOX_ACCOUNT_ID! },
  } };
}

/** Narrow harness controls use a separate instance and credential closure, bound to one account. */
export class IncreaseSandboxHarness {
  readonly #apiKey: string;
  readonly #scope: BankScope;
  readonly #fetch: typeof fetch;
  constructor(options: { apiKey: string; scope: BankScope; fetch?: typeof fetch }) {
    if (options.scope.provider !== "increase" || options.scope.environment !== "sandbox" || !options.scope.organizationId.trim() || !options.scope.runId.trim() || !/^(?:sandbox_)?account_[a-zA-Z0-9]+$/.test(options.scope.accountId) || !options.apiKey) throw new Error("Sandbox-only harness requires sandbox account binding");
    this.#apiKey = options.apiKey;
    this.#scope = { ...options.scope };
    this.#fetch = options.fetch ?? fetch;
  }
  async #action(transferId: string, action: "submit" | "settle" | "return") {
    if (!/^(?:sandbox_)?ach_transfer_[a-zA-Z0-9]+$/.test(transferId)) throw new Error("Invalid transfer identifier");
    const headers = { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" };
    const verifiedTransfer = async () => {
      const current = await this.#fetch(`${INCREASE_SANDBOX_ORIGIN}/ach_transfers/${transferId}`, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!current.ok) throw new BankProviderError("configuration", "Unable to verify sandbox transfer ownership");
      const data = await current.json() as { id?: unknown; account_id?: unknown; status?: unknown };
      if (!data || data.id !== transferId || data.account_id !== this.#scope.accountId) throw new BankProviderError("configuration", "Sandbox control account mismatch");
      return data;
    };
    const data = await verifiedTransfer();
    if (action === "submit") {
      // Increase may submit automatically before the trusted coordinator reaches this step.
      if (data.status === "submitted") return data;
      if (data.status !== "pending_submission") throw new BankProviderError("configuration", "Sandbox submit requires pending_submission; review the current transfer state");
    }
    const response = await this.#fetch(`${INCREASE_SANDBOX_ORIGIN}/simulations/ach_transfers/${transferId}/${action}`, {
      method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(15_000),
      ...(action === "submit" ? {} : { body: JSON.stringify(action === "return" ? { reason: "credit_entry_refused_by_receiver" } : {}) }),
    });
    if (!response.ok) {
      // Automatic submission can also win the race after our initial GET. Confirm the same
      // account-bound resource rather than issuing another simulation request or masking errors.
      if (action === "submit") {
        const latest = await verifiedTransfer();
        if (latest.status === "submitted") return latest;
      }
      throw new BankProviderError("configuration", `Increase sandbox ${action} failed (HTTP ${response.status})`);
    }
    return response.json() as Promise<unknown>;
  }
  submit(transferId: string) { return this.#action(transferId, "submit"); }
  settle(transferId: string) { return this.#action(transferId, "settle"); }
  return(transferId: string) { return this.#action(transferId, "return"); }
}
