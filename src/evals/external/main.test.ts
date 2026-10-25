import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sha256 } from "./evidence";
import { emptyUsage } from "../../agents/llm";

let dir: string, data: string, saved: string, blocker: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-cli-test-"));
  data = path.join(dir, "data"); saved = path.join(dir, "saved"); blocker = path.join(dir, "no-network.mjs");
  fs.mkdirSync(path.join(data, "public"), { recursive: true }); fs.mkdirSync(path.join(data, "private")); fs.mkdirSync(saved);
  fs.writeFileSync(blocker, 'globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN_IN_TEST"); };');
  const evidence = path.join(data, "public", "fixture.sqlite"); fs.writeFileSync(evidence, "unused: no evidence queries needed");
  const manifest = JSON.parse(fs.readFileSync("benchmarks/finance-eight.json", "utf8"));
  const tasks = manifest.tasks.map((task: any) => ({ id: task.id, benchmark: task.benchmark, sourceId: task.id, label: "CLI fixture", role: task.role, prompt: "Test prompt", evidence: "public/fixture.sqlite", evidenceSha256: sha256(evidence) }));
  fs.writeFileSync(path.join(data, "tasks.json"), JSON.stringify({ tasks }));
  fs.writeFileSync(path.join(data, "private", "gold.json"), JSON.stringify(Object.fromEntries(tasks.map((task: any) => [task.id, task.benchmark === "apex" ? { kind: "rubric", answer: "expert", criteria: [{ id: "a", description: "correct" }] } : { kind: "number", answer: "1" }]))));
  fs.writeFileSync(path.join(data, "provenance.json"), JSON.stringify({ manifestSha256: sha256("benchmarks/finance-eight.json"), tasksSha256: sha256(path.join(data, "tasks.json")), goldSha256: sha256(path.join(data, "private", "gold.json")) }));
  fs.writeFileSync(path.join(saved, "config.json"), JSON.stringify({ provenanceSha256: sha256(path.join(data, "provenance.json")), expectedRuns: 1 }));
  fs.writeFileSync(path.join(saved, "results.json"), JSON.stringify([{ taskId: "apex-13", benchmark: "apex", mode: "rules-only", repeat: 1, wallSeconds: 0, status: "answered", answer: "answer", usage: emptyUsage(), trace: [], grade: { status: "ungraded", score: null, passed: null, method: "test", judgeUsage: emptyUsage() } }]));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function cli(command: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", blocker, "--import", "tsx", "src/evals/external/main.ts", command, "--data", data, ...args], { encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "test-only", ANTHROPIC_API_KEY: "test-only", AGENT_LLM: "on" } });
}
it.each(["full-team", "generalist", "rules-only"])("blocks %s with the default policy before creating outputs or sending requests", (mode) => {
  const output = path.join(dir, "output");
  const result = cli("run", ["--tasks", "apex-13", "--modes", mode, "--repeats", "1", "--run", output]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("disabled pending explicit model and budget approval");
  expect(result.stderr).not.toContain("NETWORK_FORBIDDEN");
  expect(fs.existsSync(output)).toBe(false);
});
it("blocks paid rescoring without touching original answers/grades", () => {
  const original = fs.readFileSync(path.join(saved, "results.json"), "utf8");
  const result = cli("score", ["--run", saved]);
  expect(result.status).toBe(1); expect(result.stderr).toContain("disabled pending");
  expect(fs.readFileSync(path.join(saved, "results.json"), "utf8")).toBe(original);
  expect(fs.existsSync(path.join(saved, "rescoring.json"))).toBe(false);
});
it("allows free matrix/rescore previews and judge-off rescoring", () => {
  const preview = cli("run", ["--dry-run"]);
  expect(preview.status, preview.stderr).toBe(0); expect(preview.stdout).toContain('"paidExecution": "disabled"');
  expect(cli("score", ["--dry-run", "--run", saved]).status).toBe(0);
  expect(cli("score", ["--judge", "off", "--run", saved]).status).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(saved, "results.json"), "utf8"))[0].grade).toMatchObject({ score: null, status: "ungraded" });
});
