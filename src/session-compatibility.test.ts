import { describe, expect, it } from 'vitest';

import {
  buildSessionContextVersion,
  shouldInvalidateStoredSession,
} from './session-compatibility.js';

describe('session-compatibility', () => {
  it('builds a stable version regardless of entry order', () => {
    const a = buildSessionContextVersion({
      salt: 'main-lane-v1',
      entries: [
        { path: 'b.ts', content: 'beta' },
        { path: 'a.md', content: 'alpha' },
      ],
    });

    const b = buildSessionContextVersion({
      salt: 'main-lane-v1',
      entries: [
        { path: 'a.md', content: 'alpha' },
        { path: 'b.ts', content: 'beta' },
      ],
    });

    expect(a).toBe(b);
  });

  it('invalidates a stored session when the context version changes', () => {
    expect(
      shouldInvalidateStoredSession({
        sessionId: 'session-main-1',
        storedVersion: 'old-version',
        currentVersion: 'new-version',
      }),
    ).toBe(true);
  });

  it('keeps the stored session when the version matches', () => {
    expect(
      shouldInvalidateStoredSession({
        sessionId: 'session-main-1',
        storedVersion: 'same-version',
        currentVersion: 'same-version',
      }),
    ).toBe(false);
  });

  it('does not invalidate when there is no reusable session', () => {
    expect(
      shouldInvalidateStoredSession({
        sessionId: undefined,
        storedVersion: 'old-version',
        currentVersion: 'new-version',
      }),
    ).toBe(false);
  });
});
