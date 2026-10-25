import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Processor } from "../contracts";
import {
  canonical,
  sha256,
  saveArtifact,
  atomicJson,
  readArtifact,
} from "./storage";
export const PARSER_VERSION = "2026-09-28";
export const INGESTION_VERSION = "ap-ingestion-v1";
export type Json = Record<string, any>;
export type ProviderOutput = {
  result: Json;
  grounded: Json[];
  rawWords: Json[];
  processor: Processor;
  reused: boolean;
};
export type ParseOptions = {
  parserVersion?: string;
  maxPollMs?: number;
  pollMs?: number;
  fetcher?: typeof fetch;
  apiKey?: string;
};
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function lines(bytes: Uint8Array) {
  return Buffer.from(bytes)
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((s) => JSON.parse(s) as Json);
}
async function request(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  readOnly: boolean,
) {
  for (let i = 0; i < (readOnly ? 3 : 1); i++) {
    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      if (readOnly && i < 2) {
        await pause(250 * 2 ** i);
        continue;
      }
      throw new Error("provider_transport_unknown");
    }
    if (response.ok) {
      const reader = response.body?.getReader();
      if (!reader) return new Uint8Array();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 40 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("provider_result_too_large");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }
    if (
      readOnly &&
      (response.status === 429 || response.status >= 500) &&
      i < 2
    ) {
      await pause(250 * 2 ** i);
      continue;
    }
    throw new Error(`provider_http_${response.status}`);
  }
  throw new Error("provider_retry_exhausted");
}
export async function parseWithLlama(
  bytes: Uint8Array,
  name: string,
  mimeType: string,
  storageRoot: string,
  options: ParseOptions = {},
): Promise<ProviderOutput> {
  const parserVersion = options.parserVersion ?? PARSER_VERSION;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parserVersion))
    throw new Error("concrete_parser_version_required");
  const config = {
    tier: "agentic_plus",
    version: parserVersion,
    output_options: {
      granular_bboxes: ["word", "line", "cell"],
      additional_outputs: ["word_bbox"],
      images_to_save: ["screenshot"],
      extract_printed_page_number: true,
    },
  };
  const configArtifact = await saveArtifact(storageRoot, canonical(config)),
    configHash = configArtifact.sha256;
  const key = sha256(bytes) + "-" + configHash;
  const dir = join(storageRoot, "jobs", key);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error("parse_in_progress_or_interrupted_lock_requires_review");
  }
  const fetcher = options.fetcher ?? fetch;
  let state: Json = {};
  try {
    try {
      state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (state.status === "complete")
      return {
        result: JSON.parse(
          (await readArtifact(storageRoot, state.resultArtifact)).toString(),
        ),
        grounded: lines(
          await readArtifact(storageRoot, state.groundedArtifact),
        ),
        rawWords: lines(await readArtifact(storageRoot, state.wordsArtifact)),
        processor: state.processor,
        reused: true,
      };
    const apiKey = options.apiKey ?? process.env.LLAMA_CLOUD_API_KEY;
    if (!apiKey) throw new Error("llamaparse_not_configured");
    const headers = { Authorization: `Bearer ${apiKey}` };
    const api = "https://api.cloud.llamaindex.ai/api/v2/parse";
    if (!state.jobId) {
      if (state.status)
        throw new Error("submission_outcome_unknown_do_not_resubmit");
      state = {
        sourceSha256: sha256(bytes),
        configHash,
        status: "submitting",
        startedAt: new Date().toISOString(),
      };
      await atomicJson(join(dir, "state.json"), state);
      const form = new FormData();
      form.set(
        "file",
        new Blob([Buffer.from(bytes)], { type: mimeType }),
        name,
      );
      form.set("configuration", JSON.stringify(config));
      const submitted = JSON.parse(
        Buffer.from(
          await request(
            fetcher,
            api + "/upload",
            { method: "POST", headers, body: form },
            false,
          ),
        ).toString(),
      );
      await saveArtifact(storageRoot, canonical(submitted));
      if (typeof submitted.id !== "string" || !submitted.id)
        throw new Error("submission_missing_job_id");
      state = { ...state, jobId: submitted.id, status: "pending" };
      await atomicJson(join(dir, "state.json"), state);
    }
    const deadline = Date.now() + (options.maxPollMs ?? 180000);
    let result: Json | undefined;
    do {
      result = JSON.parse(
        Buffer.from(
          await request(
            fetcher,
            api +
              "/" +
              encodeURIComponent(state.jobId) +
              "?expand=markdown,items,metadata,job_metadata,text_full,markdown_full,raw_words_content_metadata",
            { headers },
            true,
          ),
        ).toString(),
      );
      state.status = result!.job?.status ?? "unknown";
      await atomicJson(join(dir, "state.json"), state);
      if (["FAILED", "CANCELLED"].includes(state.status))
        throw new Error(`parse_${String(state.status).toLowerCase()}`);
      if (state.status === "COMPLETED") break;
      if (Date.now() >= deadline)
        throw new Error("parse_poll_timeout_resume_same_job");
      await pause(
        Math.min(options.pollMs ?? 1500, Math.max(0, deadline - Date.now())),
      );
    } while (true);
    const download = async (kind: string) => {
      const meta = result!.result_content_metadata?.[kind];
      if (!meta?.presigned_url) return new Uint8Array();
      if (meta.size_bytes > 40 * 1024 * 1024)
        throw new Error("provider_artifact_too_large");
      const u = new URL(meta.presigned_url);
      if (
        u.protocol !== "https:" ||
        !/(^|\.)(amazonaws\.com|llamaindex\.ai|blob\.core\.windows\.net|googleapis\.com)$/.test(
          u.hostname,
        )
      )
        throw new Error("unexpected_provider_artifact_host");
      return request(fetcher, u.href, {}, true);
    };
    const [groundedBytes, wordsBytes] = await Promise.all([
      download("grounded_items"),
      download("raw_words"),
    ]);
    const resultArtifact = await saveArtifact(storageRoot, canonical(result));
    const groundedArtifact = await saveArtifact(
        storageRoot,
        groundedBytes,
        "jsonl",
      ),
      wordsArtifact = await saveArtifact(storageRoot, wordsBytes, "jsonl");
    const processor: Processor = {
      provider: "llamaparse",
      model: "agentic_plus",
      version: parserVersion,
      configHash,
      jobId: state.jobId,
      resolvedVersion: null,
      implementationVersion: INGESTION_VERSION,
      configArtifact,
      rawArtifact: groundedArtifact,
      tokenArtifact: wordsArtifact,
      rasterArtifact: null,
      traineddata: null,
    };
    state = {
      ...state,
      status: "complete",
      resultArtifact,
      groundedArtifact,
      wordsArtifact,
      processor,
      completedAt: new Date().toISOString(),
    };
    await atomicJson(join(dir, "state.json"), state);
    return {
      result: result!,
      grounded: lines(groundedBytes),
      rawWords: lines(wordsBytes),
      processor,
      reused: false,
    };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
