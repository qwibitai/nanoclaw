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
