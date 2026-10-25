import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { fixture, packet, refs } from "./accounting-fixture";
import { createAPExternalAuthentication } from "../../src/ap-system/auth";
import { createAPSystemServer } from "../../src/ap-system/server";
import { createAPWorkspaceService } from "../../src/ap-system/service";
import {
  configureAPSession,
  closeAPSession,
} from "../../console/src/apAuthSession";
import { apSystemApi } from "../../console/src/apSystemApi";
const issuer = "https://v4-test.us.auth0.com/",
  origin = "http://127.0.0.1:5192";
const subject = (name: string) => `${issuer}|auth0|${name}`;
const servers: ReturnType<typeof createAPSystemServer>[] = [];
afterEach(async () => {
  configureAPSession(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function gateway() {
  const f = await fixture(),
    r = await f.t.mutation(refs.ingest, { ...f.ap, input: packet("V4-AUTH") }),
    d = await f.get(r.caseId);
  for (const key of [
    "QBO_CLIENT_ID",
    "QBO_CLIENT_SECRET",
    "QBO_REALM_ID",
    "QBO_REDIRECT_URI",
    "QBO_ENVIRONMENT",
  ])
    vi.stubEnv(key, "");
  await f.t.run(async (ctx) => {
    const seat = (await ctx.db.query("seats").collect()).find(
      (s) => s.seatId === "human_cfo",
    )!;
    const { _id, _creationTime, ...base } = seat;
    for (const name of ["alice", "bob"])
      await ctx.db.insert("seats", { ...base, seatId: "v4-" + name, name });
    const cfg = (await ctx.db.query("demoConfigs").collect())[0]!;
    await ctx.db.patch(cfg._id, {
      humanSubjects: [
        ...cfg.humanSubjects,
        ...["alice", "bob"].map((n) => ({
          subject: subject(n),
          seatId: "v4-" + n,
        })),
      ],
    });
  });
  const config = {
    issuer,
    domain: "v4-test.us.auth0.com",
    clientId: "synthetic-spa",
    approvedSubjects: [subject("alice"), subject("bob")],
  };
  const clients: any[] = [];
  let beforeMutation: (() => Promise<void>) | undefined;
  // Test seam models a verified ID-token-to-identity result, not signature/issuer cryptography.
  const clientFactory = () => {
    let token = "";
    const client = {
      setAuth: (v: string) => {
        token = v;
      },
      clearAuth: () => {
        token = "";
      },
      query: async (ref: any, args: any) => {
        if (!["alice", "bob"].includes(token)) throw Error("mock JWT rejected");
        return f.t
          .withIdentity({
            issuer,
            subject: `auth0|${token}`,
            tokenIdentifier: subject(token),
          })
          .query(ref, args);
      },
      mutation: async (ref: any, args: any) => {
        if (beforeMutation) await beforeMutation();
        return f.t
          .withIdentity({
            issuer,
            subject: `auth0|${token}`,
            tokenIdentifier: subject(token),
          })
          .mutation(ref, args);
      },
    };
    clients.push(client);
    return client as unknown as ConvexHttpClient;
  };
  const auth = createAPExternalAuthentication({
    config,
    convexUrl: "http://127.0.0.1:0",
    clientFactory,
    authorize: async (h) => {
      await h.query(
        makeFunctionReference<"query">("apIdentity:workspaceAccess"),
        { scope: f.scope },
      );
    },
    service: (h) =>
      createAPWorkspaceService({
        agent: f.t as unknown as ConvexHttpClient,
        human: h,
        scope: f.scope,
        apCredential: { seatId: "ap_clerk", token: "token-ap_clerk" },
        paymentsCredential: { seatId: "payments", token: "token-payments" },
        parseUploads: async () => {
          throw Error("No parser in identity test");
        },
        runtime: () => ({ identityMode: "authenticated_human" }),
      }),
  });
  const server = createAPSystemServer(
    { runtime: () => ({ identityMode: "authenticated_human" }) },
    {
      port: 0,
      runId: "v4-auth-isolated",
      storageRoot: "/private/tmp",
      allowedOrigins: [origin],
      auth,
    },
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ap-system`;
  const headers = (name: string, cookie?: string) => ({
    Authorization: `Bearer ${name}`,
    ...(cookie ? { cookie } : {}),
    origin,
    "X-AP-System-Session": "1",
    "Content-Type": "application/json",
  });
  const open = async (name: string) => {
    const res = await fetch(base + "/cases", { headers: headers(name) });
    expect(res.status).toBe(200);
    return res.headers.get("set-cookie")!.split(";")[0]!;
  };
  const revoke = async (name: string) =>
    f.t.run(async (ctx) => {
      const seat = (await ctx.db.query("seats").collect()).find(
        (s) => s.seatId === "v4-" + name,
      )!;
      await ctx.db.patch(seat._id, { status: "retired" });
    });
  return {
    ...f,
    d,
    base,
    config,
    clients,
    headers,
    open,
    revoke,
    setBeforeMutation: (fn: () => Promise<void>) => {
      beforeMutation = fn;
    },
  };
}
describe("V4 independent request-bound Auth0 gateway", () => {
  it("uses distinct verified identities through actual backend reviews and rejects cross-subject cookies", async () => {
    const f = await gateway(),
      [alice, bob] = await Promise.all([f.open("alice"), f.open("bob")]);
    expect(alice).not.toBe(bob);
    const body = (name: string) =>
      JSON.stringify({
        ...f.request(f.d, "v4-review-" + name),
        actor: subject("alice"),
        subject: subject("alice"),
        seatId: "v4-alice",
      });
    expect(
      (
        await fetch(f.base + `/cases/${f.d.caseId}/review`, {
          method: "POST",
          headers: f.headers("bob", alice),
          body: body("cross"),
        })
      ).status,
    ).toBe(403);
    const responses = await Promise.all(
      ["alice", "bob"].map((name, i) =>
        fetch(f.base + `/cases/${f.d.caseId}/review`, {
          method: "POST",
          headers: f.headers(name, i ? bob : alice),
          body: body(name),
        }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const d = await f.get(f.d.caseId);
    expect(
      d.decisions
        .filter((x) => x.kind === "field_review")
        .map((x) => x.actor)
        .sort(),
    ).toEqual([subject("alice"), subject("bob")].sort());
    expect(new Set(f.clients).size).toBe(f.clients.length);
    expect(f.clients.length).toBe(5);
    expect(d.links.billId).toBeNull();
    expect(d.links.commandIds).toEqual([]);
  });
  it("rechecks private allowlist and actual active seat on every request, including source reads", async () => {
    const f = await gateway(),
      alice = await f.open("alice"),
      bob = await f.open("bob"),
      doc = f.d.sources[0]!;
    f.config.approvedSubjects.splice(
      f.config.approvedSubjects.indexOf(subject("bob")),
      1,
    );
    const source = `/sources/${doc.sourceId}/revisions/${doc.revision}?sha256=${doc.sha256}`;
    for (const route of ["/cases", `/cases/${f.d.caseId}`, source])
      expect(
        (await fetch(f.base + route, { headers: f.headers("bob", bob) }))
          .status,
      ).toBe(403);
    expect(
      await (
        await fetch(f.base + "/whoami", { headers: f.headers("bob", bob) })
      ).json(),
    ).toMatchObject({ approved: false });
    await f.revoke("alice");
    expect(
      (
        await fetch(f.base + `/cases/${f.d.caseId}/review`, {
          method: "POST",
          headers: f.headers("alice", alice),
          body: JSON.stringify(f.request(f.d, "retired-review")),
        })
      ).status,
    ).toBe(403);
    expect((await f.get(f.d.caseId)).decisions).toEqual([]);
  });
  it("does not accept an expired token plus a valid cookie and logout revokes only its subject-bound session", async () => {
    const f = await gateway(),
      alice = await f.open("alice"),
      bob = await f.open("bob");
    expect(
      (
        await fetch(f.base + `/cases/${f.d.caseId}`, {
          headers: f.headers("expired", alice),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(f.base + "/logout", {
          method: "POST",
          headers: f.headers("bob", alice),
        })
      ).status,
    ).toBe(403);
    const closed = await fetch(f.base + "/logout", {
      method: "POST",
      headers: f.headers("alice", alice),
    });
    expect(closed.status).toBe(200);
    expect(closed.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(
      (
        await fetch(f.base + `/cases/${f.d.caseId}`, {
          headers: f.headers("alice", alice),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(f.base + `/cases/${f.d.caseId}`, {
          headers: f.headers("bob", bob),
        })
      ).status,
    ).toBe(200);
  });
  it("actual mutation rejects a seat revoked after gateway authentication but before commit", async () => {
    const f = await gateway(),
      alice = await f.open("alice"),
      started = deferred<void>(),
      release = deferred<void>();
    f.setBeforeMutation(async () => {
      started.resolve();
      await release.promise;
    });
    const request = fetch(f.base + `/cases/${f.d.caseId}/review`, {
      method: "POST",
      headers: f.headers("alice", alice),
      body: JSON.stringify(f.request(f.d, "race-review")),
    });
    await started.promise;
    await f.revoke("alice");
    release.resolve();
    expect((await request).status).toBe(409);
    expect((await f.get(f.d.caseId)).decisions).toEqual([]);
  });
  it("drops a previous account response when the JSON body completes after account switch", async () => {
    const body = deferred<unknown>(),
      read = deferred<void>();
    const response = {
      ok: true,
      status: 200,
      json: () => {
        read.resolve();
        return body.promise;
      },
    } as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    configureAPSession({
      mode: "auth0",
      token: async () => "alice",
      expired: vi.fn(),
    });
    const result = apSystemApi.list();
    await read.promise;
    configureAPSession({
      mode: "auth0",
      token: async () => "bob",
      expired: vi.fn(),
    });
    body.resolve([]);
    await expect(result).rejects.toMatchObject({ code: "session_changed" });
  });
  it("failed old token acquisition cannot expire a replacement account and logout hides data before network completion", async () => {
    let reject!: (e: unknown) => void;
    const oldToken = new Promise<string>((_, r) => {
      reject = r;
    });
    const oldExpired = vi.fn(),
      newExpired = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response("[]", { headers: { "Content-Type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetcher);
    configureAPSession({
      mode: "auth0",
      token: () => oldToken,
      expired: oldExpired,
    });
    const old = apSystemApi.list();
    configureAPSession({
      mode: "auth0",
      token: async () => "bob",
      expired: newExpired,
    });
    reject(Error("expired alice"));
    await expect(old).rejects.toMatchObject({ code: "session_changed" });
    expect(oldExpired).not.toHaveBeenCalled();
    expect(newExpired).not.toHaveBeenCalled();
    expect(await apSystemApi.list()).toEqual([]);
    const closing = deferred<Response>();
    fetcher.mockReturnValueOnce(closing.promise);
    const logout = closeAPSession();
    await expect(apSystemApi.list()).rejects.toMatchObject({
      code: "authentication_required",
    });
    closing.resolve(new Response("{}"));
    await logout;
  });
});
