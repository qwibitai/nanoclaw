import { describe, it, expect } from 'vitest';
import { SessionGuard } from './session-guard.js';

describe('SessionGuard', () => {
  it('is not cleared by default', () => {
    const guard = new SessionGuard();
    expect(guard.isCleared('group-a')).toBe(false);
  });

  it('marks a group as cleared', () => {
    const guard = new SessionGuard();
    guard.markCleared('group-a');
    expect(guard.isCleared('group-a')).toBe(true);
  });

  it('does not affect other groups', () => {
    const guard = new SessionGuard();
    guard.markCleared('group-a');
    expect(guard.isCleared('group-b')).toBe(false);
  });

  it('startRun removes the cleared mark', () => {
    const guard = new SessionGuard();
    guard.markCleared('group-a');
    expect(guard.isCleared('group-a')).toBe(true);

    guard.startRun('group-a');
    expect(guard.isCleared('group-a')).toBe(false);
  });

  it('startRun is a no-op for non-cleared groups', () => {
    const guard = new SessionGuard();
    guard.startRun('group-a');
    expect(guard.isCleared('group-a')).toBe(false);
  });

  it('can be re-cleared after startRun', () => {
    const guard = new SessionGuard();
    guard.markCleared('group-a');
    guard.startRun('group-a');
    guard.markCleared('group-a');
    expect(guard.isCleared('group-a')).toBe(true);
  });

  it('handles multiple groups independently', () => {
    const guard = new SessionGuard();
    guard.markCleared('group-a');
    guard.markCleared('group-b');

    guard.startRun('group-a');
    expect(guard.isCleared('group-a')).toBe(false);
    expect(guard.isCleared('group-b')).toBe(true);
  });

  describe('session save suppression scenario', () => {
    it('prevents session restore after clear while agent is running', () => {
      const guard = new SessionGuard();
      const sessions: Record<string, string> = { 'group-a': 'session-X' };

      // Simulate /clear: session deleted, guard marks cleared
      delete sessions['group-a'];
      guard.markCleared('group-a');

      // Simulate still-running agent's output trying to restore session
      const newSessionId = 'session-X';
      if (newSessionId && !guard.isCleared('group-a')) {
        sessions['group-a'] = newSessionId;
      }

      // Session should still be absent
      expect(sessions['group-a']).toBeUndefined();
    });

    it('allows session save after new agent run starts', () => {
      const guard = new SessionGuard();
      const sessions: Record<string, string> = {};

      // Previous clear
      guard.markCleared('group-a');

      // New agent run starts
      guard.startRun('group-a');

      // New agent's output saves session normally
      const newSessionId = 'session-Y';
      if (newSessionId && !guard.isCleared('group-a')) {
        sessions['group-a'] = newSessionId;
      }

      expect(sessions['group-a']).toBe('session-Y');
    });

    it('suppresses session restore until next run even with multiple outputs', () => {
      const guard = new SessionGuard();
      const sessions: Record<string, string> = {};

      guard.markCleared('group-a');

      // Multiple streaming outputs from the winding-down agent
      for (const sid of ['session-X', 'session-X', 'session-X']) {
        if (sid && !guard.isCleared('group-a')) {
          sessions['group-a'] = sid;
        }
      }

      expect(sessions['group-a']).toBeUndefined();

      // New run
      guard.startRun('group-a');
      if (!guard.isCleared('group-a')) {
        sessions['group-a'] = 'session-Z';
      }
      expect(sessions['group-a']).toBe('session-Z');
    });
  });
});
