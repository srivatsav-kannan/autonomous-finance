/** Operator-only setup of the reserved Auth0/Increase sandbox. Never used by browser requests. */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";
import { parseAPAuth0Config } from "./auth";
import { parseAPSandboxConfig } from "./sandbox-runtime";
import { AP_POLICY_VERSION } from "./contracts";
import { PAYMENT_EXECUTOR_VERSION } from "../payments/contracts";
import {
  businessDateSchema,
  parseBankScope,
} from "../payments/domain/validation";
import { PrivateStore, hash, canonical } from "./quickbooks/private-store";

export const BOOTSTRAP_URL = "http://127.0.0.1:3252";
export class BootstrapError extends Error {}
const fail = (code: string): never => {
  throw new BootstrapError(code);
};
const json = (value: string | undefined) => {
  try {
    return JSON.parse(value ?? "");
  } catch {
    return fail("bootstrap_private_configuration_invalid");
  }
};
const nonempty = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((v) => !/[\x00-\x1f\x7f]/.test(v));
const configSchema = z
  .object({
    scope: z
      .object({
        organizationId: nonempty,
        runId: z.string().regex(/^ap97-[A-Za-z0-9-]+$/),
        provider: z.literal("increase"),
        environment: z.literal("sandbox"),
        accountId: z.string().regex(/^(?:sandbox_)?account_[A-Za-z0-9]+$/),
      })
      .strict(),
    beneficiary: z
      .object({
        vendor: nonempty,
        externalAccountId: z.string().regex(/^(?:sandbox_)?external_account_[A-Za-z0-9]+$/),
        version: nonempty,
      })
      .strict(),
    date: businessDateSchema,
    periods: z
      .array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/))
      .min(1)
      .max(24),
    controllerLimitCents: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    activitySince: z.string().datetime({ offset: false }),
    context: z
      .object({
        supplier: z
          .object({
            supplierId: nonempty,
            legalName: nonempty,
            aliases: z.array(nonempty).optional(),
          })
          .strict(),
        coding: z
          .object({
            account: nonempty,
            store: nonempty.nullable(),
            department: nonempty.nullable(),
            project: nonempty.nullable(),
            treatment: z.enum([
              "expense",
              "inventory",
              "prepayment",
              "fixed_asset",
              "tax",
            ]),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export function parseBootstrapConfig(env: Record<string, string | undefined>) {
  try {
    if (
      env.AP_SANDBOX_CONVEX_URL !== BOOTSTRAP_URL ||
      (env.CONVEX_URL && env.CONVEX_URL !== BOOTSTRAP_URL)
    )
      fail("bootstrap_backend_url_invalid");
    const auth = parseAPAuth0Config(env);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(auth.clientId))
      fail("bootstrap_auth0_client_invalid");
    const c = configSchema.parse({
      scope: parseBankScope(json(env.AP_BANK_SCOPE)),
      beneficiary: json(env.AP_SANDBOX_BENEFICIARY),
      context: json(env.AP_SANDBOX_TRUSTED_CONTEXT),
      date: env.AP_BOOTSTRAP_DATE,
      periods: json(env.AP_BOOTSTRAP_PERIODS),
      controllerLimitCents: Number(env.AP_CONTROLLER_LIMIT_CENTS),
      activitySince: env.AP_SANDBOX_ACTIVITY_SINCE,
    });
    if (
      c.beneficiary.vendor !== c.context.supplier.supplierId ||
      !c.periods.includes(c.date.slice(0, 7)) ||
      new Set(c.periods).size !== c.periods.length
    )
      fail("bootstrap_scope_context_mismatch");
    return {
      ...c,
      periods: [...c.periods].sort(),
      issuer: auth.issuer,
      clientId: auth.clientId,
    };
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    return fail("bootstrap_private_configuration_invalid");
  }
}
type Config = ReturnType<typeof parseBootstrapConfig>;
type Secrets = {
  admin: string;
  ap: string;
  payments: string;
  controller: string;
  dispatch: string;
  evidence: string;
};
type Inspection = { runHash: string | null; configHash: string | null };
type State = {
  version: "ap-auth0-bootstrap-v1";
  root: string;
  deploymentName: string;
  config: Config;
  secrets: Secrets;
  prepared: boolean;
  binding?: {
    subjects: string[];
    create: Record<string, any>;
    configure: Record<string, any>;
    runHash: string;
    configHash: string;
    phase: "intent" | "creating" | "created" | "configuring" | "bound";
    operatorBoundAt: number;
    source: "explicit_operator_environment";
  };
};
export type BootstrapTransport = {
  instance(): Promise<string>;
  environment(): Promise<Record<string, string>>;
  update(values: Record<string, string>): Promise<void>;
  inspect(secret: string, runId: string): Promise<Inspection>;
  mutate(
    name: "admin:createRun" | "demoPayments:configure",
    args: Record<string, any>,
  ): Promise<any>;
};
async function localDeployment(root: string) {
  const canonicalRoot = await realpath(root);
  const location = path.join(
    canonicalRoot,
    ".convex/local/default/config.json",
  );
  if ((await realpath(location)) !== location)
    fail("bootstrap_backend_config_symlink");
  const f = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await f.stat();
    if (!stat.isFile() || stat.size > 65536 || stat.uid !== process.getuid?.())
      fail("bootstrap_backend_config_invalid");
    const d = JSON.parse(await f.readFile("utf8"));
    if (
      d.ports?.cloud !== 3252 ||
      d.ports?.site !== 3253 ||
      typeof d.deploymentName !== "string" ||
      !d.deploymentName ||
      typeof d.adminKey !== "string" ||
      !d.adminKey
    )
      fail("bootstrap_reserved_backend_required");
    return {
      root: canonicalRoot,
      deploymentName: d.deploymentName as string,
      adminKey: d.adminKey as string,
    };
  } finally {
    await f.close();
  }
}
/** Deployment credential is used only for environment management, never a human identity. */
function transport(deployment: { adminKey: string }): BootstrapTransport {
  const fetchLocal: typeof fetch = (input, init = {}) => {
    const u = new URL(String(input));
    if (u.origin !== BOOTSTRAP_URL) fail("bootstrap_transport_origin_invalid");
    return fetch(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  };
  const client = new ConvexHttpClient(BOOTSTRAP_URL, {
    logger: false,
    fetch: fetchLocal,
  });
  async function request(route: string, body?: unknown) {
    const r = await fetchLocal(BOOTSTRAP_URL + route, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? {}
          : {
              Authorization: `Convex ${deployment.adminKey}`,
              "Content-Type": "application/json",
            },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!r.ok) fail("bootstrap_backend_request_failed");
    const text = await r.text();
    if (text.length > 1048576) fail("bootstrap_backend_response_invalid");
    return text;
  }
  return {
    instance: () => request("/instance_name"),
    async environment() {
      const r = json(
        await request("/api/query", {
          path: "_system/cli/queryEnvironmentVariables",
          format: "convex_encoded_json",
          args: [{}],
        }),
      );
      if (
        r.status !== "success" ||
        !Array.isArray(r.value) ||
        r.value.some(
          (x: any) => typeof x.name !== "string" || typeof x.value !== "string",
        ) ||
        new Set(r.value.map((x: any) => x.name)).size !== r.value.length
      )
        fail("bootstrap_environment_response_invalid");
      return Object.fromEntries(r.value.map((x: any) => [x.name, x.value]));
    },
    async update(values) {
      await request("/api/update_environment_variables", {
        changes: Object.entries(values).map(([name, value]) => ({
          name,
          value,
        })),
      });
    },
    inspect: (secret, runId) =>
      client.query(
        makeFunctionReference<"query">("apSandboxBootstrap:inspect"),
        { secret, runId },
      ),
    mutate: (name, args) =>
      client.mutation(makeFunctionReference<"mutation">(name), args),
  };
}
function backendEnv(s: State) {
  return {
    KERNEL_ADMIN_SECRET: s.secrets.admin,
    AP_DISPATCH_SECRET: s.secrets.dispatch,
    AP_EVIDENCE_SECRET: s.secrets.evidence,
    AP_BANK_SCOPE: canonical(s.config.scope),
    AP_HUMAN_AUTH_ISSUER: s.config.issuer,
    AP_HUMAN_AUTH_AUDIENCE: s.config.clientId,
  };
}
function gatewayEnv(s: State): Record<string, string> {
  return {
    AP_SANDBOX_CONVEX_URL: BOOTSTRAP_URL,
    // The existing gateway loads dotenv only for undefined keys. Suppress legacy bindings/secrets.
    AP_HUMAN_SUBJECT: "",
    AP_HUMAN_JWT: "",
    KERNEL_ADMIN_SECRET: "",
    AP_DISPATCH_SECRET: "",
    AP_EVIDENCE_SECRET: "",
    INCREASE_SANDBOX_API_KEY: "",
    INCREASE_SANDBOX_WEBHOOK_SECRET: "",
    AP_BANK_SCOPE: canonical(s.config.scope),
    AP_HUMAN_AUTH_ISSUER: s.config.issuer,
    AP_HUMAN_AUTH_AUDIENCE: s.config.clientId,
    AP_SANDBOX_AP_SEAT_ID: "ap97-ap",
    AP_SANDBOX_AP_SEAT_TOKEN: s.secrets.ap,
    AP_SANDBOX_PAYMENTS_SEAT_ID: "ap97-payments",
    AP_SANDBOX_PAYMENTS_SEAT_TOKEN: s.secrets.payments,
    AP_SANDBOX_CONTROLLER_SEAT_ID: "ap97-controller",
    AP_SANDBOX_CONTROLLER_SEAT_TOKEN: s.secrets.controller,
    AP_SANDBOX_TRUSTED_CONTEXT: JSON.stringify(s.config.context),
    AP_HUMAN_SUBJECTS: JSON.stringify(
      s.binding?.phase === "bound" ? s.binding.subjects : [],
    ),
  };
}
function bindingPlan(s: State, subjects: string[]) {
  const agents = [
    {
      seatId: "ap97-ap",
      role: "ap_clerk",
      name: "AP intake",
      tokenHash: createHash("sha256").update(s.secrets.ap).digest("hex"),
    },
    {
      seatId: "ap97-payments",
      role: "payments",
      name: "Payment preparation",
      tokenHash: createHash("sha256").update(s.secrets.payments).digest("hex"),
    },
    {
      seatId: "ap97-controller",
      role: "controller",
      name: "Controller proposals",
      tokenHash: createHash("sha256")
        .update(s.secrets.controller)
        .digest("hex"),
    },
  ].map((v) => ({ ...v, kind: "agent" }));
  // Human seat tokens are random and unavailable as agent credentials. Authentication is normal Auth0.
  const humans = subjects.map((subject, i) => ({
    subject,
    seatId: `ap97-human-${i + 1}`,
    tokenHash: hash(randomBytes(32).toString("hex")),
  }));
  const create = {
    runId: s.config.scope.runId,
    label: "Auth0 operator-bound AP sandbox",
    company: "Operator-reviewed AP sandbox",
    simDate: s.config.date,
    seats: [
      ...agents,
      ...humans.map((h) => ({
        seatId: h.seatId,
        role: "human_cfo",
        name: "Explicit operator-bound human",
        kind: "human",
        tokenHash: h.tokenHash,
      })),
    ],
    periods: s.config.periods,
  };
  const configure = {
    scope: s.config.scope,
    paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
    beneficiary: s.config.beneficiary,
    policyVersion: AP_POLICY_VERSION,
    controllerLimitCents: s.config.controllerLimitCents,
    humanSubjects: humans.map(({ subject, seatId }) => ({ subject, seatId })),
    activitySince: s.config.activitySince,
  };
  return {
    subjects,
    create,
    configure,
    runHash: hash(create),
    configHash: hash(configure),
    phase: "intent" as const,
    operatorBoundAt: Date.now(),
    source: "explicit_operator_environment" as const,
  };
}
/** Values never leave via the return value. Transport injection is for local protocol tests. */
export async function bootstrapSandbox(
  mode: "prepare" | "bind",
  env: Record<string, string | undefined>,
  root = process.cwd(),
  injected?: BootstrapTransport,
) {
  const config = parseBootstrapConfig(env),
    deployment = await localDeployment(root);
  const store = new PrivateStore(
    path.join(deployment.root, "var/auth0-bootstrap"),
  );
  return store.lock("operator-bootstrap", async () => {
    const remote = injected ?? transport(deployment);
    if ((await remote.instance()) !== deployment.deploymentName)
      fail("bootstrap_backend_identity_mismatch");
    let s = await store.read<State>("state.json");
    if (!s) {
      if (mode !== "prepare") fail("bootstrap_prepare_required");
      const secret = () => randomBytes(32).toString("hex");
      const admin = env.KERNEL_ADMIN_SECRET ?? secret();
      if (admin.length < 32 || /[\s]/.test(admin))
        fail("bootstrap_admin_secret_invalid");
      s = {
        version: "ap-auth0-bootstrap-v1",
        root: deployment.root,
        deploymentName: deployment.deploymentName,
        config,
        secrets: {
          admin,
          ap: secret(),
          payments: secret(),
          controller: secret(),
          dispatch: secret(),
          evidence: secret(),
        },
        prepared: false,
      };
      await store.write("state.json", s);
    }
    if (
      s.version !== "ap-auth0-bootstrap-v1" ||
      s.root !== deployment.root ||
      s.deploymentName !== deployment.deploymentName ||
      canonical(s.config) !== canonical(config) ||
      (env.KERNEL_ADMIN_SECRET && env.KERNEL_ADMIN_SECRET !== s.secrets.admin)
    )
      fail("bootstrap_configuration_conflict");
    if (
      new Set(Object.values(s.secrets)).size !== 6 ||
      Object.values(s.secrets).some(
        (v) => typeof v !== "string" || v.length < 32,
      )
    )
      fail("bootstrap_credentials_invalid");
    const wanted = backendEnv(s),
      existing = await remote.environment();
    for (const [key, value] of Object.entries(wanted))
      if (existing[key] !== undefined && existing[key] !== value)
        fail("bootstrap_backend_environment_conflict");
    if (mode === "prepare") {
      const missing = Object.fromEntries(
        Object.entries(wanted).filter(([k]) => existing[k] === undefined),
      );
      if (Object.keys(missing).length) await remote.update(missing);
      const confirmed = await remote.environment();
      if (Object.entries(wanted).some(([k, v]) => confirmed[k] !== v))
        fail("bootstrap_backend_environment_unverified");
      s.prepared = true;
      await store.write("state.json", s);
      await store.write("gateway.json", gatewayEnv(s));
      await store.write("dispatch.json", {
        CONVEX_URL: BOOTSTRAP_URL,
        AP_BANK_SCOPE: JSON.stringify(config.scope),
        AP_DISPATCH_SECRET: s.secrets.dispatch,
      });
      await store.write("evidence.json", {
        CONVEX_URL: BOOTSTRAP_URL,
        AP_BANK_SCOPE: JSON.stringify(config.scope),
        AP_EVIDENCE_SECRET: s.secrets.evidence,
      });
      parseAPSandboxConfig(gatewayEnv(s), deployment.root);
      return {
        stage: "prepared",
        backendEnvironmentVerified: true,
        humanBound: s.binding?.phase === "bound",
        browserVerification: "pending",
        paymentWorkerStarted: false,
      };
    }
    if (
      !s.prepared ||
      Object.entries(wanted).some(([k, v]) => existing[k] !== v)
    )
      fail("bootstrap_prepare_required");
    const auth = parseAPAuth0Config(env),
      subjects = [
        ...new Set([
          ...(auth.approvedSubject ? [auth.approvedSubject] : []),
          ...(auth.approvedSubjects ?? []),
        ]),
      ].sort();
    if (!subjects.length) fail("bootstrap_explicit_human_subjects_required");
    if (s.binding && canonical(s.binding.subjects) !== canonical(subjects))
      fail("bootstrap_human_binding_immutable");
    const before = await remote.inspect(s.secrets.admin, config.scope.runId);
    if (!s.binding) {
      if (before.runHash || before.configHash)
        fail("bootstrap_existing_run_refused");
      s.binding = bindingPlan(s, subjects);
      await store.write("state.json", s);
    }
    const b = s.binding;
    if (before.runHash && before.runHash !== b.runHash)
      fail("bootstrap_existing_run_conflict");
    if (before.configHash && before.configHash !== b.configHash)
      fail("bootstrap_existing_configuration_conflict");
    if (!before.runHash) {
      if (b.phase !== "intent") fail("bootstrap_missing_previous_run");
      b.phase = "creating";
      await store.write("state.json", s);
      const result = await remote.mutate("admin:createRun", {
        ...b.create,
        secret: s.secrets.admin,
      });
      if (!result?.ok) fail("bootstrap_run_creation_unconfirmed");
    }
    const created = await remote.inspect(s.secrets.admin, config.scope.runId);
    if (created.runHash !== b.runHash)
      fail("bootstrap_run_creation_unconfirmed");
    if (created.configHash && created.configHash !== b.configHash)
      fail("bootstrap_existing_configuration_conflict");
    if (!created.configHash) {
      if (b.phase === "bound") fail("bootstrap_missing_previous_configuration");
      b.phase = "configuring";
      await store.write("state.json", s);
      const result = await remote.mutate("demoPayments:configure", {
        ...b.configure,
        secret: s.secrets.admin,
      });
      if (!result?.ok) fail("bootstrap_configuration_unconfirmed");
    }
    const confirmed = await remote.inspect(s.secrets.admin, config.scope.runId);
    if (
      confirmed.runHash !== b.runHash ||
      confirmed.configHash !== b.configHash
    )
      fail("bootstrap_binding_unconfirmed");
    b.phase = "bound";
    await store.write("state.json", s);
    await store.write("gateway.json", gatewayEnv(s));
    return {
      stage: "bound",
      humanBound: true,
      explicitHumanCount: subjects.length,
      browserVerification: "pending",
      paymentWorkerStarted: false,
    };
  });
}
