import { describe, expect, it, vi } from 'vitest';

import { createSessionStore } from './session-store.js';

describe('session store', () => {
  it('loads and persists sessions by group and provider pair', () => {
    // Arrange
    const persisted = new Map<string, string>([
      ['team-space::claude-code', 'claude-session'],
      ['team-space::codex', 'codex-session'],
    ]);
    const deps = {
      getSession: vi.fn((groupFolder: string, providerId: string) =>
        persisted.get(`${groupFolder}::${providerId}`),
      ),
      setSession: vi.fn(
        (groupFolder: string, sessionId: string, providerId: string) => {
          persisted.set(`${groupFolder}::${providerId}`, sessionId);
        },
      ),
      deleteSession: vi.fn((groupFolder: string, providerId: string) => {
        persisted.delete(`${groupFolder}::${providerId}`);
      }),
    };
    const store = createSessionStore(deps);

    // Act
    const claudeSession = store.get('team-space', 'claude-code');
    const codexSession = store.get('team-space', 'codex');
    store.set('team-space', 'codex', 'codex-session-next');

    // Assert
    expect(claudeSession).toBe('claude-session');
    expect(codexSession).toBe('codex-session');
    expect(persisted.get('team-space::claude-code')).toBe('claude-session');
    expect(persisted.get('team-space::codex')).toBe('codex-session-next');
  });

  it('deletes only the targeted provider namespace', () => {
    // Arrange
    const persisted = new Map<string, string>([
      ['team-space::claude-code', 'claude-session'],
      ['team-space::codex', 'codex-session'],
    ]);
    const deps = {
      getSession: vi.fn((groupFolder: string, providerId: string) =>
        persisted.get(`${groupFolder}::${providerId}`),
      ),
      setSession: vi.fn(
        (groupFolder: string, sessionId: string, providerId: string) => {
          persisted.set(`${groupFolder}::${providerId}`, sessionId);
        },
      ),
      deleteSession: vi.fn((groupFolder: string, providerId: string) => {
        persisted.delete(`${groupFolder}::${providerId}`);
      }),
    };
    const store = createSessionStore(deps);

    // Act
    store.delete('team-space', 'codex');
    const remainingClaudeSession = store.get('team-space', 'claude-code');
    const deletedCodexSession = store.get('team-space', 'codex');

    // Assert
    expect(remainingClaudeSession).toBe('claude-session');
    expect(deletedCodexSession).toBeUndefined();
    expect(persisted.get('team-space::claude-code')).toBe('claude-session');
    expect(persisted.has('team-space::codex')).toBe(false);
  });
});
