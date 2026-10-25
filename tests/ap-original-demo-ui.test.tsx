import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { configureAPSession } from "../console/src/apAuthSession";
import { loadOriginal } from "../console/src/apSystemApi";
import { APDemoTasks, apexTaskFor, apexTasks } from "../console/src/APDemoTasks";
import { apUIFixture, uiSourceText } from "./ap-system-ui.fixture";
afterEach(() => { configureAPSession(null); vi.unstubAllGlobals(); });
it("loads exact original bytes with their MIME type through the authenticated endpoint", async () => {
  configureAPSession({ mode: "local_simulation", actorId: "reviewer", expired: () => {} });
  const fetcher = vi.fn().mockResolvedValue(new Response(uiSourceText)); vi.stubGlobal("fetch", fetcher);
  const source = apUIFixture().sources[0]!;
  const blob = await loadOriginal(source, new AbortController().signal);
  expect(await blob.text()).toBe(uiSourceText); expect(blob.type).toBe(source.mimeType);
  expect(fetcher.mock.calls[0]![0]).toContain(`sha256=${source.sha256}`);
  expect(new Headers(fetcher.mock.calls[0]![1].headers).get("Authorization")).toBe("Bearer local:reviewer");
});
it("never previews an original with a different content hash", async () => {
  configureAPSession({ mode: "local" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("another invoice")));
  await expect(loadOriginal(apUIFixture().sources[0]!, new AbortController().signal)).rejects.toThrow(/do not match/);
});
it("discards original bytes if the actor changes while the body loads", async () => {
  configureAPSession({ mode: "local" });
  const response = new Response(uiSourceText);
  response.blob = async () => { configureAPSession({ mode: "local" }); return new Blob([uiSourceText]); };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(loadOriginal(apUIFixture().sources[0]!, new AbortController().signal)).rejects.toThrow(/sign-in changed/);
});
it("only identifies APEX tasks in the isolated run with the exact current invoice source", () => {
  const detail = apUIFixture(); const task = apexTasks[1];
  detail.runId = "apex107-replay-20261025"; detail.organizationId = "apex107-synthetic-sterling-marsh";
  detail.scope = { ...detail.scope, runId: detail.runId, organizationId: detail.organizationId, accountId: "apex107-usd-operating" };
  detail.currentSourceBindings = detail.currentSourceBindings.map(b => ({ ...b }));
  detail.candidate!.invoiceNumber = task.invoice;
  detail.sources[0]!.sha256 = task.sha256; detail.currentSourceBindings[0]!.sha256 = task.sha256;
  expect(apexTaskFor(detail)).toBe(task);
  const html = renderToStaticMarkup(<APDemoTasks cases={[detail]} selectedId={detail.caseId} busy={false} onSelect={() => {}}/>);
  expect(html).toContain("Historical source review"); expect(html).toContain("Awaiting import");
  detail.currentSourceBindings[0]!.revision = 2; expect(apexTaskFor(detail)).toBeUndefined();
  detail.currentSourceBindings[0]!.revision = 1; detail.runId = "other-run"; expect(apexTaskFor(detail)).toBeUndefined();
});
