import { defineConfig } from "vitest/config";

/**
 * Many tests start real processes (git, node, the CLI). On CI runners, Windows above all, those take 2-5 s each, so
 * vitest's 5 s default made the suite fail at random. 30 s still catches a test that hangs.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
