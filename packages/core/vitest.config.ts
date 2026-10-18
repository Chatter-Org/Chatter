import { defineConfig } from "vitest/config";

// Node, not jsdom: the core must run without a browser, and a test that
// reaches for `document` or `window` should fail here rather than pass.
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
  },
});
