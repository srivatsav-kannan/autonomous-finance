// Who may use the human gateway. Holding its URL is not human authority: every request must carry
// the local console token, and browsers are accepted only from the console's own origin.
import { createHash, timingSafeEqual } from "node:crypto";
import type http from "node:http";

export const GATEWAY_TOKEN_HEADER = "x-gateway-token";
export const DEFAULT_GATEWAY_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];
const MIN_TOKEN_LENGTH = 32;

export interface GatewayAuth {
  token: string;
  origins: string[];
}

/** Reads VITE_GATEWAY_TOKEN (shared with the console through .env.local) and the allowed origins. */
export function loadGatewayAuth(env: Record<string, string | undefined> = process.env): GatewayAuth {
  const token = env.VITE_GATEWAY_TOKEN?.trim() ?? "";
  if (!token) throw new Error("VITE_GATEWAY_TOKEN is not set; run `npm run gateway:token` to write one to .env.local");
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`VITE_GATEWAY_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters; run \`npm run gateway:token\``);
  const origins = (env.GATEWAY_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  return { token, origins: origins.length ? origins : DEFAULT_GATEWAY_ORIGINS };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Check one request and set CORS headers for an allowed origin. Returns the refusal, or null.
 * Preflights carry no token, so they pass on origin alone; the request that follows does not.
 * Requiring a custom header and a JSON body also means no page can send a simple (CSRF) request.
 */
export function guardRequest(req: http.IncomingMessage, res: http.ServerResponse, auth: GatewayAuth): { status: number; error: string } | null {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!auth.origins.includes(origin)) return { status: 403, error: `origin ${origin} is not allowed` };
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return null;
  const given = req.headers[GATEWAY_TOKEN_HEADER];
  if (typeof given !== "string" || !timingSafeEqual(digest(given), digest(auth.token))) {
    return { status: 401, error: "gateway token required" };
  }
  if (req.method === "POST" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    return { status: 415, error: "POST requires content-type application/json" };
  }
  return null;
}
