import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGatewayServer } from "../src/human/gateway";
import { GATEWAY_TOKEN_HEADER, loadGatewayAuth } from "../src/human/gateway-auth";

const token = "a".repeat(64);
const consoleOrigin = "http://127.0.0.1:5173";
let server: http.Server;
let base: string;

beforeEach(async () => {
  server = createGatewayServer(loadGatewayAuth({ VITE_GATEWAY_TOKEN: token }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const answer = (headers: Record<string, string>) =>
  fetch(`${base}/runs/run-1/asks/ask-1/answer`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ optionId: "approve" }) });

describe("human gateway authentication", () => {
  it("rejects an answer with no gateway token", async () => {
    const res = await answer({ origin: consoleOrigin });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(consoleOrigin);
  });

  it("rejects an untrusted origin even with the token, and never echoes a wildcard", async () => {
    const res = await answer({ origin: "https://untrusted.example", [GATEWAY_TOKEN_HEADER]: token });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects a wrong token", async () => {
    expect((await answer({ [GATEWAY_TOKEN_HEADER]: "b".repeat(64) })).status).toBe(401);
  });

  it("rejects a form-encoded POST that a page could send without a preflight", async () => {
    const res = await fetch(`${base}/runs/run-1/chaos`, { method: "POST", headers: { "content-type": "text/plain", [GATEWAY_TOKEN_HEADER]: token }, body: "{}" });
    expect(res.status).toBe(415);
  });

  it("answers preflights only for the console origin", async () => {
    const ok = await fetch(`${base}/runs/run-1/eval`, { method: "OPTIONS", headers: { origin: consoleOrigin, "access-control-request-method": "POST" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(consoleOrigin);
    expect(ok.headers.get("access-control-allow-headers")).toContain(GATEWAY_TOKEN_HEADER);
    const bad = await fetch(`${base}/runs/run-1/eval`, { method: "OPTIONS", headers: { origin: "https://untrusted.example" } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("lets the console through with the token", async () => {
    const res = await fetch(`${base}/runs/run-1/nowhere`, { headers: { origin: consoleOrigin, [GATEWAY_TOKEN_HEADER]: token } });
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe(consoleOrigin);
  });

  it("refuses to start without a strong token", () => {
    expect(() => loadGatewayAuth({})).toThrow(/gateway:token/);
    expect(() => loadGatewayAuth({ VITE_GATEWAY_TOKEN: "short" })).toThrow(/at least/);
    expect(loadGatewayAuth({ VITE_GATEWAY_TOKEN: token, GATEWAY_ALLOWED_ORIGINS: "http://localhost:4000" }).origins).toEqual(["http://localhost:4000"]);
  });
});
