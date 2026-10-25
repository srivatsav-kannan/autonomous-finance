import { describe, expect, it } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";
import * as handlers from "../convex/invoiceCases";
import { sha256Hex } from "../convex/lib/kernel";
import { ConvexInvoiceBackend, CONVEX_WRITE_RETRY_DELAYS_MS } from "../src/invoice-mvp/backend";
import { kernelHarness } from "./helpers/kernelHarness";

const human = { runId: "throttle-test", seatId: "human", token: "synthetic-token" };
const investigator = { ...human, seatId: "investigator" };
const input = { label: "Synthetic transport test", documents: [{ externalId: "source", name: "source.txt", mimeType: "text/plain", text: "Unfamiliar synthetic invoice evidence" }], idempotencyKey: "unchanged-import-key" };
const throttled = () => new Error(JSON.stringify({ code: "TooManyWrites", message: "Too many writes per second. Your deployment is limited to 4 MiB bytes written per second." }));
const result = { ok: true, value: { batchId: "batch", caseIds: ["case"], documentIds: ["source"] } };

describe("bounded Convex write-throughput backoff", () => {
  it("retries only the same authenticated payload after structured TooManyWrites using injected waits", async () => {
    const requests: unknown[] = [], waits: number[] = [];
    const client = { mutation: async (_operation: unknown, payload: unknown) => { requests.push(payload); if (requests.length <= 2) throw throttled(); return result; } } as unknown as ConvexHttpClient;
    const backend = new ConvexInvoiceBackend(client, human, investigator, async (ms) => { waits.push(ms); });
    expect(await backend.ingestBatch(input)).toEqual(result.value);
    expect(waits).toEqual([250, 500]);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual({ ...input, ...human });
    expect(requests.every((payload) => payload === requests[0])).toBe(true);
  });

  it("exhausts after five attempts and returns an actionable 429 without unbounded retries", async () => {
    let attempts = 0; const waits: number[] = [];
    const client = { mutation: async () => { attempts++; throw throttled(); } } as unknown as ConvexHttpClient;
    const backend = new ConvexInvoiceBackend(client, human, investigator, async (ms) => { waits.push(ms); });
    await expect(backend.ingestBatch(input)).rejects.toMatchObject({ code: "backend_rate_limited", status: 429, message: expect.stringContaining("same idempotency key") });
    expect(attempts).toBe(5); expect(waits).toEqual(CONVEX_WRITE_RETRY_DELAYS_MS);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(3750);
  });

  it.each([
    new Error("TooManyWrites mentioned in an unrelated message"),
    new Error(JSON.stringify({ code: "InternalServerError", message: "TooManyWrites" })),
    new Error(JSON.stringify({ code: "TooManyReads" })),
    new Error(JSON.stringify({ code: "InvalidArgs", message: "invalid source" })),
    new Error("fetch failed"),
  ])("does not retry unrelated transport, malformed or application failures: %s", async (error) => {
    let attempts = 0; const waits: number[] = [];
    const client = { mutation: async () => { attempts++; throw error; } } as unknown as ConvexHttpClient;
    const backend = new ConvexInvoiceBackend(client, human, investigator, async (ms) => { waits.push(ms); });
    await expect(backend.ingestBatch(input)).rejects.toBe(error);
    expect(attempts).toBe(1); expect(waits).toEqual([]);
  });

  it("never retries a returned stale/conflicting backend decision", async () => {
    let attempts = 0; const waits: number[] = [];
    const client = { mutation: async () => { attempts++; return { ok: false, code: "stale_proposal", error: "Proposal changed" }; } } as unknown as ConvexHttpClient;
    const backend = new ConvexInvoiceBackend(client, human, investigator, async (ms) => { waits.push(ms); });
    await expect(backend.decide({ caseId: "case", proposalId: "old", evidenceVersion: 1, idempotencyKey: "decision", action: "accept" })).rejects.toMatchObject({ code: "stale_proposal", status: 409 });
    expect(attempts).toBe(1); expect(waits).toEqual([]);
  });

  it("preserves durable import idempotency if a retry follows a persisted attempt", async () => {
    const h = kernelHarness();
    await h.seed("runs", { runId: human.runId, label: "Transport test", company: "Synthetic", simDate: "2026-10-24", status: "active", createdAt: 0 });
    await h.seed("seats", { runId: human.runId, seatId: human.seatId, role: "human_cfo", kind: "human", name: "Synthetic operator", capabilities: {}, status: "active", tokenHash: await sha256Hex(human.token), createdAt: 0 });
    let calls = 0; const payloads: unknown[] = [], waits: number[] = [];
    const client = { mutation: async (ref: FunctionReference<"mutation">, args: Record<string, unknown>) => {
      calls++; payloads.push(args);
      const name = getFunctionName(ref).split(":")[1]!;
      const handler = (handlers as unknown as Record<string, { _handler: (ctx: unknown, args: unknown) => Promise<unknown> }>)[name]!;
      const stored = await handler._handler(h.ctx, args);
      if (calls === 1) throw throttled();
      return stored;
    } } as unknown as ConvexHttpClient;
    const backend = new ConvexInvoiceBackend(client, human, investigator, async (ms) => { waits.push(ms); });
    const response = await backend.ingestBatch(input);
    expect(response.caseIds).toHaveLength(1); expect(calls).toBe(2); expect(waits).toEqual([250]);
    expect(payloads[0]).toBe(payloads[1]);
    expect(h.all("invoiceSources")).toHaveLength(1); expect(h.all("invoiceBatches")).toHaveLength(1); expect(h.all("invoiceCaseRecords")).toHaveLength(1);
  });

  it("preserves replayed budget reservations after write backoff, never fresh model authorization", async () => {
    let attempts = 0;
    const client = { mutation: async () => { attempts++; if (attempts === 1) throw throttled(); return { ok: true, replayed: true, value: { reservationId: "existing", maxRequests: 1, maxCostMicros: 100, requestsReserved: 1, costReservedMicros: 100 } }; } } as unknown as ConvexHttpClient;
    const backend = new ConvexInvoiceBackend(client, human, investigator, async () => {});
    const reservation = await backend.reserveModelRequest({ caseId: "case", evidenceVersion: 1, idempotencyKey: "reservation", model: "no-provider-call", maxCostMicros: 100, budget: { maxRequests: 1, maxCostMicros: 100 } });
    expect(reservation.replayed).toBe(true); expect(attempts).toBe(2);
  });
});
