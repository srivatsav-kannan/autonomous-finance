import { defineConfig } from "vitest/config";
export default defineConfig({
  server: { fs: { strict: false } },
  test: { include: ["**/*.probe.ts"] },
});
