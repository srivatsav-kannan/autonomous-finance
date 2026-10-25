import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Team } from "../src/agents/team";
import { humanClient } from "../src/human/gateway";
import { INITIAL_ORG } from "../src/core/org";
import { runDir } from "../src/world/scenario";
import { AGENT_TOKENS_FILE, HUMAN_TOKENS_FILE, readAgentTokens, readHumanToken, writeSeatTokens } from "../src/world/seat-tokens";

const allTokens = () => Object.fromEntries(INITIAL_ORG.map((s) => [s.seatId, `${s.seatId}-token`]));
const json = (dir: string, file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, string>;
const mode = (dir: string, file: string) => fs.statSync(path.join(dir, file)).mode & 0o777;

const dirs: string[] = [];
beforeEach(() => vi.stubEnv("CONVEX_URL", "http://127.0.0.1:3210"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "seat-tokens-"));
  dirs.push(d);
  return d;
}
/** Team and the gateway resolve runs under var/runs relative to the working directory. */
function runFixture(legacy: boolean) {
  const runId = `seat-split-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  if (legacy) fs.writeFileSync(path.join(dir, AGENT_TOKENS_FILE), JSON.stringify(allTokens()), { mode: 0o600 });
  else writeSeatTokens(dir, allTokens());
  return { runId, dir };
}

describe("seat token files", () => {
  it("keep human tokens out of the file the agent team loads", () => {
    const dir = tempDir();
    writeSeatTokens(dir, allTokens());
    expect(json(dir, AGENT_TOKENS_FILE)).not.toHaveProperty("human-cfo");
    expect(Object.keys(json(dir, AGENT_TOKENS_FILE)).sort()).toEqual(INITIAL_ORG.filter((s) => s.kind === "agent").map((s) => s.seatId).sort());
    expect(json(dir, HUMAN_TOKENS_FILE)).toEqual({ "human-cfo": "human-cfo-token" });
    expect(mode(dir, AGENT_TOKENS_FILE)).toBe(0o600);
    expect(mode(dir, HUMAN_TOKENS_FILE)).toBe(0o600);
    expect(readHumanToken(dir)).toBe("human-cfo-token");
    expect(readAgentTokens(dir)).not.toHaveProperty("human-cfo");
  });

  it("migrate a legacy combined seats.json on first read", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, AGENT_TOKENS_FILE), JSON.stringify(allTokens()), { mode: 0o600 });
    const agents = readAgentTokens(dir);
    expect(agents).not.toHaveProperty("human-cfo");
    expect(agents).toHaveProperty("controller", "controller-token");
    expect(json(dir, AGENT_TOKENS_FILE)).not.toHaveProperty("human-cfo");
    expect(json(dir, HUMAN_TOKENS_FILE)).toEqual({ "human-cfo": "human-cfo-token" });
    expect(mode(dir, HUMAN_TOKENS_FILE)).toBe(0o600);
  });

  it("never overwrite an existing human token during migration", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, HUMAN_TOKENS_FILE), JSON.stringify({ "human-cfo": "current" }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, AGENT_TOKENS_FILE), JSON.stringify(allTokens()), { mode: 0o600 });
    readAgentTokens(dir);
    expect(readHumanToken(dir)).toBe("current");
  });

  it("let the gateway read the human token from a legacy run too", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, AGENT_TOKENS_FILE), JSON.stringify(allTokens()), { mode: 0o600 });
    expect(readHumanToken(dir)).toBe("human-cfo-token");
    expect(json(dir, AGENT_TOKENS_FILE)).not.toHaveProperty("human-cfo");
  });
});

describe("agent team credentials", () => {
  it("load only agent tokens and never open the human token file", () => {
    const { runId } = runFixture(false);
    const read = vi.spyOn(fs, "readFileSync");
    const team = new Team(runId);
    expect((team as unknown as { tokens: Record<string, string> }).tokens).not.toHaveProperty("human-cfo");
    expect(read.mock.calls.map((c) => String(c[0]))).not.toContainEqual(expect.stringContaining(HUMAN_TOKENS_FILE));
  });

  it("drop the human token from a legacy run's seats.json", () => {
    const { runId, dir } = runFixture(true);
    const team = new Team(runId);
    expect((team as unknown as { tokens: Record<string, string> }).tokens).not.toHaveProperty("human-cfo");
    expect(json(dir, AGENT_TOKENS_FILE)).not.toHaveProperty("human-cfo");
  });

  it("leave the gateway able to act as the human", () => {
    const { runId } = runFixture(false);
    const h = humanClient(runId);
    expect(h.auth).toMatchObject({ runId, seatId: "human-cfo", token: "human-cfo-token" });
  });
});
