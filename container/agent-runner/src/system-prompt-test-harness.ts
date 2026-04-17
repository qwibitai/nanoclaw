import { vi } from 'vitest';

import type { SystemPromptDeps } from './system-prompt.js';

/** Build a fully-mocked SystemPromptDeps; callers override only what they need. */
export function createMockDeps(
  overrides: Partial<SystemPromptDeps> = {},
): SystemPromptDeps {
  return {
    readFile: vi.fn().mockReturnValue(null),
    execSubprocess: vi.fn().mockResolvedValue(null),
    createMcpClient: vi.fn().mockResolvedValue(null),
    loadMcpConfig: vi.fn().mockReturnValue({}),
    log: vi.fn(),
    ...overrides,
  };
}
