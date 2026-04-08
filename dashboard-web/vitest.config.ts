import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

// Vitest config for the FamBot dashboard SPA. Mirrors the @/* alias
// from vite.config.ts so test files can import @/types, @/lib, etc.
// Test scope is intentionally narrow — only pure-function helpers
// (lib/schedule.ts) get unit coverage. React component tests are
// out of scope per the plan.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
