// `npm test` runs every *.test.* file under the repo root. Agent worktrees live in
// .claude/worktrees/ and runtime data in var/; neither belongs to this checkout's suite.
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**", "var/**"],
  },
});
