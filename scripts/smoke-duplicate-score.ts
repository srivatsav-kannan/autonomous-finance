// Run against a configured local backend: npx tsx scripts/smoke-duplicate-score.ts
import "../src/core/env";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { AdminClient, api } from "../src/core/kernel-client";
import { Team } from "../src/agents/team";
import { createScenario } from "../src/world/scenario";
import { scoreRun } from "../src/evals/score";

const admin = new AdminClient();
const runId = `duplicate-score-${Date.now()}`;
const sc = await createScenario(runId, { seed: 7, storeCount: 1, start: "2026-01-01", days: 2, plantErrors: false });
const invoice = sc.events.find((e) => e.type === "document.received" && String(e.payload.subject).startsWith("Invoice INV-"))!;
const receiving = sc.events.find((e) => e.type === "receiving.logged" && e.payload.vendor === "golden-state-produce")!;
const team = new Team(runId);
for (const event of [receiving, invoice]) {
  assert.equal((await admin.client.mutation(api.admin.ingestEvent, { secret: admin.secret, runId, ...event })).ok, true);
}
await team.runUntilIdle();
const duplicateId = `${invoice.externalId}-duplicate-delivery`;
assert.equal((await admin.client.mutation(api.admin.ingestEvent, { secret: admin.secret, runId, ...invoice, externalId: duplicateId })).ok, true);
await team.runUntilIdle();
const bills = await admin.client.query(api.ap.bills, { runId });
assert.equal(bills.filter((b) => b.status === "approved").length, 1);
assert.equal(bills.filter((b) => b.status === "rejected").length, 1);
const key = { errors: [{ id: "e-duplicate", type: "duplicate_exact", occurredOn: invoice.occurredOn,
  subject: { kind: "invoice", vendor: "golden-state-produce", ref: String(invoice.payload.subject).replace("Invoice ", ""), documentExternalId: duplicateId as string | undefined },
  amountAtRiskCents: bills[0]!.totalCents, expected: "reject", detail: "same invoice delivered again" }], decoys: [] };
for (const legacy of [false, true]) {
  if (legacy) key.errors[0]!.subject.documentExternalId = undefined;
  fs.writeFileSync(path.join(sc.dir, "answer-key.json"), JSON.stringify(key));
  const report = await scoreRun(runId);
  assert.equal(report.errors[0]?.caught, true);
  console.log(`PASS ${legacy ? "legacy" : "document-specific"} key: original approved, duplicate rejected and scored caught (${runId})`);
}
