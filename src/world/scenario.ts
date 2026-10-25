import fs from "node:fs";
import path from "node:path";
import { AdminClient, api, hashToken, newToken } from "../core/kernel-client";
import { INITIAL_ORG } from "../core/org";
import { MemoryStore } from "../memory/store";
import { seedFiles } from "../memory/seed";
import { isHumanSeat, readAgentTokens, writeSeatTokens } from "./seat-tokens";
import { generateWorld, type WorldEvent, type WorldOptions } from "./generate";
import { addDays } from "./rng";

export interface Scenario {
  runId: string;
  dir: string;
  memoryDir: string;
  options: WorldOptions;
  /** Agent seat tokens (seats.json). */
  tokens: Record<string, string>;
  /** Human seat tokens (human-seats.json). Only on a freshly created scenario; never loaded for agents. */
  humanTokens?: Record<string, string>;
  events: WorldEvent[];
}

export function runDir(runId: string): string {
  return path.join("var", "runs", runId);
}

export function memoryDir(runId: string): string {
  return path.join("var", "memory", `${runId}.git`);
}

/**
 * Create a scenario: generate the world, register the org's seats in the kernel,
 * seed company memory, and write the answer key where agents can't reach it.
 */
export async function createScenario(runId: string, options: WorldOptions, label = runId): Promise<Scenario> {
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const world = generateWorld(options);

  const tokens: Record<string, string> = {};
  for (const s of INITIAL_ORG) tokens[s.seatId] = newToken();

  const months = new Set<string>();
  for (let d = 0; d < options.days + 31; d++) months.add(addDays(options.start, d).slice(0, 7));

  const admin = new AdminClient();
  const res = await admin.client.mutation(api.admin.createRun, {
    secret: admin.secret,
    runId,
    label,
    company: "sweetgreen",
    simDate: options.start,
    periods: [...months],
    seats: INITIAL_ORG.map((s) => ({
      seatId: s.seatId,
      role: s.role,
      name: s.name,
      kind: s.kind,
      reportsTo: s.reportsTo,
      tokenHash: hashToken(tokens[s.seatId]!),
      effort: s.effort,
    })),
  });
  if (!res.ok) throw new Error(`createRun failed: ${res.code} ${res.error}`);

  const mem = new MemoryStore(memoryDir(runId));
  await mem.init();
  await mem.bootstrap(seedFiles(options.storeCount), { seatId: "system", name: "System" }, "Seed company memory (day zero)");

  writeSeatTokens(dir, tokens);
  fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify(world.events));
  fs.writeFileSync(path.join(dir, "answer-key.json"), JSON.stringify(world.answerKey, null, 2));
  fs.writeFileSync(path.join(dir, "truth.json"), JSON.stringify(world.truth, null, 2));
  fs.writeFileSync(path.join(dir, "options.json"), JSON.stringify(options, null, 2));
  const humanTokens = Object.fromEntries(Object.entries(tokens).filter(([id]) => isHumanSeat(id)));
  const agentTokens = Object.fromEntries(Object.entries(tokens).filter(([id]) => !isHumanSeat(id)));
  return { runId, dir, memoryDir: memoryDir(runId), options, tokens: agentTokens, humanTokens, events: world.events };
}

export function loadScenario(runId: string): Scenario {
  const dir = runDir(runId);
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  return { runId, dir, memoryDir: memoryDir(runId), options: read("options.json"), tokens: readAgentTokens(dir), events: read("world.json") };
}
