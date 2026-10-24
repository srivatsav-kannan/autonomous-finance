// Tries to break the memory rules. Run: npx tsx scripts/smoke-memory.ts
import fs from "node:fs";
import { MemoryError, MemoryStore } from "../src/memory/store";
import { seedFiles } from "../src/memory/seed";
import { ROLE_CAPABILITIES } from "../src/core/roles";
import type { Vendor } from "../src/memory/schemas";

const dir = `var/memory/smoke-${Date.now()}.git`;
const mem = new MemoryStore(dir);
let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && detail ? `  ${String(detail)}` : ""}`);
  if (!cond) failures++;
}
async function expectError(label: string, code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(label, false, "no error thrown");
  } catch (e) {
    check(label, e instanceof MemoryError && e.code === code, e instanceof Error ? e.message : e);
  }
}

await mem.init();
const seedSha = await mem.bootstrap(seedFiles(3), { seatId: "system", name: "System" }, "Seed company memory");
check("seed commits", /^[0-9a-f]{40}$/.test(seedSha));
check("seed lists vendors", (await mem.list("vendors/")).length === 11);

const ap = { seatId: "ap-clerk-1", name: "AP Clerk 1" };
const payments = { seatId: "payments", name: "Payments Agent" };
const controller = { seatId: "controller", name: "Controller Agent" };

const vendor = (await mem.read<Vendor>("vendors/golden-state-produce.yaml"))!;
const noted: Vendor = { ...vendor, notes: [...vendor.notes, { on: "2026-01-05", by: "ap-clerk-1", text: "Short-shipped 2 cases of kale on INV 1042; credit requested." }] };
const w1 = await mem.write({ changes: [{ path: "vendors/golden-state-produce.yaml", data: noted }], author: ap, message: "Note short shipment", idempotencyKey: "note-1" });
check("uncontrolled vendor note commits to main", !w1.replayed);
const w2 = await mem.write({ changes: [{ path: "vendors/golden-state-produce.yaml", data: noted }], author: ap, message: "Note short shipment", idempotencyKey: "note-1" });
check("same idempotency key is a no-op", w2.replayed && w2.sha === w1.sha);

const hijack: Vendor = { ...noted, remitTo: { ...noted.remitTo, bank: "Quick Offshore Bank", accountLast4: "0007" } };
await expectError("direct remit-to change is refused (controlled)", "controlled", () =>
  mem.write({ changes: [{ path: "vendors/golden-state-produce.yaml", data: hijack }], author: ap, message: "update bank" }));

await expectError("schema-invalid write is refused", "schema", () =>
  mem.write({ changes: [{ path: "vendors/golden-state-produce.yaml", data: { ...noted, termsNetDays: "net 30" } }], author: ap, message: "bad" }));

await expectError("unknown kinds of files are refused", "unknown_path", () =>
  mem.write({ changes: [{ path: "scratch/notes.md", data: { text: "free text" } }], author: ap, message: "notes" }));

const decision = {
  id: "d-1", on: "2026-01-05", seat: "ap-clerk-1", kind: "bill", subject: { type: "bill", id: "INV-1042" }, outcome: "hold" as const,
  confidence: 0.92, summary: "Short shipment", facts: [{ key: "received.KALE-24", value: 4, source: { kind: "event" as const, ref: "recv-1" } }],
  rules: [{ path: "policies/materiality.yaml", key: "quantityToleranceUnits" }],
};
await mem.write({ changes: [{ path: "decisions/2026-01/d-1.yaml", data: decision }], author: ap, message: "Decision d-1" });
await expectError("decision records are immutable", "immutable", () =>
  mem.write({ changes: [{ path: "decisions/2026-01/d-1.yaml", data: { ...decision, outcome: "act" } }], author: ap, message: "rewrite" }));

const verified: Vendor = { ...noted, remitTo: { bank: "Mechanics Bank", accountLast4: "5511", verifiedOn: "2026-01-08", verifiedBy: "payments", method: "callback_known_number" } };
const prop = await mem.propose({ id: "remit-gsp-1", changes: [{ path: "vendors/golden-state-produce.yaml", data: verified }], author: payments, message: "Change remit-to after callback" });
check("controlled change opens a proposal branch", prop.branch === "proposal/remit-gsp-1");
check("proposal does not touch main", (await mem.read<Vendor>("vendors/golden-state-produce.yaml"))!.remitTo.accountLast4 === "4417");

await expectError("proposer cannot merge own proposal", "sod", () =>
  mem.merge({ id: "remit-gsp-1", approver: payments, caps: ROLE_CAPABILITIES.controller, note: "self" }));
await expectError("AP clerk lacks merge rights for vendors", "forbidden", () =>
  mem.merge({ id: "remit-gsp-1", approver: ap, caps: ROLE_CAPABILITIES.ap_clerk, note: "nope" }));
const merged = await mem.merge({ id: "remit-gsp-1", approver: controller, caps: ROLE_CAPABILITIES.controller, note: "callback verified" });
check("controller merges", /^[0-9a-f]{40}$/.test(merged.sha));
check("main now has the verified remit-to", (await mem.read<Vendor>("vendors/golden-state-produce.yaml"))!.remitTo.accountLast4 === "5511");

const log = await mem.log({ path: "vendors/golden-state-produce.yaml" });
check("log shows the merge with its approver", log.some((c) => c.trailers["Approved-By"] === "controller"), JSON.stringify(log[0]));
const blame = await mem.blame("vendors/golden-state-produce.yaml");
const line = blame.find((b) => b.text.includes("accountLast4"));
check("blame attributes the bank line to the proposer's commit", line?.author === "Payments Agent", JSON.stringify(line));

// Concurrency: 10 parallel writers to different decision files all land, none lost.
await Promise.all(Array.from({ length: 10 }, (_, i) =>
  mem.write({ changes: [{ path: `decisions/2026-01/p-${i}.yaml`, data: { ...decision, id: `p-${i}` } }], author: ap, message: `parallel ${i}` })));
check("10 concurrent writers: all commits land", (await mem.list("decisions/2026-01/")).length === 11);

console.log(failures === 0 ? `\nALL PASS (${dir})` : `\n${failures} FAILURE(S)`);
if (failures === 0) fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
