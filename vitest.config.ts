import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'container/agent-runner/src/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'container/agent-runner/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/__tests__/**',
        '**/*.d.ts',
        'src/types.ts',
        // Entry points (imperative main() with side effects) —
        // covered end-to-end by integration tests and manual runs.
        'src/index.ts',
        'container/agent-runner/src/index.ts',
        'container/agent-runner/src/main.ts',
        // Barrel file: just imports to trigger channel self-registration.
        'src/channels/index.ts',
        // Modules that wrap long-running I/O (spawned processes, SDK
        // `for await` loops, filesystem side effects in very specific
        // layouts) — unit testing them adds more mock scaffolding than
        // confidence. They're covered by integration tests and manual
        // run-through. When any of these is refactored to be purer,
        // drop its entry here.
        'src/host-runner.ts',
        'src/host-runner/setup.ts',
        'src/host-runner/build.ts',
        'container/agent-runner/src/query-runner.ts',
        'container/agent-runner/src/script-runner.ts',
        'container/agent-runner/src/workspace.ts',
      ],
      reporter: ['text', 'html', 'lcov'],
      // Thresholds start at the current baseline and will be raised to 90
      // in Step 8 after the refactor/test-expansion work lands.
      thresholds: {
        lines: 65,
        functions: 65,
        branches: 55,
        statements: 65,
      },
    },
  },
});
