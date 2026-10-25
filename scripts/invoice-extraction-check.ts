/** Offline development-corpus check. No network, model calls, or accounting effects. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseSupportedSource } from "../src/invoice-mvp/parser";
import { extractionCustomers, extractionFixtures, matchesExtraction } from "../tests/fixtures/invoice-extraction";

const arg = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const baseline = arg("--baseline-module");
const parser: typeof parseSupportedSource = baseline ? (await import(pathToFileURL(path.resolve(baseline)).href)).parseSupportedSource : parseSupportedSource;
const cases = extractionFixtures.map((fixture) => {
  const conclusion = parser(fixture.source, { documentId: fixture.id, version: 1, contentHash: createHash("sha256").update(fixture.source.text).digest("hex") }, fixture.customers ?? extractionCustomers).conclusion;
  return { id: fixture.id, pass: matchesExtraction(conclusion, fixture), treatment: conclusion.treatment, fieldQuotesValid: conclusion.evidence.every((e) => e.quote !== undefined && fixture.source.text.includes(e.quote)), warnings: conclusion.contradictions };
});
console.log(JSON.stringify({ kind: "public_development_regressions_not_unseen_accuracy", modelCalls: 0, cases: cases.length, passed: cases.filter((c) => c.pass).length, fixtureSha256: createHash("sha256").update(JSON.stringify(extractionFixtures)).digest("hex"), results: cases }, null, 2));
