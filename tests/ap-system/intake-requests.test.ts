import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDurableAPIntake,
  type PreparedUploadRequest,
} from "../../src/ap-system/intake-requests";
import type {
  APCaseDetail,
  APIntake,
  SourceDocument,
} from "../../src/ap-system/contracts";
import { packet } from "./accounting-fixture";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const sha = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const sourceBinding = (s: SourceDocument) => ({
  sourceId: s.sourceId,
  revision: s.revision,
  sha256: s.sha256,
});
const uploads = (input = packet()) =>
  input.documents.map((d) => ({
    bytes: Buffer.from(d.originalBase64!, "base64"),
    name: d.name,
    mimeType: d.mimeType,
    kind: d.kind,
  }));
function detail(input = packet(), revision = 1): APCaseDetail {
  return {
    caseId: "case-1",
    revision,
    sources: structuredClone(input.documents),
    currentSourceBindings: input.documents.map(sourceBinding),
  } as APCaseDetail;
}
/** Parsing stand-in preserves originals and deliberately returns a nullable failed candidate.
 * This test exercises durable preparation, not provider extraction or accounting approval. */
async function parse(input: PreparedUploadRequest): Promise<APIntake> {
  const template = packet().documents[0]!;
  return {
    contractVersion: "ap-evidence-v1",
    idempotencyKey: input.idempotencyKey,
    explicitRevisionOf: input.explicitRevisionOf,
    candidate: null,
    extraction: {
      status: "failed",
      evidence: [],
      reasons: ["test_parser_no_candidate"],
    },
    purchasingEvidence: [],
    documents: input.uploads.map((upload) => ({
      ...template,
      sourceId: upload.sourceId ?? `new-${sha(upload.bytes)}`,
      revision: upload.revision ?? 1,
      replaces: upload.replaces ?? null,
      deliveryId: upload.deliveryId!,
      name: upload.name,
      mimeType: upload.mimeType,
      kind: upload.kind,
      byteLength: upload.bytes.byteLength,
      sha256: sha(upload.bytes),
      originalBase64: Buffer.from(upload.bytes).toString("base64"),
      extractedText: Buffer.from(upload.bytes).toString("utf8"),
      provenance: upload.provenance!,
      pageStatus: [{ page: 1, status: "failed", reason: "test parser" }],
    })),
  };
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ap-intake-retries-"));
  directories.push(directory);
  const loadCase = vi.fn(async () => detail());
  const parser = vi.fn(parse);
  const make = () =>
    createDurableAPIntake({ directory, loadCase, parse: parser });
  const request = {
    uploads: uploads(),
    idempotencyKey: "request/private-key",
    explicitRevisionOf: null as string | null,
  };
  const receipt = path.join(
    directory,
    "intake-requests",
    `${sha(request.idempotencyKey)}.json`,
  );
  return { directory, loadCase, parser, make, request, receipt };
}
describe("durable AP intake preparation", () => {
  it("persists private exact preparation before returning and reloads across wrapper restart", async () => {
    const f = await fixture();
    const first = await f.make()(f.request);
    const files = await readdir(path.dirname(f.receipt));
    expect(files).toEqual([`${sha(f.request.idempotencyKey)}.json`]);
    expect((await stat(f.receipt)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(f.receipt))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(f.receipt, "utf8")).intake).toEqual(first);
    f.parser.mockRejectedValue(new Error("runtime is now unavailable"));
    expect(await f.make()(f.request)).toEqual(first);
    expect(f.parser).toHaveBeenCalledTimes(1);
    expect(f.loadCase).not.toHaveBeenCalled();
    first.documents[0]!.extractedText = "caller mutation";
    expect((await f.make()(f.request)).documents[0]!.extractedText).not.toBe(
      "caller mutation",
    );
  });
  it("does not reload advanced case after a lost response to an applied revision", async () => {
    const f = await fixture();
    f.request.explicitRevisionOf = "case-1";
    const before = detail();
    f.loadCase.mockResolvedValue(before);
    const prepared = await f.make()(f.request);
    expect(prepared.documents[0]).toMatchObject({
      sourceId: before.sources[0]!.sourceId,
      revision: 2,
      replaces: sourceBinding(before.sources[0]!),
    });
    f.loadCase.mockResolvedValue(detail(prepared, 2));
    expect(await f.make()(f.request)).toEqual(prepared);
    expect(f.loadCase).toHaveBeenCalledTimes(1);
    expect(f.parser).toHaveBeenCalledTimes(1);
  });
  it.each(["bytes", "name", "mimeType", "kind", "revision", "order"])(
    "rejects same key with changed %s",
    async (change) => {
      const f = await fixture();
      await f.make()(f.request);
      const changed = structuredClone(f.request);
      if (change === "bytes")
        changed.uploads[0]!.bytes[0] = changed.uploads[0]!.bytes[0]! ^ 1;
      if (change === "name") changed.uploads[0]!.name = "renamed.pdf";
      if (change === "mimeType") changed.uploads[0]!.mimeType = "image/png";
      if (change === "kind") changed.uploads[0]!.kind = "other";
      if (change === "revision") changed.explicitRevisionOf = "case-1";
      if (change === "order") changed.uploads.reverse();
      await expect(f.make()(changed)).rejects.toMatchObject({
        code: "intake_key_conflict",
      });
      expect(f.parser).toHaveBeenCalledTimes(1);
    },
  );
  it("coordinates concurrent same-key calls across wrapper instances with one parse", async () => {
    const f = await fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.parser.mockImplementation(async (request) => {
      await blocked;
      return parse(request);
    });
    const a = f.make()(f.request);
    const b = f.make()(f.request);
    const conflicting = { ...f.request, uploads: uploads(packet("OTHER")) };
    await expect(f.make()(conflicting)).rejects.toMatchObject({
      code: "intake_key_conflict",
    });
    release();
    const [first, second] = await Promise.all([a, b]);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(f.parser).toHaveBeenCalledTimes(1);
  });
  it("uses current bindings only, reuses unchanged support and versions unique changed support", async () => {
    const f = await fixture();
    const current = detail(packet(), 4);
    current.sources[0]!.revision = 4;
    current.sources[1]!.revision = 3;
    current.sources[1]!.replaces = {
      ...sourceBinding(current.sources[1]!),
      revision: 2,
    };
    current.currentSourceBindings = current.sources.map(sourceBinding);
    current.sources.push({
      ...current.sources[1]!,
      revision: 1,
      name: "historic-only.pdf",
    });
    f.loadCase.mockResolvedValue(current);
    f.request.explicitRevisionOf = current.caseId;
    f.request.uploads[2]!.bytes = Buffer.from(
      "changed accepted receiving original",
    );
    f.request.uploads.push({
      ...f.request.uploads[2]!,
      name: "new-support.pdf",
      bytes: Buffer.from("new contract"),
      kind: "contract",
    });
    const result = await f.make()(f.request);
    const sent = f.parser.mock.calls[0]![0];
    expect(sent.uploads[0]).toMatchObject({
      sourceId: current.sources[0]!.sourceId,
      revision: 5,
      replaces: sourceBinding(current.sources[0]!),
    });
    expect(sent.uploads[1]).toMatchObject({
      sourceId: current.sources[1]!.sourceId,
      revision: 3,
      replaces: current.sources[1]!.replaces,
      provenance: current.sources[1]!.provenance,
    });
    expect(sent.uploads[2]).toMatchObject({
      sourceId: current.sources[2]!.sourceId,
      revision: 2,
      replaces: sourceBinding(current.sources[2]!),
      provenance: { kind: "external_private" },
    });
    expect(sent.uploads[3]!.sourceId).toBeUndefined();
    expect(sent.uploads[3]!.provenance?.kind).toBe("external_private");
    expect(result.documents).toHaveLength(4);
    expect(result.documents.some((d) => d.name === "historic-only.pdf")).toBe(
      false,
    );
    expect(new Set(result.documents.map((d) => d.deliveryId)).size).toBe(4);
  });
  it("treats upload packet as full replacement without filling omitted current support", async () => {
    const f = await fixture();
    f.request.explicitRevisionOf = "case-1";
    f.request.uploads = f.request.uploads.slice(0, 1);
    const result = await f.make()(f.request);
    expect(result.documents).toHaveLength(1);
    expect(f.parser.mock.calls[0]![0].uploads).toHaveLength(1);
  });
  it("rejects ambiguous changed support and missing current binding", async () => {
    const f = await fixture();
    const current = detail();
    current.sources.push({ ...current.sources[1]!, sourceId: "another-po" });
    current.currentSourceBindings = current.sources.map(sourceBinding);
    f.loadCase.mockResolvedValue(current);
    f.request.explicitRevisionOf = "case-1";
    f.request.uploads[1]!.bytes = Buffer.from("changed");
    await expect(f.make()(f.request)).rejects.toMatchObject({
      code: "intake_ambiguous_replacement",
    });
    expect(f.parser).not.toHaveBeenCalled();
    current.currentSourceBindings[0]!.sha256 = "f".repeat(64);
    await expect(f.make()(f.request)).rejects.toMatchObject({
      code: "intake_revision_context",
    });
  });
  it("leaves no completed receipt on parser rejection and allows a fresh attempt", async () => {
    const f = await fixture();
    f.parser.mockRejectedValueOnce(new Error("parser crashed"));
    await expect(f.make()(f.request)).rejects.toThrow("parser crashed");
    expect(await readdir(path.dirname(f.receipt))).toEqual([]);
    await f.make()(f.request);
    expect(f.parser).toHaveBeenCalledTimes(2);
  });
  it.each(["json", "checksum"])(
    "fails explicitly on %s corruption without reparse",
    async (corruption) => {
      const f = await fixture();
      await f.make()(f.request);
      const receipt = JSON.parse(await readFile(f.receipt, "utf8"));
      receipt.intake.documents[0].extractedText = "tampered";
      await writeFile(
        f.receipt,
        corruption === "json" ? "{broken" : JSON.stringify(receipt),
      );
      await expect(f.make()(f.request)).rejects.toMatchObject({
        code: "intake_receipt_corrupt",
      });
      expect(f.parser).toHaveBeenCalledTimes(1);
    },
  );
  it("replays a completed receipt even if a process died before lock cleanup", async () => {
    const f = await fixture();
    const saved = await f.make()(f.request);
    await writeFile(`${f.receipt}.lock`, "orphan", { mode: 0o600 });
    expect(await f.make()(f.request)).toEqual(saved);
  });
  it("rejects parser source drift before writing a completed receipt", async () => {
    const f = await fixture();
    f.parser.mockImplementation(async (request) => {
      const result = await parse(request);
      result.documents[0]!.sha256 = "f".repeat(64);
      return result;
    });
    await expect(f.make()(f.request)).rejects.toMatchObject({
      code: "intake_parse_mismatch",
    });
    expect(await readdir(path.dirname(f.receipt))).toEqual([]);
  });
  it("waits for another process lock and consumes its completed receipt without parsing", async () => {
    const f = await fixture();
    const saved = await f.make()(f.request);
    const record = await readFile(f.receipt, "utf8");
    await rm(f.receipt);
    await writeFile(`${f.receipt}.lock`, JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });
    f.parser.mockClear();
    const waiting = f.make()(f.request);
    await delay(20);
    expect(f.parser).not.toHaveBeenCalled();
    await writeFile(f.receipt, record, { mode: 0o600 });
    expect(await waiting).toEqual(saved);
    expect(f.parser).not.toHaveBeenCalled();
  });
  it("reports a dead owner's incomplete preparation without stealing its lock", async () => {
    const f = await fixture();
    await f.make()(f.request);
    await rm(f.receipt);
    await writeFile(`${f.receipt}.lock`, JSON.stringify({ pid: 2147483647 }), {
      mode: 0o600,
    });
    f.parser.mockClear();
    await expect(f.make()(f.request)).rejects.toMatchObject({
      code: "intake_preparation_abandoned",
    });
    expect(f.parser).not.toHaveBeenCalled();
    expect(await readFile(`${f.receipt}.lock`, "utf8")).toContain("2147483647");
  });
  it("does not persist a candidate with the wrong prepared primary revision", async () => {
    const f = await fixture();
    f.parser.mockImplementation(async (request) => {
      const result = await parse(request);
      result.documents.forEach(
        (d) => (d.pageStatus = [{ page: 1, status: "complete", reason: null }]),
      );
      result.candidate = packet().candidate!;
      result.candidate.revision = 2;
      result.candidate.sources = result.documents.map(sourceBinding);
      result.candidate.evidence.forEach(
        (e) => (e.source = sourceBinding(result.documents[0]!)),
      );
      result.extraction = {
        status: "complete",
        evidence: result.candidate.evidence,
        reasons: [],
      };
      return result;
    });
    await expect(f.make()(f.request)).rejects.toMatchObject({
      code: "intake_parse_mismatch",
    });
    expect(await readdir(path.dirname(f.receipt))).toEqual([]);
  });
});
