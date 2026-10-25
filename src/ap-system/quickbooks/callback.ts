import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { OAuth, CALLBACK } from "./oauth";
import { hash, QboError, safeError } from "./private-store";
const ORIGIN = "http://localhost:8824";
function cookie(req: IncomingMessage) {
  const values = (req.headers.cookie ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith("qbo_session="));
  const s = values.length === 1 ? values[0]!.slice(12) : "";
  return /^[a-f0-9]{64}$/.test(s) ? s : "";
}
export function callbackServer(oauth: OAuth) {
  const secret = randomBytes(32).toString("hex");
  const csrf = (session: string) => hash({ secret, session });
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (
        req.headers.host !== "localhost:8824" ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress ?? "",
        )
      )
        throw new QboError("loopback_host_required");
      const url = new URL(req.url ?? "/", ORIGIN);
      if (url.origin !== ORIGIN || (req.url?.length ?? 0) > 4096)
        throw new QboError("invalid_callback_request");
      if (req.method === "GET" && url.pathname === "/") {
        const session = cookie(req) || randomBytes(32).toString("hex");
        res.setHeader(
          "Set-Cookie",
          `qbo_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
        );
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<h1>QuickBooks US sandbox</h1><p>Authorize the configured sandbox company. Accounting scope only.</p><form method="post" action="/connect"><input type="hidden" name="csrf" value="${csrf(session)}"><button>Connect sandbox</button></form>`,
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/connect") {
        const session = cookie(req);
        if (
          !session ||
          req.headers.origin !== ORIGIN ||
          req.headers["content-type"] !== "application/x-www-form-urlencoded"
        )
          throw new QboError("oauth_browser_binding_required");
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1024) throw new QboError("oauth_request_too_large");
        }
        const params = new URLSearchParams(body);
        const token = params.get("csrf") ?? "";
        if (
          params.getAll("csrf").length !== 1 ||
          !/^[a-f0-9]{64}$/.test(token) ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(csrf(session)))
        )
          throw new QboError("oauth_csrf_rejected");
        res.writeHead(303, { Location: await oauth.begin(session) });
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === new URL(CALLBACK).pathname) {
        await oauth.complete(url, cookie(req));
        res.writeHead(303, { Location: "/connected" });
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/connected") {
        res.setHeader("Content-Type", "text/plain");
        res.end(
          "Callback returned. Run the read-only company/mapping check to verify the grant before synchronization.",
        );
        return;
      }
      res.statusCode = 404;
      res.end("Not found");
    } catch (e) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain");
      res.end(safeError(e));
    }
  });
}
