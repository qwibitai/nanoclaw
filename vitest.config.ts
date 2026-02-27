import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.eval.ts', 'setup/**/*.test.ts', 'skills-engine/**/*.test.ts'],
    clearMocks: true,
  },
});
