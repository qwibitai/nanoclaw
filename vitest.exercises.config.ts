import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['../../notes/nanoclaw/*.test.ts'],
  },
});
