import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 180_000, // 3 min per test (container builds are slow)
    hookTimeout: 300_000, // 5 min for setup/teardown hooks
    sequence: { concurrent: false }, // Run sequentially — shared Docker state
  },
});
