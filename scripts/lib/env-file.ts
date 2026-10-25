// Small, dependency-free helpers for the uncommitted .env.local file. Every edit keeps the
// file's other lines (comments, order, values written by `convex dev`) exactly as they were.
import { randomBytes } from "node:crypto";
import fs from "node:fs";

export const ENV_FILE = ".env.local";
export const ADMIN_SECRET_PLACEHOLDER = "change-me";

const KEY_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Active KEY=value settings in a dotenv text, in the same unquoting style as src/core/env.ts. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = KEY_LINE.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim().replace(/^["']|["']$/g, ""));
  }
  return out;
}

/**
 * Set `values` in a dotenv text. A key that already has a non-empty value is left alone unless
 * `overwrite` names it; an empty `KEY=` line is filled in place; a missing key is appended.
 */
export function upsertEnv(text: string, values: Record<string, string>, overwrite: readonly string[] = []): { text: string; changed: string[] } {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const changed: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((l) => KEY_LINE.exec(l.trim())?.[1] === key && !l.trim().startsWith("#"));
    if (index < 0) { lines.push(`${key}=${value}`); changed.push(key); continue; }
    const current = parseEnv(lines[index]!).get(key) ?? "";
    if (current === value || (current !== "" && !overwrite.includes(key))) continue;
    lines[index] = `${key}=${value}`;
    changed.push(key);
  }
  return { text: lines.length ? `${lines.join("\n")}\n` : "", changed };
}

/**
 * Bring an existing .env.local up to date with .env.example: append the active settings it is
 * missing (with their example values), never touching settings it already has.
 */
export function mergeExample(existing: string, example: string): { text: string; added: string[] } {
  const have = parseEnv(existing);
  const missing = Object.fromEntries([...parseEnv(example)].filter(([k]) => !have.has(k)));
  if (!Object.keys(missing).length) return { text: existing, added: [] };
  const base = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  const { text } = upsertEnv(`${base}\n# Added by npm run setup from .env.example\n`, missing);
  return { text, added: Object.keys(missing) };
}

/** True for a missing, empty or documented placeholder admin secret. */
export function isPlaceholderSecret(value: string | undefined): boolean {
  return !value?.trim() || value.trim() === ADMIN_SECRET_PLACEHOLDER;
}

export const newSecret = () => randomBytes(32).toString("hex");

export function readEnvFile(file = ENV_FILE): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

export function writeEnvFile(text: string, file = ENV_FILE): void {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
