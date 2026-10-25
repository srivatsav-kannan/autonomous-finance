import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWithLlama } from "./provider";
const bytes = new TextEncoder().encode("%PDF-test");
async function temp(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ap-provider-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it("resumes a known provider job after timeout and reuses immutable completed artifacts", async () =>
  temp(async (root) => {
    let posts = 0,
      complete = false;
    const fetcher = async (url: any, init: any) => {
      if (init.method === "POST") {
        posts++;
        return Response.json({ id: "job-1", status: "PENDING" });
      }
      return Response.json({
        job: { status: complete ? "COMPLETED" : "PENDING" },
        items: { pages: [] },
        result_content_metadata: {},
      });
    };
    await expect(
      parseWithLlama(bytes, "a.pdf", "application/pdf", root, {
        fetcher: fetcher as typeof fetch,
        apiKey: "test",
        maxPollMs: 0,
      }),
    ).rejects.toThrow("parse_poll_timeout");
    complete = true;
    const first = await parseWithLlama(
      bytes,
      "renamed.pdf",
      "application/pdf",
      root,
      { fetcher: fetcher as typeof fetch, apiKey: "test" },
    );
    expect(first.reused).toBe(false);
    expect(posts).toBe(1);
    const replay = await parseWithLlama(
      bytes,
      "renamed.pdf",
      "application/pdf",
      root,
      {
        fetcher: async () => {
          throw Error("network_not_expected");
        },
      },
    );
    expect(replay.reused).toBe(true);
    expect(posts).toBe(1);
  }));
it("never resubmits an ambiguous upload and does not expose provider text", async () =>
  temp(async (root) => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      throw Error("secret_provider_body");
    };
    await expect(
      parseWithLlama(bytes, "a.pdf", "application/pdf", root, {
        fetcher: fetcher as typeof fetch,
        apiKey: "test",
      }),
    ).rejects.toThrow("provider_transport_unknown");
    await expect(
      parseWithLlama(bytes, "a.pdf", "application/pdf", root, {
        fetcher: fetcher as typeof fetch,
        apiKey: "test",
      }),
    ).rejects.toThrow("submission_outcome_unknown");
    expect(calls).toBe(1);
  }));
it("rejects mutable latest parser version", async () =>
  temp(async (root) => {
    await expect(
      parseWithLlama(bytes, "a.pdf", "application/pdf", root, {
        parserVersion: "latest",
      }),
    ).rejects.toThrow("concrete_parser_version_required");
  }));
