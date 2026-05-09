import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Vitest 4 auto-discovers package.json files as workspace projects, which
    // would pick up container/agent-runner/ (whose tests use `bun:test` and
    // can't run under vitest). Excluding the directory keeps host-only.
    exclude: [
      '**/node_modules/**',
      '**/container/**',
      '**/data/**',
      '**/logs/**',
      '**/.claude/**',
    ],
  },
});
