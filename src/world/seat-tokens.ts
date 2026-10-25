import fs from "node:fs";
import path from "node:path";
import { INITIAL_ORG } from "../core/org";

// Seat bearer tokens for a run live in two files in var/runs/<run>/:
//   seats.json        agent seats only; the agent Team loads this
//   human-seats.json  human seats; read only by the human gateway and by scripts that
//                     legitimately act as the human (smoke and control tests)
// The kernel treats a seat as human purely by its token, so the agent process must never
// hold a human token. Both files are 0600; they separate processes by convention, not by
// OS user, so this does not defend against code running as the same user.

export const AGENT_TOKENS_FILE = "seats.json";
export const HUMAN_TOKENS_FILE = "human-seats.json";

const HUMAN_SEATS = new Set(INITIAL_ORG.filter((s) => s.kind === "human").map((s) => s.seatId));

export const isHumanSeat = (seatId: string) => HUMAN_SEATS.has(seatId);

type Tokens = Record<string, string>;

const readJson = (file: string): Tokens => JSON.parse(fs.readFileSync(file, "utf8")) as Tokens;
const writeJson = (file: string, tokens: Tokens) => fs.writeFileSync(file, JSON.stringify(tokens, null, 2), { mode: 0o600 });

function split(tokens: Tokens): { agents: Tokens; humans: Tokens } {
  const agents: Tokens = {};
  const humans: Tokens = {};
  for (const [id, token] of Object.entries(tokens)) (isHumanSeat(id) ? humans : agents)[id] = token;
  return { agents, humans };
}

/** Write a new run's tokens, human seats to their own file. */
export function writeSeatTokens(dir: string, tokens: Tokens): void {
  const { agents, humans } = split(tokens);
  writeJson(path.join(dir, HUMAN_TOKENS_FILE), humans);
  writeJson(path.join(dir, AGENT_TOKENS_FILE), agents);
}

/** Rewrite the agent token file (the Team does this when it staffs up). Refuses human seats. */
export function writeAgentTokens(dir: string, tokens: Tokens): void {
  const human = Object.keys(tokens).find(isHumanSeat);
  if (human) throw new Error(`refusing to write the ${human} token to ${AGENT_TOKENS_FILE}`);
  writeJson(path.join(dir, AGENT_TOKENS_FILE), tokens);
}

/**
 * Runs created before the split kept every token in seats.json. Move human tokens out (an
 * existing human file wins) and rewrite seats.json without them. Returns the agent tokens.
 */
function migrate(dir: string, all: Tokens): Tokens {
  const { agents, humans } = split(all);
  if (!Object.keys(humans).length) return agents;
  const humanFile = path.join(dir, HUMAN_TOKENS_FILE);
  const existing = fs.existsSync(humanFile) ? readJson(humanFile) : {};
  writeJson(humanFile, { ...humans, ...existing });
  writeJson(path.join(dir, AGENT_TOKENS_FILE), agents);
  return agents;
}

/** Agent tokens only. Never reads the human token file. */
export function readAgentTokens(dir: string): Tokens {
  return migrate(dir, readJson(path.join(dir, AGENT_TOKENS_FILE)));
}

/** A human seat's token, for the gateway and scripts that act as the human. */
export function readHumanToken(dir: string, seatId = "human-cfo"): string {
  const humanFile = path.join(dir, HUMAN_TOKENS_FILE);
  const read = () => (fs.existsSync(humanFile) ? readJson(humanFile)[seatId] : undefined);
  let token = read();
  // A legacy run: the token is still in seats.json until something migrates it.
  const agentFile = path.join(dir, AGENT_TOKENS_FILE);
  if (!token && fs.existsSync(agentFile)) {
    migrate(dir, readJson(agentFile));
    token = read();
  }
  if (!token) throw new Error(`no token for ${seatId} in ${humanFile}`);
  return token;
}
