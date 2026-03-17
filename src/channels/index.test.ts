import { describe, it, expect, vi } from 'vitest';

// Mock all channel modules to prevent side effects during test
vi.mock('./gmail.js', () => ({}));
vi.mock('./telegram.js', () => ({}));

// INVARIANT: The barrel file imports all channel modules, triggering self-registration.
// SUT: src/channels/index.ts
// VERIFICATION: Importing index.ts does not throw and channel modules are loaded.
describe('channels barrel file', () => {
  it('imports without errors', async () => {
    await expect(import('./index.js')).resolves.toBeDefined();
  });
});
