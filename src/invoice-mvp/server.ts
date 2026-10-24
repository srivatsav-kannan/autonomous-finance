import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { InvoiceError } from "./backend";
import { demoBatch } from "./demo";
import { INVESTIGATOR_POLICY, TOOL_SCHEMAS } from "./model";
import { MAX_BATCH_BYTES, MAX_SOURCE_BYTES, MAX_TEXT_BYTES, type InvoiceService } from "./service";

const PREFIX = "/api/invoice-mvp";
export interface ServerOptions { port?: number; allowedOrigins?: string[]; autoProcess?: boolean }
const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function localAddress(address: string | undefined) { return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"; }
async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) throw new InvoiceError("json_required", "Use Content-Type: application/json.", 400);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_BATCH_BYTES + 4096) throw new InvoiceError("body_too_large", "Request exceeds the encoded batch limit.", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new InvoiceError("invalid_json", "Request body is not valid JSON."); }
}
function send(res: ServerResponse, value: unknown, status = 200) { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(value)); }

export function runtimeAttestation(service: InvoiceService) {
  let sourceCommit: string | null = null, dirty: boolean | null = null;
  try {
    sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { /* The attestation says unavailable; never invent a commit. */ }
  const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
  return {
    sourceCommit, dirty, mode: service.mode, model: service.model?.model ?? null, effort: "provider_default", fallbacks: false, retries: 0, maxTurns: 10,
    budget: service.model?.budget ?? null, budgetScope: { maxCalls: "persistent_run", maxCostMicros: "persistent_run", maxInputTokens: "per_request", maxOutputTokens: "per_request" }, promptVersion: "invoice-investigator-v1", promptHash: hash(INVESTIGATOR_POLICY), toolsHash: hash(TOOL_SCHEMAS),
    usage: { available: true, source: "persisted invoiceAudit toolCall", reservationTool: "model_reservation", actualUsageTool: "model_usage", cache: "disabled", costKind: "operator-priced estimate; live NOT RUN" },
    liveExecution: service.mode === "live_model" ? "requires_explicit_process_opt_in_and_atomic_reservation" : "disabled", limits: { maxBatchBytes: MAX_BATCH_BYTES, maxSourceBytes: MAX_SOURCE_BYTES, maxTextBytes: MAX_TEXT_BYTES, maxDocuments: 100 },
  };
}

export function createInvoiceServer(service: InvoiceService, options: ServerOptions = {}) {
  const port = options.port ?? 8790;
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://localhost:5173", `http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const session = randomBytes(32).toString("hex");
  const attestation = runtimeAttestation(service);
  let drain: Promise<void> | undefined, stopped = false;
  const schedule = () => {
    if (drain || stopped || service.mode === "live_model") return;
    drain = (async () => {
      // One bounded chunk per scheduling turn; subsequent chunks use durable pending state.
      const result = await service.processPending({ maxCases: 25 });
      if (result.errors.length) console.error(`Invoice processing: ${result.errors.length} case(s) need retry; details remain in application state.`);
      if (result.remaining && !result.errors.length && !stopped) setImmediate(schedule);
    })().catch(() => console.error("Invoice processing unavailable; durable pending work will be retried on the next processing request.")).finally(() => { drain = undefined; });
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (!localAddress(req.socket.remoteAddress)) throw new InvoiceError("forbidden", "Loopback access only.");
      const host = req.headers.host ?? "";
      const hostUrl = new URL(`http://${host}`);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(hostUrl.hostname) || hostUrl.username || hostUrl.password) throw new InvoiceError("host_forbidden", "An explicit loopback Host is required.");
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) throw new InvoiceError("origin_forbidden", "Origin is not allowed for this local workspace.");
      const site = req.headers["sec-fetch-site"];
      if (site === "cross-site") throw new InvoiceError("origin_forbidden", "Cross-site access is not allowed.");
      const url = new URL(req.url ?? "/", `http://${host}`);
      const pathname = url.pathname;
      if (!pathname.startsWith(`${PREFIX}/`)) throw new InvoiceError("not_found", "Unknown invoice route.");
      if (req.method !== "GET") {
        if (!origin || !allowedOrigins.has(origin)) throw new InvoiceError("origin_required", "Writes require an allowed Origin header.");
        const cookie = /(?:^|;\s*)invoice_mvp_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
        if (!cookie || !sameSecret(cookie, session) || req.headers["x-invoice-mvp-session"] !== "1") throw new InvoiceError("session_required", "Open this workspace to establish a local session before writing.");
      }
      if (req.method === "GET" && pathname === `${PREFIX}/workspace`) {
        const workspace = await service.workspace();
        res.setHeader("Set-Cookie", `invoice_mvp_session=${session}; HttpOnly; SameSite=Strict; Path=${PREFIX}; Max-Age=28800`);
        return send(res, workspace);
      }
      if (req.method === "GET" && pathname === `${PREFIX}/runtime`) return send(res, attestation);
      if (req.method === "GET" && pathname === `${PREFIX}/demo-batch`) return send(res, demoBatch(url.searchParams.get("stage") === "late" ? "late" : "initial"));
      const match = new RegExp(`^${PREFIX}/cases/([^/]+)$`).exec(pathname);
      if (req.method === "GET" && match) return send(res, await service.caseDetail(decodeURIComponent(match[1]!)));
      if (req.method === "POST" && pathname === `${PREFIX}/batches`) {
        const result = await service.ingestBatch(await body(req) as Parameters<InvoiceService["ingestBatch"]>[0]);
        send(res, { batchId: result.batchId }, 202); schedule(); return;
      }
      if (req.method === "POST" && pathname === `${PREFIX}/decisions`) { send(res, await service.decide(await body(req) as Parameters<InvoiceService["decide"]>[0])); schedule(); return; }
      if (req.method === "POST" && pathname === `${PREFIX}/process`) {
        const input = z.object({ maxCases: z.number().int().min(1).max(200).optional(), live: z.boolean().optional() }).strict().parse(await body(req));
        const result = await service.processPending({ maxCases: input.maxCases, allowLive: input.live === true });
        send(res, result); if (!result.errors.length) schedule(); return;
      }
      throw new InvoiceError("not_found", "Unknown invoice route.");
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      const code = e instanceof InvoiceError ? e.code : e instanceof z.ZodError ? "invalid_request" : "backend_unavailable";
      const message = e instanceof InvoiceError ? e.message : e instanceof z.ZodError ? "Request does not match the invoice API schema." : "Invoice backend is unavailable; verify server configuration and retry.";
      send(res, { error: { code, message } }, e instanceof InvoiceError ? e.status : e instanceof z.ZodError ? 400 : 503);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on("listening", () => { if (options.autoProcess !== false) schedule(); });
  server.on("close", () => { stopped = true; });
  return server;
}
