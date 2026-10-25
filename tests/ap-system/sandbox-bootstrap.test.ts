import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import schema from "../../convex/schema";
import {
  bootstrapSandbox,
  type BootstrapTransport,
  parseBootstrapConfig,
} from "../../src/ap-system/sandbox-bootstrap";
const modules = import.meta.glob("../../convex/**/*.ts");
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const issuer = "https://owned-fixture.us.auth0.com/";
const input = () => ({
  AP_SANDBOX_CONVEX_URL: "http://127.0.0.1:3252",
  AP_HUMAN_AUTH_ISSUER: issuer,
  AP_HUMAN_AUTH_AUDIENCE: "SyntheticSpaClientId00001",
  AP_BANK_SCOPE: JSON.stringify({
    organizationId: "synthetic-owned-org",
    runId: "ap97-bootstrap-test",
    provider: "increase",
    environment: "sandbox",
    accountId: "account_synthetic",
  }),
  AP_SANDBOX_BENEFICIARY: JSON.stringify({
    vendor: "test-supplier",
    externalAccountId: "external_account_synthetic",
    version: "operator-reviewed-v1",
  }),
  AP_SANDBOX_TRUSTED_CONTEXT: JSON.stringify({
    supplier: {
      supplierId: "test-supplier",
      legalName: "Project-authored synthetic supplier",
    },
    coding: {
      account: "5000",
      store: null,
      department: null,
      project: null,
      treatment: "expense",
    },
  }),
  AP_BOOTSTRAP_DATE: "2026-10-25",
  AP_BOOTSTRAP_PERIODS: '["2026-10","2026-11"]',
  AP_CONTROLLER_LIMIT_CENTS: "5000000",
  AP_SANDBOX_ACTIVITY_SINCE: "2026-10-25T00:00:00.000Z",
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ap-bootstrap-"));
  dirs.push(root);
  const config = path.join(root, ".convex/local/default/config.json");
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      ports: { cloud: 3252, site: 3253 },
      deploymentName: "owned-synthetic",
      adminKey: "local-synthetic-admin-key",
    }),
    { mode: 0o600 },
  );
  const t = convexTest(schema, modules),
    env: Record<string, string> = {},
    calls: string[] = [];
  let instance = "owned-synthetic",
    loseAfter = "";
  const remote: BootstrapTransport = {
    async instance() {
      calls.push("instance");
      return instance;
    },
    async environment() {
      calls.push("environment");
      return { ...env };
    },
    async update(values) {
      calls.push("update");
      Object.assign(env, values);
      for (const [k, v] of Object.entries(values)) vi.stubEnv(k, v);
    },
    inspect: (secret, runId) =>
      t.query(makeFunctionReference<"query">("apSandboxBootstrap:inspect"), {
        secret,
        runId,
      }),
    async mutate(name, args) {
      calls.push(name);
      const result = await t.mutation(
        makeFunctionReference<"mutation">(name),
        args,
      );
      if (loseAfter === name) {
        loseAfter = "";
        throw Error("synthetic lost reply");
      }
      return result;
    },
  };
  const run = (mode: "prepare" | "bind", e: Record<string, string> = input()) =>
    bootstrapSandbox(mode, e, root, remote);
  const subjects = [issuer + "|auth0|operator-1", issuer + "|auth0|operator-2"];
  const binding = () => ({
    ...input(),
    AP_HUMAN_SUBJECTS: JSON.stringify(subjects),
  });
  const saved = () =>
    readFile(path.join(root, "var/auth0-bootstrap/state.json"), "utf8").then(
      JSON.parse,
    );
  return {
    root,
    config,
    t,
    env,
    calls,
    remote,
    run,
    binding,
    subjects,
    saved,
    setInstance: (s: string) => {
      instance = s;
    },
    lose: (s: string) => {
      loseAfter = s;
    },
  };
}
describe("explicit Auth0 sandbox operator bootstrap (offline)", () => {
  it("prepares only reserved deployment settings, private distinct credentials, and identity-only gateway configuration", async () => {
    const f = await fixture(),
      result = await f.run("prepare");
    expect(result).toEqual({
      stage: "prepared",
      backendEnvironmentVerified: true,
      humanBound: false,
      browserVerification: "pending",
      paymentWorkerStarted: false,
    });
    expect(f.calls.filter((c) => c.includes(":"))).toEqual([]);
    expect(await f.t.run((ctx) => ctx.db.query("runs").collect())).toEqual([]);
    const saved = await f.saved();
    expect(new Set(Object.values(saved.secrets)).size).toBe(6);
    for (const filename of [
      "state.json",
      "gateway.json",
      "dispatch.json",
      "evidence.json",
    ])
      expect(
        (await stat(path.join(f.root, "var/auth0-bootstrap", filename))).mode &
          0o777,
      ).toBe(0o600);
    const gateway = JSON.parse(
      await readFile(
        path.join(f.root, "var/auth0-bootstrap/gateway.json"),
        "utf8",
      ),
    );
    expect(gateway.AP_HUMAN_SUBJECTS).toBe("[]");
    expect(gateway.KERNEL_ADMIN_SECRET).toBe("");
    expect(gateway.AP_DISPATCH_SECRET).toBe("");
    expect(gateway.AP_EVIDENCE_SECRET).toBe("");
    expect(gateway.AP_HUMAN_SUBJECT).toBe("");
    expect(gateway.AP_HUMAN_JWT).toBe("");
    await f.run("prepare");
    expect(f.calls.filter((c) => c === "update")).toHaveLength(1);
    expect(await f.saved()).toEqual(saved);
    for (const value of Object.values(saved.secrets))
      expect(JSON.stringify(result)).not.toContain(value);
  });
  it("requires explicit same-issuer humans, binds each independent seat once, and replays without mutations", async () => {
    const f = await fixture();
    await f.run("prepare");
    await expect(f.run("bind")).rejects.toThrow(
      "bootstrap_explicit_human_subjects_required",
    );
    expect(await f.run("bind", f.binding())).toMatchObject({
      stage: "bound",
      explicitHumanCount: 2,
      paymentWorkerStarted: false,
    });
    const state = await f.saved();
    expect(state.binding.operatorBoundAt).toBeGreaterThan(0);
    await f.run("bind", f.binding());
    expect(f.calls.filter((c) => c === "admin:createRun")).toHaveLength(1);
    expect(f.calls.filter((c) => c === "demoPayments:configure")).toHaveLength(
      1,
    );
    const seats = await f.t.run((ctx) => ctx.db.query("seats").collect());
    expect(seats.filter((s) => s.kind === "human")).toHaveLength(2);
    expect(seats.find((s) => s.seatId === "ap97-ap")!.tokenHash).toBe(
      createHash("sha256").update(state.secrets.ap).digest("hex"),
    );
    const scope = JSON.parse(input().AP_BANK_SCOPE);
    for (const [i, tokenIdentifier] of f.subjects.entries())
      expect(
        await f.t
          .withIdentity({
            issuer,
            subject: `auth0|operator-${i + 1}`,
            tokenIdentifier,
          })
          .query(makeFunctionReference<"query">("apIdentity:workspaceAccess"), {
            scope,
          }),
      ).toEqual({ authorized: true });
    await expect(
      f.t
        .withIdentity({ issuer, subject: "auth0|unbound" })
        .query(makeFunctionReference<"query">("apIdentity:workspaceAccess"), {
          scope,
        }),
    ).rejects.toThrow();
    await expect(
      f.run("bind", { ...input(), AP_HUMAN_SUBJECT: issuer + "|auth0|other" }),
    ).rejects.toThrow("bootstrap_human_binding_immutable");
  });
  it.each(["admin:createRun", "demoPayments:configure"] as const)(
    "reconciles a lost %s reply against exact backend hashes without repeating successful setup",
    async (name) => {
      const f = await fixture();
      await f.run("prepare");
      f.lose(name);
      await expect(f.run("bind", f.binding())).rejects.toThrow(
        "synthetic lost reply",
      );
      const gateway = JSON.parse(
        await readFile(
          path.join(f.root, "var/auth0-bootstrap/gateway.json"),
          "utf8",
        ),
      );
      expect(gateway.AP_HUMAN_SUBJECTS).toBe("[]");
      await f.run("bind", f.binding());
      expect(f.calls.filter((c) => c === name)).toHaveLength(1);
      expect((await f.saved()).binding.phase).toBe("bound");
    },
  );
  it("refuses another existing run, changed immutable configuration, and changed deployment secrets", async () => {
    const f = await fixture();
    await f.run("prepare");
    const saved = await f.saved();
    await f.t.mutation(makeFunctionReference<"mutation">("admin:createRun"), {
      secret: saved.secrets.admin,
      runId: saved.config.scope.runId,
      label: "another setup",
      company: "other",
      simDate: "2026-10-25",
      seats: [],
      periods: ["2026-10"],
    });
    await expect(f.run("bind", f.binding())).rejects.toThrow(
      "bootstrap_existing_run_refused",
    );
    expect(f.calls.filter((c) => c.includes(":"))).toEqual([]);
    const g = await fixture();
    await g.run("prepare");
    await g.run("bind", g.binding());
    await g.t.run(async (ctx) => {
      const c = await ctx.db.query("demoConfigs").first();
      await ctx.db.patch(c!._id, { controllerLimitCents: 1 });
    });
    await expect(g.run("bind", g.binding())).rejects.toThrow(
      "bootstrap_existing_configuration_conflict",
    );
    g.env.AP_DISPATCH_SECRET = "foreign-secret";
    await expect(g.run("prepare")).rejects.toThrow(
      "bootstrap_backend_environment_conflict",
    );
  });
  it("rejects wrong ports, wrong live instance, symlinked backend config and insecure saved files before backend mutation", async () => {
    const f = await fixture();
    const d = JSON.parse(await readFile(f.config, "utf8"));
    d.ports.site = 3251;
    await writeFile(f.config, JSON.stringify(d));
    await expect(f.run("prepare")).rejects.toThrow(
      "bootstrap_reserved_backend_required",
    );
    expect(f.calls).toEqual([]);
    d.ports.site = 3253;
    await writeFile(f.config, JSON.stringify(d));
    f.setInstance("another-backend");
    await expect(f.run("prepare")).rejects.toThrow(
      "bootstrap_backend_identity_mismatch",
    );
    expect(f.calls).toEqual(["instance"]);
    const other = path.join(f.root, "config-copy.json");
    await writeFile(other, JSON.stringify(d));
    await rm(f.config);
    await symlink(other, f.config);
    await expect(f.run("prepare")).rejects.toThrow(
      "bootstrap_backend_config_symlink",
    );
    const g = await fixture();
    await g.run("prepare");
    await chmod(path.join(g.root, "var/auth0-bootstrap/state.json"), 0o644);
    await expect(g.run("prepare")).rejects.toThrow("unsafe_private_file");
  });
  it("rejects fake or nonowned configuration and never returns input values from validation errors", () => {
    const good = input();
    for (const override of [
      { AP_HUMAN_AUTH_ISSUER: "https://ap-demo.invalid/" },
      { AP_HUMAN_AUTH_AUDIENCE: "not-a-client" },
      { AP_SANDBOX_CONVEX_URL: "http://127.0.0.1:3250" },
      {
        AP_BANK_SCOPE: JSON.stringify({
          ...JSON.parse(good.AP_BANK_SCOPE),
          provider: "fake",
          environment: "local",
        }),
      },
      {
        AP_SANDBOX_BENEFICIARY: JSON.stringify({
          vendor: "wrong",
          externalAccountId: "external_account_synthetic",
          version: "v1",
        }),
      },
      { AP_HUMAN_SUBJECT: "https://other.auth0.com/|auth0|private-value" },
    ])
      expect(() => parseBootstrapConfig({ ...good, ...override })).toThrow(
        /^bootstrap_/,
      );
  });
  it("uses only the pinned deployment environment protocol and fails closed on a malformed query reply", async () => {
    const f = await fixture(),
      values: Record<string, string> = {},
      calls: Array<{ url: string; body: any; headers: Headers }> = [];
    const fetcher = vi.fn(
      async (url: string | URL | Request, init: RequestInit = {}) => {
        expect(init.redirect).toBe("error");
        const target = new URL(String(url)),
          body = init.body ? JSON.parse(String(init.body)) : null;
        expect(target.origin).toBe("http://127.0.0.1:3252");
        calls.push({
          url: target.pathname,
          body,
          headers: new Headers(init.headers),
        });
        if (target.pathname === "/instance_name")
          return new Response("owned-synthetic");
        expect(new Headers(init.headers).get("Authorization")).toBe(
          "Convex local-synthetic-admin-key",
        );
        if (target.pathname === "/api/query") {
          expect(body).toEqual({
            path: "_system/cli/queryEnvironmentVariables",
            format: "convex_encoded_json",
            args: [{}],
          });
          return Response.json({
            status: "success",
            value: Object.entries(values).map(([name, value]) => ({
              name,
              value,
            })),
          });
        }
        expect(target.pathname).toBe("/api/update_environment_variables");
        for (const change of body.changes) values[change.name] = change.value;
        return new Response("{}");
      },
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await bootstrapSandbox("prepare", input(), f.root)).toMatchObject({
      humanBound: false,
    });
    expect(calls.map((c) => c.url)).toEqual([
      "/instance_name",
      "/api/query",
      "/api/update_environment_variables",
      "/api/query",
    ]);
    const g = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/instance_name")
          ? new Response("owned-synthetic")
          : Response.json({ status: "success" }),
      ),
    );
    await expect(bootstrapSandbox("prepare", input(), g.root)).rejects.toThrow(
      "bootstrap_environment_response_invalid",
    );
  });
  it("protects inspection from unauthenticated callers and returns only comparison hashes", async () => {
    const f = await fixture();
    await f.run("prepare");
    await expect(
      f.remote.inspect("wrong", JSON.parse(input().AP_BANK_SCOPE).runId),
    ).rejects.toThrow("Bootstrap admin authority required");
    await f.run("bind", f.binding());
    const s = await f.saved(),
      result = await f.remote.inspect(s.secrets.admin, s.config.scope.runId);
    expect(Object.keys(result).sort()).toEqual(["configHash", "runHash"]);
    expect(result).toEqual({
      runHash: s.binding.runHash,
      configHash: s.binding.configHash,
    });
  });
});
