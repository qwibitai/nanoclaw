import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['.claude/skills/**/tests/*.test.ts'],
  },
});
