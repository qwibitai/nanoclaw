import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'skills-engine/**/*.test.ts'],
  },
});
