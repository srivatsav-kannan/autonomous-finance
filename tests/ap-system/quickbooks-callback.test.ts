import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vitest";
import { callbackServer } from "../../src/ap-system/quickbooks/callback";
import { OAuth, CALLBACK } from "../../src/ap-system/quickbooks/oauth";
import { PrivateStore } from "../../src/ap-system/quickbooks/private-store";
it("loopback callback binds browser session and CSRF, consumes grant once and redirects away from the code", async () => {
  const root = await mkdtemp(join(tmpdir(), "qbo-http-test-"));
  let calls = 0;
  const oauth = new OAuth(
    {
      clientId: "mock-client",
      clientSecret: "secret",
      realmId: "123",
      redirectUri: CALLBACK,
      environment: "sandbox",
    },
    new PrivateStore(root),
    async () => {
      calls++;
      return new Response(
        JSON.stringify({
          access_token: "private-access",
          refresh_token: "private-refresh",
          token_type: "bearer",
          expires_in: 3600,
          x_refresh_token_expires_in: 864000,
        }),
      );
    },
  );
  const server = callbackServer(oauth);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const send = (
    path: string,
    method = "GET",
    headers: Record<string, string> = {},
    body = "",
  ) =>
    new Promise<{ status: number; headers: Record<string, any>; body: string }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path,
            method,
            headers: { Host: "localhost:8824", ...headers },
          },
          (res) => {
            let data = "";
            res.on("data", (d) => (data += d));
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                headers: res.headers,
                body: data,
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      },
    );
  try {
    expect((await send("/", "GET", { Host: "evil.invalid" })).status).toBe(400);
    const page = await send("/");
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.headers["content-security-policy"]).toBe("default-src 'none'; form-action 'self'; frame-ancestors 'none'");
    const cookie = page.headers["set-cookie"][0].split(";")[0];
    expect(page.headers["set-cookie"][0]).toContain("HttpOnly; SameSite=Lax");
    const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(page.body)![1];
    expect(
      (
        await send(
          "/connect",
          "POST",
          {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: cookie,
            Origin: "https://evil.invalid",
          },
          `csrf=${csrf}`,
        )
      ).status,
    ).toBe(400);
    for (const origin of ["null", ""]) {
      expect((await send("/connect", "POST", {"Content-Type":"application/x-www-form-urlencoded", Cookie:cookie, ...(origin ? {Origin:origin} : {})}, `csrf=${csrf}`)).status).toBe(400);
    }
    expect((await send("/connect", "POST", {"Content-Type":"application/x-www-form-urlencoded",Cookie:cookie,Origin:"http://localhost:8824"}, `csrf=${"0".repeat(64)}`)).status).toBe(400);
    const connected = await send(
      "/connect",
      "POST",
      {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
        Origin: "http://localhost:8824",
      },
      `csrf=${csrf}`,
    );
    expect(connected.status).toBe(200);
    expect(connected.headers.location).toBeUndefined();
    expect(connected.headers["referrer-policy"]).toBe("no-referrer");
    expect(connected.headers["content-security-policy"]).toBe(page.headers["content-security-policy"]);
    const authorization = new URL(/href="([^"]+)"/.exec(connected.body)![1]!.replaceAll("&amp;","&"));
    expect(authorization.origin+authorization.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(authorization.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(authorization.searchParams.get("redirect_uri")).toBe(CALLBACK);
    const state = authorization.searchParams.get("state");
    const path = `/api/quickbooks/callback?state=${state}&code=private-code&realmId=123`;
    expect((await send(path)).status).toBe(400);
    expect(calls).toBe(0);
    const result = await send(path, "GET", { Cookie: cookie });
    expect(result.status).toBe(303);
    expect(result.headers.location).toBe("/connected");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    expect(result.body).not.toContain("private-");
    expect((await send(path, "GET", { Cookie: cookie })).status).toBe(400);
    expect(calls).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
