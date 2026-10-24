import fs from "node:fs";
import path from "node:path";
import { runDir } from "./scenario";

/**
 * The outside world's answers to questions agents can ask it, e.g. "call the vendor at the
 * number on file and ask whether they sent this". The real vendor only confirms requests it sent.
 */
export function callbackVerify(runId: string, documentExternalId: string, phoneOnFile: string): { reached: boolean; confirms: boolean; transcript: string } {
  const events = JSON.parse(fs.readFileSync(path.join(runDir(runId), "world.json"), "utf8")) as { externalId: string; payload: Record<string, unknown> }[];
  const doc = events.find((e) => e.externalId === documentExternalId);
  const cb = doc?.payload.callback as { phone: string; confirms: boolean } | undefined;
  if (cb && cb.phone === phoneOnFile && cb.confirms) {
    return { reached: true, confirms: true, transcript: `Called ${phoneOnFile}. Vendor confirmed they sent the request and read back the new account ending.` };
  }
  return { reached: true, confirms: false, transcript: `Called ${phoneOnFile} (number on file). Vendor says they did not send this request and their bank details have not changed.` };
}
