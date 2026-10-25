import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const selections = JSON.parse(readFileSync(new URL("selection.json", import.meta.url), "utf8"));
if (!process.env.AP_REVIEW_CAPTURE_DIR?.startsWith("/private/tmp/ap97-claude-component-")) {
  throw new Error("Set AP_REVIEW_CAPTURE_DIR to a new /private/tmp/ap97-claude-component-* directory");
}
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export default defineConfig({ test: {
  include: [...new Set(selections.map(s => s.file))],
  testNamePattern: new RegExp(selections.map(s => escape(s.titleContains)).join("|")),
  setupFiles: [fileURLToPath(new URL("capture.setup.mjs", import.meta.url))],
  maxWorkers: 1,
  fileParallelism: false,
  testTimeout: 30000,
  hookTimeout: 30000,
} });
