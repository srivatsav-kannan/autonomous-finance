import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  intakeSchema,
  type APCaseDetail,
  type APIntake,
  type SourceBinding,
  type SourceDocument,
} from "./contracts";
import {
  APHttpError,
  type APWorkspaceService,
  type UploadDocument,
} from "./server";

export type PreparedUpload = UploadDocument & {
  sourceId?: string;
  revision?: number;
  replaces?: SourceBinding | null;
  provenance?: SourceDocument["provenance"];
  deliveryId?: string;
};
export type PreparedUploadRequest = {
  uploads: PreparedUpload[];
  idempotencyKey: string;
  explicitRevisionOf: string | null;
};
export type DurableAPIntakeOptions = {
  /** Owned run directory. Receipts and locks live in its private intake-requests subdirectory. */
  directory: string;
  loadCase: (caseId: string) => Promise<APCaseDetail>;
  parse: (input: PreparedUploadRequest) => Promise<APIntake>;
};
const hash = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const sourceKey = (source: SourceBinding) =>
  `${source.sourceId}:${source.revision}:${source.sha256}`;
const binding = ({
  sourceId,
  revision,
  sha256,
}: SourceBinding): SourceBinding => ({ sourceId, revision, sha256 });
const receiptSchema = z.object({
  version: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  intakeHash: z.string().regex(/^[a-f0-9]{64}$/),
  intake: intakeSchema,
});
const active = new Map<
  string,
  { fingerprint: string; promise: Promise<APIntake> }
>();
function reject(code: string, reason: string): never {
  throw new APHttpError(code, 409, reason);
}
const isCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

async function readReceipt(
  file: string,
  fingerprint: string,
): Promise<APIntake | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    reject(
      "intake_receipt_unreadable",
      "Prepared intake receipt is unreadable; inspect the owned request record before retrying.",
    );
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 16 * 1024 * 1024
    )
      reject(
        "intake_receipt_corrupt",
        "Prepared intake receipt has invalid type, permissions or size.",
      );
    let receipt: z.infer<typeof receiptSchema>;
    try {
      receipt = receiptSchema.parse(JSON.parse(await handle.readFile("utf8")));
    } catch {
      reject(
        "intake_receipt_corrupt",
        "Prepared intake receipt is corrupt; it will not be silently reparsed.",
      );
    }
    if (
      hash(JSON.stringify(receipt.intake)) !== receipt.intakeHash ||
      hash(receipt.intake.idempotencyKey) !== path.basename(file, ".json")
    )
      reject(
        "intake_receipt_corrupt",
        "Prepared intake checksum failed; it will not be silently reparsed.",
      );
    if (receipt.fingerprint !== fingerprint)
      reject(
        "intake_key_conflict",
        "This intake key already belongs to different uploaded files or revision context.",
      );
    return receipt.intake;
  } finally {
    await handle.close();
  }
}
async function writeReceipt(
  file: string,
  fingerprint: string,
  intake: APIntake,
) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({
          version: 1,
          fingerprint,
          intakeHash: hash(JSON.stringify(intake)),
          intake,
        }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    const directory = await open(path.dirname(file), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (!isCode(error, "ENOENT")) throw error;
    });
  }
}

function currentDocuments(detail: APCaseDetail): SourceDocument[] {
  const current = detail.currentSourceBindings.map((b) => {
    const matches = detail.sources.filter((s) => sourceKey(s) === sourceKey(b));
    if (matches.length !== 1)
      reject(
        "intake_revision_context",
        "Current source binding is missing or ambiguous in the retained case.",
      );
    return matches[0]!;
  });
  if (new Set(current.map((s) => s.sourceId)).size !== current.length)
    reject(
      "intake_revision_context",
      "Current packet contains more than one revision of a source.",
    );
  return current;
}
function revisionUploads(
  uploads: UploadDocument[],
  keyHash: string,
  detail?: APCaseDetail,
): PreparedUpload[] {
  const current = detail ? currentDocuments(detail) : [];
  const primary = (kind: SourceDocument["kind"]) =>
    kind === "invoice" || kind === "credit_note";
  if (uploads.filter((u) => primary(u.kind)).length !== 1)
    reject(
      "intake_primary_required",
      "Supply exactly one primary invoice or credit original in the full replacement packet.",
    );
  const priorPrimary = current.filter((s) => primary(s.kind));
  if (detail && priorPrimary.length !== 1)
    reject(
      "intake_revision_context",
      "Current case has no unique primary original.",
    );
  const used = new Set<string>();
  return uploads.map((upload, index) => {
    let prior: SourceDocument | undefined;
    let unchanged = false;
    if (detail && primary(upload.kind)) {
      prior = priorPrimary[0]!;
      if (prior.kind !== upload.kind)
        reject(
          "intake_primary_kind",
          "A revision cannot change the primary invoice/credit kind.",
        );
    } else if (detail) {
      const sameKind = current.filter((s) => s.kind === upload.kind);
      const exact = sameKind.filter(
        (s) =>
          s.sha256 === hash(upload.bytes) &&
          s.byteLength === upload.bytes.byteLength,
      );
      const matches =
        exact.length > 1 ? exact.filter((s) => s.name === upload.name) : exact;
      if (exact.length && matches.length !== 1)
        reject(
          "intake_ambiguous_replacement",
          "Identical support bytes match multiple current originals; the replacement is ambiguous.",
        );
      if (matches.length) {
        prior = matches[0]!;
        unchanged = true;
      } else {
        const named = sameKind.filter((s) => s.name === upload.name);
        if (named.length > 1)
          reject(
            "intake_ambiguous_replacement",
            "Changed support matches multiple current originals by name and kind.",
          );
        prior = named[0];
      }
    }
    if (prior && used.has(prior.sourceId))
      reject(
        "intake_ambiguous_replacement",
        "The replacement packet maps multiple uploads to one retained source.",
      );
    if (prior) used.add(prior.sourceId);
    const provenance =
      prior &&
      prior.sha256 === hash(upload.bytes) &&
      prior.byteLength === upload.bytes.byteLength
        ? prior.provenance
        : {
            kind: "external_private" as const,
            description:
              "User uploaded original; this does not authenticate the supplier.",
            license:
              "Private user input; no redistribution permission inferred",
            originalFilename: upload.name,
          };
    return {
      ...upload,
      deliveryId: `intake-${keyHash}-${index}`,
      provenance,
      ...(prior
        ? {
            sourceId: prior.sourceId,
            revision: primary(upload.kind)
              ? detail!.revision + 1
              : unchanged
                ? prior.revision
                : prior.revision + 1,
            replaces: unchanged ? prior.replaces : binding(prior),
          }
        : {}),
    };
  });
}
function validatePrepared(
  value: APIntake,
  request: PreparedUploadRequest,
): APIntake {
  const parsed = intakeSchema.parse(value);
  if (
    parsed.idempotencyKey !== request.idempotencyKey ||
    parsed.explicitRevisionOf !== request.explicitRevisionOf ||
    parsed.documents.length !== request.uploads.length
  )
    reject(
      "intake_parse_mismatch",
      "Parser changed the request identity or added omitted historical documents.",
    );
  if (
    new Set(parsed.documents.map((d) => d.sourceId)).size !==
    parsed.documents.length
  )
    reject(
      "intake_parse_mismatch",
      "Parser produced duplicate source identities for the replacement packet.",
    );
  const primary = parsed.documents.find(
    (d) => d.kind === "invoice" || d.kind === "credit_note",
  )!;
  if (parsed.candidate && parsed.candidate.revision !== primary.revision)
    reject(
      "intake_parse_mismatch",
      "Candidate revision does not match the prepared primary source revision.",
    );
  request.uploads.forEach((upload, index) => {
    const source = parsed.documents[index]!;
    if (
      source.name !== upload.name ||
      source.mimeType !== upload.mimeType ||
      source.kind !== upload.kind ||
      source.sha256 !== hash(upload.bytes) ||
      source.byteLength !== upload.bytes.byteLength ||
      source.originalBase64 !== Buffer.from(upload.bytes).toString("base64") ||
      source.deliveryId !== upload.deliveryId ||
      JSON.stringify(source.provenance) !== JSON.stringify(upload.provenance) ||
      (upload.sourceId !== undefined && source.sourceId !== upload.sourceId) ||
      (upload.revision !== undefined && source.revision !== upload.revision) ||
      (upload.replaces !== undefined &&
        JSON.stringify(source.replaces) !== JSON.stringify(upload.replaces))
    )
      reject(
        "intake_parse_mismatch",
        "Parser did not preserve the exact uploaded original or prepared source revision.",
      );
  });
  return parsed;
}

/** Prepare once before ingest; a backend response loss cannot reload a newer revision on retry. */
export function createDurableAPIntake(
  options: DurableAPIntakeOptions,
): APWorkspaceService["parseUploads"] {
  const directory = path.resolve(options.directory, "intake-requests");
  return async (input) => {
    const idempotencyKey = z
      .string()
      .min(1)
      .max(200)
      .parse(input.idempotencyKey);
    const explicitRevisionOf = input.explicitRevisionOf ?? null;
    const uploads = input.uploads.map((u) => ({
      ...u,
      bytes: new Uint8Array(u.bytes),
    }));
    const fingerprint = hash(
      JSON.stringify({
        explicitRevisionOf,
        uploads: uploads.map((u) => ({
          name: u.name,
          mimeType: u.mimeType,
          kind: u.kind,
          byteLength: u.bytes.byteLength,
          sha256: hash(u.bytes),
        })),
      }),
    );
    const keyHash = hash(idempotencyKey);
    const file = path.join(directory, `${keyHash}.json`);
    const existing = active.get(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        reject(
          "intake_key_conflict",
          "This in-progress intake key belongs to different files or revision context.",
        );
      return structuredClone(await existing.promise);
    }
    const prepare = async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const lock = `${file}.lock`;
      let lockHandle;
      const started = Date.now();
      while (!lockHandle) {
        const cached = await readReceipt(file, fingerprint);
        if (cached) return cached;
        try {
          lockHandle = await open(lock, "wx", 0o600);
        } catch (error) {
          if (!isCode(error, "EEXIST")) throw error;
          // Never steal a lock based on age: the original parser could still finish.
          // A completed receipt is checked first, including after a process restart.
          let owner: { pid: number; fingerprint?: string } | null = null;
          try {
            owner = JSON.parse(await readFile(lock, "utf8")) as { pid: number };
          } catch {
            /* owner write may still be in progress */
          }
          if (owner?.fingerprint && owner.fingerprint !== fingerprint)
            reject(
              "intake_key_conflict",
              "This in-progress intake key belongs to different files or revision context.",
            );
          if (owner && Number.isSafeInteger(owner.pid)) {
            try {
              process.kill(owner.pid, 0);
            } catch (failure) {
              if (isCode(failure, "ESRCH"))
                reject(
                  "intake_preparation_abandoned",
                  "Previous preparation stopped before a durable receipt. Inspect and remove its abandoned lock before retrying.",
                );
            }
          }
          if (Date.now() - started > 180_000)
            reject(
              "intake_preparation_busy",
              "This intake key is still being prepared. Retry the same request after preparation completes.",
            );
          await delay(100);
        }
      }
      try {
        await lockHandle.writeFile(
          JSON.stringify({ pid: process.pid, fingerprint }),
        );
        await lockHandle.sync();
        const cached = await readReceipt(file, fingerprint);
        if (cached) return cached;
        const detail = explicitRevisionOf
          ? await options.loadCase(explicitRevisionOf)
          : undefined;
        if (detail && detail.caseId !== explicitRevisionOf)
          reject(
            "intake_revision_context",
            "Loaded case differs from the requested revision target.",
          );
        const request = {
          uploads: revisionUploads(uploads, keyHash, detail),
          idempotencyKey,
          explicitRevisionOf,
        };
        const intake = validatePrepared(await options.parse(request), request);
        await writeReceipt(file, fingerprint, intake);
        return intake;
      } finally {
        await lockHandle.close();
        await unlink(lock);
      }
    };
    const promise = prepare();
    active.set(file, { fingerprint, promise });
    try {
      return structuredClone(await promise);
    } finally {
      if (active.get(file)?.promise === promise) active.delete(file);
    }
  };
}
