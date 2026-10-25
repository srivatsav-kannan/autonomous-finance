// Loads ANTHROPIC_API_KEY from the repo's .env.local without printing or copying it.
import fs from "node:fs";
import https from "node:https";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import Anthropic from "@anthropic-ai/sdk";
import { ENV_FILE } from "./config";

function readKeyFromEnvFile(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[1] ?? "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

let cached: Anthropic | undefined;

/**
 * HTTP/1.1 fetch over node:https with one socket per in-flight request.
 * Node 26's built-in fetch (undici 8) multiplexes every request to the API over a
 * single HTTP/2 connection; with 8 long-lived streaming agent turns that made new
 * requests wait minutes before their first byte (observed in the first full pass).
 * Separate sockets avoid that queueing. Only used for the Anthropic client.
 */
const h1Agent = new https.Agent({ keepAlive: true, maxSockets: 64 });

export const h1fetch: typeof fetch = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => {
      headers[k] = v;
    });
    headers["accept-encoding"] = "identity";
    const req = https.request(url, { method: init?.method ?? "GET", headers, agent: h1Agent }, (res) => {
      const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
      let stream: Readable = res;
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined || k === "content-encoding" || k === "content-length") continue;
        h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      }
      const status = res.statusCode ?? 500;
      const body = status === 204 || status === 304 ? null : (Readable.toWeb(stream) as ReadableStream<Uint8Array>);
      resolve(new Response(body, { status, statusText: res.statusMessage, headers: h }));
    });
    req.on("error", reject);
    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => req.destroy(signal.reason instanceof Error ? signal.reason : new Error("aborted")), { once: true });
    }
    const body = init?.body;
    if (body == null) req.end();
    else if (typeof body === "string" || body instanceof Uint8Array) req.end(body);
    else if (body instanceof ArrayBuffer) req.end(Buffer.from(body));
    else {
      req.destroy();
      reject(new Error("h1fetch: unsupported request body type"));
    }
  });

/** HTTP status counts of every API response, including the SDK's silent retries. */
export const httpStats: { responses: number; byStatus: Record<string, number> } = { responses: 0, byStatus: {} };

const countingFetch: typeof fetch = async (input, init) => {
  const res = await (process.env.API_FETCH === "undici" ? fetch(input, init) : h1fetch(input, init));
  httpStats.responses++;
  httpStats.byStatus[res.status] = (httpStats.byStatus[res.status] ?? 0) + 1;
  if (res.status === 429 || res.status >= 500) {
    console.error(`  [api http ${res.status}] retry-after=${res.headers.get("retry-after") ?? "-"} (SDK retries automatically)`);
  }
  return res;
};

/** One shared client. Long streaming turns with server tools can run for minutes. */
export function getClient(): Anthropic {
  if (cached) return cached;
  const apiKey = readKeyFromEnvFile(ENV_FILE) ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(`ANTHROPIC_API_KEY not found in ${ENV_FILE} or the environment`);
  }
  cached = new Anthropic({ apiKey, timeout: 30 * 60 * 1000, maxRetries: 4, fetch: countingFetch });
  return cached;
}
