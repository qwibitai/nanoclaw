import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('checkTrustWithPolling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('polls until approval is granted', async () => {
    fetchMock
      // Initial evaluate call -> pending
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'pending', approval_id: 'ap-1' }),
      })
      // First poll -> pending
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'pending' }),
      })
      // Second poll -> approved
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'approved' }),
      });

    const { checkTrustWithPolling } =
      await import('../../container/agent-runner/src/tool-bridge.ts');
    const result = await checkTrustWithPolling(
      'send_message',
      'chat@jid',
      'test-group',
      'test',
      { pollIntervalMs: 10, maxPollMs: 5000 },
    );
    expect(result).toEqual({ allowed: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns denied when approval is denied', async () => {
    fetchMock
      // Initial evaluate -> pending
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'pending', approval_id: 'ap-2' }),
      })
      // Poll -> denied
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'denied' }),
      });

    const { checkTrustWithPolling } =
      await import('../../container/agent-runner/src/tool-bridge.ts');
    const result = await checkTrustWithPolling(
      'send_message',
      'chat@jid',
      'test-group',
      'test',
      { pollIntervalMs: 10, maxPollMs: 5000 },
    );
    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/denied/);
  });

  it('times out after maxPollMs', async () => {
    fetchMock
      // Initial evaluate -> pending
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'pending', approval_id: 'ap-3' }),
      })
      // All subsequent polls -> pending
      .mockResolvedValue({
        ok: true,
        json: async () => ({ decision: 'pending' }),
      });

    const { checkTrustWithPolling } =
      await import('../../container/agent-runner/src/tool-bridge.ts');
    const result = await checkTrustWithPolling(
      'send_message',
      'chat@jid',
      'test-group',
      'test',
      { pollIntervalMs: 10, maxPollMs: 50 },
    );
    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it('auto-approves when gateway returns approved immediately', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ decision: 'approved' }),
    });

    const { checkTrustWithPolling } =
      await import('../../container/agent-runner/src/tool-bridge.ts');
    const result = await checkTrustWithPolling(
      'send_message',
      'chat@jid',
      'test-group',
      'test',
    );
    expect(result).toEqual({ allowed: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
