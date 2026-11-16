import { defineConfig } from "vitest/config";

export default defineConfig({
  // spikes/ is milestone 0 reference only: spikes/bb's dependencies are gone and spikes/openui-lib is its own package.
  test: {
    include: ["*.test.{ts,tsx}", "{server,ui,scripts}/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
  },
});
