import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['.claude/skills/icloud-tools/tests/**/*.test.ts'],
  },
});
