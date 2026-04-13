import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('RP service dispatch', () => {
  const MOCK_RP_URL = 'http://localhost:8300';

  beforeEach(() => {
    vi.stubEnv('RP_SERVICE_URL', MOCK_RP_URL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('POSTs latest message to RP service and sends response to channel', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ response: 'RP says hello' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { dispatchToRpService } = await import('./index.js');

    const sendMessage = vi.fn();
    const result = await dispatchToRpService(
      {
        content: 'hello research partner',
        sender_name: 'Alice',
      },
      'dc:research-channel',
      { sendMessage },
    );

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(`${MOCK_RP_URL}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'hello research partner',
        sender: 'Alice',
        channel: 'dc:research-channel',
      }),
    });
    expect(sendMessage).toHaveBeenCalledWith('dc:research-channel', 'RP says hello');
  });

  it('sends error message when RP service returns non-OK', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { dispatchToRpService } = await import('./index.js');

    const sendMessage = vi.fn();
    const result = await dispatchToRpService(
      { content: 'hello', sender_name: 'Alice' },
      'dc:research-channel',
      { sendMessage },
    );

    expect(result).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      'dc:research-channel',
      'Research Partner is currently unavailable.',
    );
  });

  it('sends error message when RP service is unreachable', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const { dispatchToRpService } = await import('./index.js');

    const sendMessage = vi.fn();
    const result = await dispatchToRpService(
      { content: 'hello', sender_name: 'Alice' },
      'dc:research-channel',
      { sendMessage },
    );

    expect(result).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      'dc:research-channel',
      'Research Partner service is not running.',
    );
  });

  it('returns true with no action when latestMessage is undefined', async () => {
    const { dispatchToRpService } = await import('./index.js');

    const sendMessage = vi.fn();
    const result = await dispatchToRpService(
      undefined,
      'dc:research-channel',
      { sendMessage },
    );

    expect(result).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not send channel message when RP response is empty', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ response: '' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { dispatchToRpService } = await import('./index.js');

    const sendMessage = vi.fn();
    await dispatchToRpService(
      { content: 'hello', sender_name: 'Alice' },
      'dc:research-channel',
      { sendMessage },
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('uses default URL when RP_SERVICE_URL is not set', async () => {
    vi.unstubAllEnvs();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ response: 'ok' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { dispatchToRpService } = await import('./index.js');

    const sendMessage = vi.fn();
    await dispatchToRpService(
      { content: 'hello', sender_name: 'Alice' },
      'dc:research-channel',
      { sendMessage },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8300/message',
      expect.any(Object),
    );
  });
});
