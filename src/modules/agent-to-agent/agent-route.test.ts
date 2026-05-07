import { beforeEach, describe, expect, it } from 'vitest';

import { checkAgentRouteRateLimit, isSafeAttachmentName, resetAgentRouteRateLimit } from './agent-route.js';

/**
 * `forwardAttachedFiles` has a filesystem side that's awkward to unit-test
 * without mocking DATA_DIR. The guarantee worth pinning is that the
 * filename validator rejects everything that could escape the inbox dir —
 * `forwardAttachedFiles` runs this guard before any I/O, so traversal is
 * impossible as long as this matrix holds.
 */
describe('isSafeAttachmentName', () => {
  it('accepts plain filenames', () => {
    expect(isSafeAttachmentName('baby-duck.png')).toBe(true);
    expect(isSafeAttachmentName('file with spaces.pdf')).toBe(true);
    expect(isSafeAttachmentName('report.v2.docx')).toBe(true);
    expect(isSafeAttachmentName('.hidden')).toBe(true); // leading dot is fine, just not `.` / `..`
  });

  it('rejects empty / sentinel values', () => {
    expect(isSafeAttachmentName('')).toBe(false);
    expect(isSafeAttachmentName('.')).toBe(false);
    expect(isSafeAttachmentName('..')).toBe(false);
  });

  it('rejects path separators', () => {
    expect(isSafeAttachmentName('../evil.png')).toBe(false);
    expect(isSafeAttachmentName('/etc/passwd')).toBe(false);
    expect(isSafeAttachmentName('nested/file.txt')).toBe(false);
    expect(isSafeAttachmentName('windows\\path.exe')).toBe(false);
  });

  it('rejects NUL bytes', () => {
    expect(isSafeAttachmentName('clean\0.png')).toBe(false);
  });

  it('rejects anything path.basename would strip', () => {
    expect(isSafeAttachmentName('a/b')).toBe(false);
    expect(isSafeAttachmentName('./thing')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isSafeAttachmentName(null as unknown as string)).toBe(false);
    expect(isSafeAttachmentName(undefined as unknown as string)).toBe(false);
  });
});

/**
 * Backstop for runaway agent-to-agent traffic. Two distinct loop classes
 * are reachable from normal LLM behaviour:
 *   - self-loop (agent writes to itself, post-approval-notes path)
 *   - peer politeness loop (two agents reciprocate acks)
 *
 * Both are bounded here by a sliding window with separate self/peer caps.
 */
describe('checkAgentRouteRateLimit', () => {
  const A = 'ag-aaa';
  const B = 'ag-bbb';
  const C = 'ag-ccc';

  beforeEach(() => resetAgentRouteRateLimit());

  it('allows a single peer route', () => {
    expect(checkAgentRouteRateLimit(A, B).ok).toBe(true);
  });

  it('allows a single self route', () => {
    expect(checkAgentRouteRateLimit(A, A).ok).toBe(true);
  });

  it('allows up to the self-route limit within the window', () => {
    const t = 1000;
    for (let i = 0; i < 3; i++) {
      const r = checkAgentRouteRateLimit(A, A, t + i);
      expect(r.ok).toBe(true);
    }
  });

  it('rejects the self-route over the limit within the window', () => {
    const t = 1000;
    for (let i = 0; i < 3; i++) checkAgentRouteRateLimit(A, A, t + i);
    const r = checkAgentRouteRateLimit(A, A, t + 4);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.recent).toBe(3);
      expect(r.limit).toBe(3);
    }
  });

  it('allows up to the peer-route limit within the window', () => {
    const t = 1000;
    for (let i = 0; i < 10; i++) {
      const r = checkAgentRouteRateLimit(A, B, t + i);
      expect(r.ok).toBe(true);
    }
  });

  it('rejects the peer-route over the limit within the window', () => {
    const t = 1000;
    for (let i = 0; i < 10; i++) checkAgentRouteRateLimit(A, B, t + i);
    const r = checkAgentRouteRateLimit(A, B, t + 11);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.recent).toBe(10);
      expect(r.limit).toBe(10);
    }
  });

  it('peer-route limit is looser than self-route limit', () => {
    const t = 1000;
    // Push 4 peer routes — past self-limit (3) but under peer-limit (10).
    for (let i = 0; i < 4; i++) {
      expect(checkAgentRouteRateLimit(A, B, t + i).ok).toBe(true);
    }
  });

  it('resets after the window expires', () => {
    const t = 1000;
    for (let i = 0; i < 3; i++) checkAgentRouteRateLimit(A, A, t + i);
    const r = checkAgentRouteRateLimit(A, A, t + 60_001);
    expect(r.ok).toBe(true);
  });

  it('keeps separate counts per (from, to) pair', () => {
    const t = 1000;
    for (let i = 0; i < 3; i++) checkAgentRouteRateLimit(A, A, t + i);
    expect(checkAgentRouteRateLimit(A, B, t + 4).ok).toBe(true);
    expect(checkAgentRouteRateLimit(B, A, t + 4).ok).toBe(true);
    expect(checkAgentRouteRateLimit(C, A, t + 4).ok).toBe(true);
  });

  it('A->B count is independent of B->A count', () => {
    const t = 1000;
    for (let i = 0; i < 10; i++) checkAgentRouteRateLimit(A, B, t + i);
    expect(checkAgentRouteRateLimit(B, A, t + 11).ok).toBe(true);
  });
});
