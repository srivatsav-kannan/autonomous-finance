import {
  mkdtemp,
  rm,
  stat,
  readFile,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  OAuth,
  CALLBACK,
  SCOPE,
  configFromEnv,
  type Config,
  type Transport,
} from "../../src/ap-system/quickbooks/oauth";
import {
  PrivateStore,
  QboError,
  hash,
  safeError,
} from "../../src/ap-system/quickbooks/private-store";
import { QboClient } from "../../src/ap-system/quickbooks/client";
import {
  SyncJournal,
  QuickBooksDispatcher,
} from "../../src/ap-system/quickbooks/sync";
import type {
  Mappings,
  Plan,
  Operation,
} from "../../src/ap-system/quickbooks/types";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});
const config: Config = {
  clientId: "test-client",
  clientSecret: "never-print-secret",
  realmId: "123",
  redirectUri: CALLBACK,
  environment: "sandbox",
};
const tokens = (suffix = "1") => ({
  access_token: `access-secret-${suffix}`,
  refresh_token: `refresh-secret-${suffix}`,
  token_type: "bearer",
  expires_in: 3600,
  x_refresh_token_expires_in: 864000,
  x_refresh_token_hard_expires_in: 1000000,
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
const mappings: Mappings = {
  version: "operator-reviewed-v1",
  realmId: "123",
  country: "US",
  vendors: { vendor: { id: "5", displayName: "Supplier" } },
  accounts: {
    "2000": { id: "33", name: "Accounts Payable", type: "Accounts Payable" },
    "1000": { id: "35", name: "Checking", type: "Bank" },
    "5000": { id: "7", name: "Supplies", type: "Expense" },
  },
  apAccount: "2000",
  bankAccount: "1000",
};
const authorization = (p: Plan) => ({
  subject: "test-authorized-writer",
  planHash: hash(p),
  decidedAt: Date.now(),
});
function plan(): Plan {
  return {
    version: "ap-qbo-operation-v1",
    realmId: "123",
    minorVersion: 75,
    entity: "Bill",
    identity: "Bill:org:run:bill-1",
    links: {
      caseId: "case-1",
      billId: "bill-1",
      recognitionJournalId: "entry-1",
      paymentVersionId: null,
      commandId: null,
      bankTransactionId: null,
      settlementJournalId: null,
      creditId: null,
    },
    mappingHash: hash(mappings),
    payload: {
      DocNumber: "AP123456789012345678",
      PrivateNote: "ap-sync:marker",
      VendorRef: { value: "5" },
      TotalAmt: 77,
      Line: [
        {
          Amount: 77,
          DetailType: "AccountBasedExpenseLineDetail",
          AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } },
        },
      ],
    },
  };
}
async function store() {
  const root = await mkdtemp(join(tmpdir(), "ap-qbo-test-"));
  dirs.push(root);
  return new PrivateStore(root);
}
async function grant(oauth: OAuth, session = "a".repeat(64)) {
  const url = new URL(await oauth.begin(session));
  const cb = new URL(CALLBACK);
  cb.search = new URLSearchParams({
    state: url.searchParams.get("state")!,
    code: "private-code",
    realmId: "123",
  }).toString();
  await oauth.complete(cb, session);
  return cb;
}
async function protocol(
  handle: (url: URL, init: RequestInit) => Promise<Response> | Response,
) {
  const s = await store();
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher: Transport = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.hostname === "oauth.platform.intuit.com") return json(tokens());
    if (url.pathname.endsWith("/companyinfo/123"))
      return json({ CompanyInfo: { Id: "1", Country: "US" } });
    for (const a of Object.values(mappings.accounts))
      if (url.pathname.endsWith(`/account/${a.id}`))
        return json({
          Account: {
            Id: a.id,
            Active: true,
            Name: a.name,
            AccountType: a.type,
          },
        });
    if (url.pathname.endsWith("/vendor/5"))
      return json({
        Vendor: { Id: "5", Active: true, DisplayName: "Supplier" },
      });
    return handle(url, init);
  };
  const oauth = new OAuth(config, s, fetcher);
  await grant(oauth);
  const waits: number[] = [];
  const client = new QboClient(oauth, async (ms) => {
    waits.push(ms);
  });
  return {
    s,
    oauth,
    client,
    journal: new SyncJournal(s, client),
    calls,
    waits,
  };
}
describe("QuickBooks OAuth private protocol", () => {
  it("uses only accounting scope, exact callback and one-time session-bound state", async () => {
    const s = await store();
    const transport = vi.fn<Transport>(async () => json(tokens()));
    const o = new OAuth(config, s, transport);
    const auth = new URL(await o.begin("a".repeat(64)));
    expect(auth.origin).toBe("https://appcenter.intuit.com");
    expect(auth.searchParams.get("scope")).toBe(SCOPE);
    expect(auth.searchParams.get("redirect_uri")).toBe(CALLBACK);
    const cb = new URL(CALLBACK);
    cb.search = new URLSearchParams({
      state: auth.searchParams.get("state")!,
      code: "private-code",
      realmId: "123",
    }).toString();
    await expect(o.complete(cb, "b".repeat(64))).rejects.toThrow(
      "invalid_oauth_state",
    );
    expect(transport).not.toHaveBeenCalled();
    await o.complete(cb, "a".repeat(64));
    await expect(o.complete(cb, "a".repeat(64))).rejects.toThrow(
      "invalid_oauth_state",
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await stat(join(s.root, "tokens.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(s.root)).mode & 0o777).toBe(0o700);
    const [url, init] = transport.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    );
    expect(init?.redirect).toBe("error");
    expect(String(init?.body)).toContain("grant_type=authorization_code");
  });
  it("rejects expired state, wrong realm, duplicate callback params and denial without secrets", async () => {
    const s = await store();
    let now = 100;
    const t = vi.fn<Transport>();
    const o = new OAuth(config, s, t, () => now);
    const auth = new URL(await o.begin("a".repeat(64)));
    const cb = new URL(CALLBACK);
    cb.search = new URLSearchParams({
      state: auth.searchParams.get("state")!,
      code: "secret",
      realmId: "123",
    }).toString();
    now += 600001;
    await expect(o.complete(cb, "a".repeat(64))).rejects.toThrow(
      "invalid_oauth_state",
    );
    expect(t).not.toHaveBeenCalled();
    const fresh = new URL(await o.begin("a".repeat(64)));
    cb.searchParams.set("state", fresh.searchParams.get("state")!);
    cb.searchParams.set("realmId", "999");
    await expect(o.complete(cb, "a".repeat(64))).rejects.toThrow(
      "oauth_wrong_realm",
    );
    cb.searchParams.append("code", "another");
    await expect(o.complete(cb, "a".repeat(64))).rejects.toThrow(
      "invalid_oauth_callback",
    );
    expect(safeError(new Error("Bearer access-secret private-code"))).toBe(
      "internal_error",
    );
  });
  it("serializes concurrent refresh and persists the latest rotated refresh token atomically", async () => {
    const s = await store();
    let now = 1;
    const bodies: string[] = [];
    const o = new OAuth(
      config,
      s,
      async (_url, init) => {
        bodies.push(String(init?.body));
        return json(tokens(String(bodies.length)));
      },
      () => now,
    );
    await grant(o);
    now += 3600001;
    const access = await Promise.all([o.access(), o.access(), o.access()]);
    expect(new Set(access)).toEqual(new Set(["access-secret-2"]));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("refresh_token=refresh-secret-1");
    expect(await s.read("tokens.json")).toMatchObject({
      refresh: "refresh-secret-2",
      generation: 2,
      blocked: false,
    });
    await o.access("access-secret-1");
    expect(bodies).toHaveLength(2);
  });
  it("blocks a revoked or ambiguous refresh until a new grant instead of reusing spent tokens", async () => {
    const s = await store();
    let now = 1;
    let n = 0;
    const o = new OAuth(
      config,
      s,
      async () => {
        if (n++)
          return json(
            { error: "invalid_grant", error_description: "private-secret" },
            400,
          );
        return json(tokens());
      },
      () => now,
    );
    await grant(o);
    now += 3600001;
    await expect(o.access()).rejects.toThrow("oauth_reauthorization_required");
    await expect(o.access()).rejects.toThrow("oauth_reauthorization_required");
    expect(n).toBe(2);
    expect(await s.read("tokens.json")).toMatchObject({ blocked: true });
  });
  it("rejects production/redirect overrides and insecure local permissions", async () => {
    expect(() => configFromEnv({ QBO_ENVIRONMENT: "production" })).toThrow(
      "configuration_required",
    );
    const s = await store();
    await chmod(s.root, 0o755);
    await expect(s.read("tokens.json")).rejects.toThrow(
      "unsafe_private_directory",
    );
  });
});
describe("QuickBooks immutable operations and bounded protocol", () => {
  it("persists an immutable request before sending and replays one external Bill", async () => {
    let writes = 0;
    let saved: Record<string, unknown> | null = null;
    const p = plan();
    const f = await protocol(async (_u, i) => {
      if (i.method === "POST") {
        writes++;
        const disk = await f.journal.get(p);
        expect(disk?.state).toBe("sending");
        expect(disk?.payloadHash).toBe(hash(p));
        saved = { ...p.payload, Id: "90", SyncToken: "0" };
        return json({ Bill: saved });
      }
      return json(
        _u.pathname.endsWith("/bill/90")
          ? { Bill: saved }
          : { QueryResponse: {} },
      );
    });
    const op = await f.journal.execute(
      p,
      mappings,
      undefined,
      authorization(p),
    );
    expect(op).toMatchObject({
      state: "succeeded",
      externalId: "90",
      syncToken: "0",
      attempts: 1,
    });
    await f.journal.execute(p, mappings, undefined, authorization(p));
    expect(writes).toBe(1);
    const post = f.calls.find(
      (c) => c.init.method === "POST" && c.url.pathname.endsWith("/bill"),
    )!;
    expect(post.url.origin).toBe("https://sandbox-quickbooks.api.intuit.com");
    expect(post.url.searchParams.get("minorversion")).toBe("75");
    expect(post.url.searchParams.get("requestid")).toBe(op.requestId);
    expect(op.requestId.length).toBeLessThanOrEqual(50);
    await expect(
      f.journal.execute(
        { ...p, payload: { ...p.payload, TotalAmt: 78 } },
        mappings,
      ),
    ).rejects.toThrow("immutable_operation_conflict");
    expect(writes).toBe(1);
  });
  it("serializes distinct operation writes within the same realm", async () => {
    let inFlight = 0,
      max = 0;
    const f = await protocol(async (_url, init) => {
      if (init.method !== "POST") return json({ QueryResponse: {} });
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return json({
        Bill: { ...JSON.parse(String(init.body)), Id: "90", SyncToken: "0" },
      });
    });
    const a = plan();
    const b = {
      ...plan(),
      identity: "Bill:org:run:bill-2",
      payload: {
        ...plan().payload,
        DocNumber: "AP" + hash("second").slice(0, 18),
      },
    };
    const result = await Promise.all(
      [a, b].map((p) =>
        f.journal.execute(p, mappings, undefined, authorization(p)),
      ),
    );
    expect(result.every((r) => r.state === "succeeded")).toBe(true);
    expect(max).toBe(1);
  });
  it("reconciles an unknown successful write by marker and never posts a fresh ID", async () => {
    let writes = 0;
    const p = plan();
    const f = await protocol((_u, i) => {
      if (i.method === "POST") {
        writes++;
        throw new Error("timeout with SECRET");
      }
      return json({
        QueryResponse: writes
          ? { Bill: [{ ...p.payload, Id: "91", SyncToken: "0" }] }
          : {},
      });
    });
    await expect(
      f.journal.execute(p, mappings, undefined, authorization(p)),
    ).rejects.toThrow("qbo_transport_unknown");
    const before = await f.journal.get(p);
    expect(before?.state).toBe("unknown");
    const after = await f.journal.execute(
      p,
      mappings,
      undefined,
      authorization(p),
    );
    expect(after.state).toBe("succeeded");
    expect(after.requestId).toBe(before?.requestId);
    expect(writes).toBe(1);
    expect(JSON.stringify(after)).not.toContain("SECRET");
  });
  it("retains unknown absent/ambiguous results and blocks duplicate external matches", async () => {
    let writes = 0;
    const p = plan();
    const f = await protocol((_u, i) => {
      if (i.method === "POST") {
        writes++;
        return json({}, 503);
      }
      return json({ QueryResponse: {} });
    });
    await expect(
      f.journal.execute(p, mappings, undefined, authorization(p)),
    ).rejects.toThrow("qbo_write_unknown");
    expect(
      (await f.journal.execute(p, mappings, undefined, authorization(p))).state,
    ).toBe("unknown");
    expect(writes).toBe(1);
    const g = await protocol(() =>
      json({
        QueryResponse: {
          Bill: [
            { ...p.payload, Id: "1", SyncToken: "0" },
            { ...p.payload, Id: "2", SyncToken: "0" },
          ],
        },
      }),
    );
    await expect(
      g.journal.execute(p, mappings, undefined, authorization(p)),
    ).rejects.toThrow("external_mapping_conflict");
    expect((await g.journal.get(p))?.state).toBe("conflict");
  });
  it("treats crash-retained sending as unknown and stale external edits as conflicts", async () => {
    const p = plan();
    const f = await protocol(() => json({ QueryResponse: {} }));
    await f.s.write(f.journal.key(p), {
      ...p,
      requestId: `ap-${hash({ realm: p.realmId, identity: p.identity }).slice(0, 44)}`,
      payloadHash: hash(p),
      state: "sending",
      createdAt: 1,
      updatedAt: 1,
      attempts: 1,
      externalId: null,
      syncToken: null,
      lastError: null,
      responseHash: null,
    });
    expect(
      (await f.journal.execute(p, mappings, undefined, authorization(p))).state,
    ).toBe("unknown");
    expect(
      f.calls.filter(
        (c) => c.init.method === "POST" && c.url.pathname.endsWith("/bill"),
      ),
    ).toHaveLength(0);
    const g = await protocol((url, i) =>
      url.pathname.endsWith("/query")
        ? json({ QueryResponse: {} })
        : json({
            Bill: {
              ...p.payload,
              Id: "92",
              SyncToken: i.method === "POST" ? "0" : "1",
            },
          }),
    ); // A successful empty preflight uses Intuit's explicit empty query envelope.
    await g.journal.execute(p, mappings, undefined, authorization(p));
    await expect(
      g.journal.execute(p, mappings, undefined, authorization(p)),
    ).rejects.toThrow("external_stale_or_changed");
    expect((await g.journal.get(p))?.state).toBe("conflict");
  });
  it("does not downgrade unknown or succeeded receipts after read-only 429 failures", async () => {
    const p = plan();
    let unknown = false;
    const f = await protocol((_url, init) => {
      if (init.method === "POST") {
        unknown = true;
        throw Error("lost");
      }
      return unknown
        ? json({}, 429, { "Retry-After": "120" })
        : json({ QueryResponse: {} });
    });
    await expect(
      f.journal.execute(p, mappings, undefined, authorization(p)),
    ).rejects.toThrow("qbo_transport_unknown");
    await expect(
      f.journal.execute(p, mappings, undefined, authorization(p)),
    ).rejects.toThrow("qbo_retry_later");
    expect((await f.journal.get(p))?.state).toBe("unknown");
    let done = false;
    const g = await protocol((_url, init) => {
      if (init.method === "POST") {
        done = true;
        return json({ Bill: { ...p.payload, Id: "94", SyncToken: "0" } });
      }
      return done
        ? json({}, 429, { "Retry-After": "120" })
        : json({ QueryResponse: {} });
    });
    await g.journal.execute(p, mappings, undefined, authorization(p));
    await expect(
      g.journal.execute(p, mappings, undefined, authorization(p)),
    ).rejects.toThrow("qbo_retry_later");
    expect((await g.journal.get(p))?.state).toBe("succeeded");
  });
  it("refuses altered stored payloads even when their old hash field is unchanged", async () => {
    const p = plan();
    const f = await protocol(() => json({ QueryResponse: {} }));
    await f.journal
      .execute(p, mappings, async () => {
        throw new QboError("authority_pending");
      })
      .catch(() => {});
    const op = (await f.journal.get(p))!;
    await f.s.write(f.journal.key(p), {
      ...op,
      payload: { ...op.payload, TotalAmt: 100 },
    });
    await expect(
      f.journal.execute(p, mappings, undefined, authorization(p)),
    ).rejects.toThrow("immutable_operation_conflict");
  });
  it("honors bounded 429 waits and retains same POST body/requestid across definite retries", async () => {
    let n = 0;
    const p = plan();
    const f = await protocol((_u, i) =>
      i.method === "POST"
        ? ++n < 3
          ? json({}, 429, { "Retry-After": "1" })
          : json({ Bill: { ...p.payload, Id: "93", SyncToken: "0" } })
        : json({ QueryResponse: {} }),
    );
    await f.journal.execute(p, mappings, undefined, authorization(p));
    expect(f.waits).toEqual([1000, 1000]);
    const posts = f.calls.filter(
      (c) => c.url.pathname.endsWith("/bill") && c.init.method === "POST",
    );
    expect(new Set(posts.map((c) => c.init.body)).size).toBe(1);
    expect(
      new Set(posts.map((c) => c.url.searchParams.get("requestid"))).size,
    ).toBe(1);
    const g = await protocol(() => json({}, 429, { "Retry-After": "120" }));
    await expect(g.client.request("query", "GET")).rejects.toThrow(
      "qbo_retry_later",
    );
    expect(g.waits).toEqual([]);
  });
  it("refreshes on one 401 only, rejects mapping changes and never follows redirects", async () => {
    let n = 0;
    const f = await protocol(() =>
      ++n === 1 ? json({}, 401) : json({ QueryResponse: {} }),
    );
    await f.client.request("query", "GET");
    expect(
      f.calls.filter((c) => c.url.hostname === "oauth.platform.intuit.com"),
    ).toHaveLength(2);
    expect(f.calls.every((c) => c.init.redirect === "error")).toBe(true);
    await expect(
      f.client.request("https://evil.invalid", "GET"),
    ).rejects.toThrow("invalid_qbo_route");
    const bad = structuredClone(mappings);
    bad.vendors.vendor!.displayName = "Other";
    await expect(f.client.verifyMappings(bad)).rejects.toThrow(
      "vendor_mapping_conflict",
    );
  });
  it("does not expose raw provider errors or support arbitrary update operations", async () => {
    const f = await protocol(() =>
      json(
        {
          Fault: {
            Error: [{ code: "5010", Detail: "access-secret leaked token" }],
          },
        },
        400,
      ),
    );
    await expect(
      f.client.request("bill", "POST", "{}", "same"),
    ).rejects.toThrow("qbo_stale_sync_token");
    expect(safeError(new QboError("qbo_stale_sync_token"))).not.toContain(
      "secret",
    );
    expect("update" in f.client).toBe(false);
  });
});
