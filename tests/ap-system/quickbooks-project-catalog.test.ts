import { mkdtemp, readdir, readFile, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectCatalogClient,
  configuredProjectCatalog,
  PROJECT_ENDPOINT,
  PROJECT_SCOPE,
  type ProjectCatalogConfig,
  type ProjectGrant,
} from "../../src/ap-system/quickbooks/project-catalog";
import { PrivateStore } from "../../src/ap-system/quickbooks/private-store";
import { QboClient } from "../../src/ap-system/quickbooks/client";
import type { OAuth, Transport } from "../../src/ap-system/quickbooks/oauth";
import type { Mappings } from "../../src/ap-system/quickbooks/types";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const now = () => Date.now();
const config = (): ProjectCatalogConfig => ({
  version: "ap-qbo-project-catalog-v1",
  environment: "sandbox",
  realmId: "123",
  ttlMs: 60000,
  acceptedStatuses: ["IN_PROGRESS"],
});
const grant = (): ProjectGrant => ({
  version: "ap-qbo-project-grant-v1",
  environment: "sandbox",
  realmId: "123",
  clientHash: "a".repeat(64),
  grantId: "synthetic-completed-normal-grant",
  scopes: [PROJECT_SCOPE],
  authorizedAt: now() - 1000,
  accessToken: "synthetic-project-secret",
  expiresAt: now() + 600000,
});
const node = (id = "11") => ({
  id,
  name: `Project ${id}`,
  status: "IN_PROGRESS",
  account: { id: "123" },
  customer: { id: "12" },
});
const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
async function store() {
  const root = await mkdtemp(join(tmpdir(), "ap-project-catalog-"));
  dirs.push(root);
  return new PrivateStore(root);
}
async function client(transport?: Transport, c = config(), g = grant()) {
  const s = await store();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = new ProjectCatalogClient(
    c,
    async () => g,
    s,
    async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return transport
        ? transport(url, init)
        : json({
            data: {
              projectManagementProject: node(
                JSON.parse(String(init.body)).variables.id,
              ),
            },
          });
    },
  );
  return { api, s, calls };
}
describe("Read-only authorized QBO project catalog", () => {
  it("queries exact IDs on the sandbox only and retains private hashed evidence without token leakage", async () => {
    const f = await client();
    const r = await f.api.verify({ realmId: "123", projectIds: ["13", "11"] });
    expect(r.projects).toEqual(
      ["11", "13"].map((id) => ({
        id,
        name: `Project ${id}`,
        customerId: "12",
        active: true,
      })),
    );
    expect(r.scope).toBe(PROJECT_SCOPE);
    expect(r.validUntil).toBeGreaterThan(r.observedAt);
    expect(r.responseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.entitlementHash).toMatch(/^[a-f0-9]{64}$/);
    for (const c of f.calls) {
      expect(c.url).toBe(PROJECT_ENDPOINT);
      expect(c.init.redirect).toBe("error");
      expect(c.init.method).toBe("POST");
      const body = JSON.parse(String(c.init.body));
      expect(body.query).toMatch(/^query /);
      expect(body.query).not.toContain("mutation");
      expect(body.variables).toEqual({ id: expect.any(String) });
    }
    const files = await readdir(f.s.root);
    expect(files).toHaveLength(3);
    for (const file of files) {
      const text = await readFile(join(f.s.root, file), "utf8");
      expect(text).not.toContain("synthetic-project-secret");
      expect((await stat(join(f.s.root, file))).mode & 0o777).toBe(0o600);
      if (file.startsWith("project-response-")) {
        const a = JSON.parse(text);
        expect(createHash("sha256").update(a.raw).digest("hex")).toBe(
          a.responseSha256,
        );
      }
    }
  });
  it("does not read or call anything on configuration and rejects missing, foreign, expired or accounting-only grants before HTTP", async () => {
    let calls = 0;
    const s = await store();
    const lazy = configuredProjectCatalog(
      { QBO_PROJECTS_PRIVATE_DIR: s.root },
      async () => {
        calls++;
        throw Error("never");
      },
    );
    expect(calls).toBe(0);
    expect(configuredProjectCatalog({})).toBeUndefined();
    expect(() =>
      configuredProjectCatalog({ QBO_PROJECTS_PRIVATE_DIR: "relative" }),
    ).toThrow("project_catalog_private_path_required");
    await expect(lazy!({ realmId: "123", projectIds: ["11"] })).rejects.toThrow(
      "project_catalog_configuration_required",
    );
    for (const patch of [
      { scopes: ["com.intuit.quickbooks.accounting"] },
      { realmId: "999" },
      { expiresAt: now() - 1 },
      { authorizedAt: -1 },
      { environment: "production" },
    ]) {
      const f = await client(undefined, config(), {
        ...grant(),
        ...patch,
      } as ProjectGrant);
      await expect(
        f.api.verify({ realmId: "123", projectIds: ["11"] }),
      ).rejects.toThrow("project_authorized_grant_required");
      expect(f.calls).toHaveLength(0);
    }
    expect(calls).toBe(0);
  });
  it("uses separate private grant/config files and refuses unsafe permissions", async () => {
    const s = await store();
    await s.write("project-catalog-config.json", config());
    await s.write("project-grant.json", grant());
    const verify = configuredProjectCatalog(
      { QBO_PROJECTS_PRIVATE_DIR: s.root },
      async () => json({ data: { projectManagementProject: node() } }),
    )!;
    expect(
      (await verify({ realmId: "123", projectIds: ["11"] })).projects,
    ).toHaveLength(1);
    await chmod(join(s.root, "project-grant.json"), 0o644);
    await expect(
      verify({ realmId: "123", projectIds: ["11"] }),
    ).rejects.toThrow("unsafe_private_file");
  });
  it("rejects partial GraphQL data, wrong identity/realm/customer, unsupported state and missing envelopes", async () => {
    for (const body of [
      {
        data: { projectManagementProject: node() },
        errors: [{ message: "secret diagnostic must not leak" }],
      },
      { data: { projectManagementProject: { ...node(), id: "99" } } },
      {
        data: {
          projectManagementProject: { ...node(), account: { id: "99" } },
        },
      },
      { data: { projectManagementProject: { ...node(), customer: null } } },
      {
        data: { projectManagementProject: { ...node(), status: "COMPLETED" } },
      },
      { time: "not-data" },
      { data: { projectManagementProject: null } },
      [],
    ]) {
      const f = await client(async () => json(body));
      await expect(
        f.api.verify({ realmId: "123", projectIds: ["11"] }),
      ).rejects.toThrow(
        /project_catalog_(incomplete_or_denied|identity_or_status_conflict)/,
      );
      expect(await readdir(f.s.root).catch(() => [])).toHaveLength(0);
    }
  });
  it("fails closed for duplicate IDs, oversized requests/responses, expired read and denied entitlement", async () => {
    const f = await client();
    for (const ids of [
      ["11", "11"],
      Array.from({ length: 26 }, (_, i) => String(i + 1)),
      ["11' bad"],
      [],
    ])
      await expect(
        f.api.verify({ realmId: "123", projectIds: ids }),
      ).rejects.toThrow("project_catalog_request_invalid");
    expect(f.calls).toHaveLength(0);
    const huge = await client(
      async () => new Response("x".repeat(256 * 1024 + 1)),
    );
    await expect(
      huge.api.verify({ realmId: "123", projectIds: ["11"] }),
    ).rejects.toThrow("project_catalog_response_too_large");
    const denied = await client(async () =>
      json({ secret: "not returned" }, 403),
    );
    await expect(
      denied.api.verify({ realmId: "123", projectIds: ["11"] }),
    ).rejects.toThrow("project_catalog_entitlement_required");
    let time = now();
    const s = await store(),
      g = grant();
    const expired = new ProjectCatalogClient(
      { ...config(), ttlMs: 1000 },
      async () => g,
      s,
      async () => {
        time += 2000;
        return json({ data: { projectManagementProject: node() } });
      },
      () => time,
    );
    await expect(
      expired.verify({ realmId: "123", projectIds: ["11"] }),
    ).rejects.toThrow("project_catalog_expired_during_read");
  });
  it("bounds retries, reuses the exact query and accepts only an externally rotated token of the same grant", async () => {
    let count = 0;
    const s = await store();
    const bodies: string[] = [],
      sleeps: number[] = [];
    const api = new ProjectCatalogClient(
      config(),
      async () => grant(),
      s,
      async (_u, i) => {
        bodies.push(String(i?.body));
        return ++count < 3
          ? json({}, 429, { "Retry-After": "1" })
          : json({ data: { projectManagementProject: node() } });
      },
      now,
      async (ms) => {
        sleeps.push(ms);
      },
    );
    await api.verify({ realmId: "123", projectIds: ["11"] });
    expect(sleeps).toEqual([1000, 1000]);
    expect(new Set(bodies).size).toBe(1);
    let loads = 0,
      requests = 0;
    const g = grant();
    const rotating = new ProjectCatalogClient(
      config(),
      async () => ({ ...g, accessToken: ++loads === 1 ? "old" : "rotated" }),
      await store(),
      async (_u, i) => {
        requests++;
        if (requests === 1) return json({}, 401);
        expect((i!.headers as Record<string, string>).Authorization).toBe(
          "Bearer rotated",
        );
        return json({ data: { projectManagementProject: node() } });
      },
    );
    await rotating.verify({ realmId: "123", projectIds: ["11"] });
    expect(requests).toBe(2);
    const notRotated = await client(async () => json({}, 401));
    await expect(
      notRotated.api.verify({ realmId: "123", projectIds: ["11"] }),
    ).rejects.toThrow("project_grant_reauthorization_required");
    expect(notRotated.calls).toHaveLength(1);
  });
  it("supplies fresh actual transport evidence to accounting mapping verification", async () => {
    const f = await client();
    const catalog = await f.api.verify({ realmId: "123", projectIds: ["11"] });
    const m: Mappings = {
      version: "test",
      realmId: "123",
      country: "US",
      vendors: {},
      accounts: {},
      apAccount: "2000",
      bankAccount: "1000",
      dimensions: {
        version: "ap-qbo-dimensions-v1",
        policyId: "test",
        reviewedBy: "test",
        reviewedAt: now(),
        projects: {
          mode: "qbo_project",
          catalog,
          mappings: {
            remodel: {
              id: "11",
              name: "Project 11",
              customerId: "12",
              billable: false,
            },
          },
        },
      },
    };
    const oauth = {
      config: { realmId: "123" },
      access: async () => "synthetic-accounting-token",
      transport: async (url: URL) =>
        json(
          String(url).includes("companyinfo")
            ? { CompanyInfo: { Id: "123", Country: "US" } }
            : { Customer: { Id: "12", Active: true } },
        ),
    } as unknown as OAuth;
    await new QboClient(oauth, async () => {}, f.api.verify).verifyMappings(m);
    expect(f.calls).toHaveLength(2);
  });
});
