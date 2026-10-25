import assert from "node:assert/strict";
import { z } from "zod";
import type { APCaseDetail } from "../contracts";

/** A transport failure or an unrelated rejection is not evidence that the service controls worked. */
export function assertMissingServiceEvidence(response: { status: number; body: unknown }, after: Pick<APCaseDetail, "journals" | "links">) {
  assert.equal(response.status, 409, "Missing service evidence must return the policy rejection");
  const error = z.object({ error: z.object({ code: z.literal("business_policy_hold"), reason: z.string() }) }).parse(response.body).error;
  for (const code of ["missing_contract", "missing_receipt"])
    assert.ok(new RegExp(`(?:^|;\\s*)${code}:`).test(error.reason), `Expected ${code} policy hold`);
  assert.equal(after.journals.length, 0, "Missing evidence must not recognize a bill");
  assert.equal(after.links.billId, null, "Missing evidence must not create a bill");
}
