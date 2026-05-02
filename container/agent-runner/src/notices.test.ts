import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readNotices, acknowledgeNotice, postNotice } from './notices.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Notice Board', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      TELEMETRY_API_URL: 'http://100.99.148.99:3100',
      TELEMETRY_REGISTRATION_TOKEN: 'test-token',
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('readNotices', () => {
    it('fetches unread notices with auth header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 'n1',
            title: 'Task complete',
            body: 'Finished migration',
            author_name: 'DB',
            audience: ['@all'],
            priority: 'normal',
            created_at: '2026-03-27T09:00:00Z',
          },
        ],
      });

      const result = await readNotices();
      expect(result).toContain('Task complete');
      expect(result).toContain('DB');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/notices?unread_by=self&audience=self&limit=10'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        }),
      );
    });

    it('returns friendly message when no notices', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const result = await readNotices();
      expect(result).toBe('No unread notices.');
    });

    it('returns error string on HTTP failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const result = await readNotices();
      expect(result).toContain('Error');
      expect(result).toContain('500');
    });
  });

  describe('postNotice', () => {
    it('posts notice with title and audience', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'n2', title: 'New task', author_name: 'Relay', priority: 'normal', created_at: '2026-03-27T10:00:00Z' }),
      });

      const result = await postNotice('New task', { audience: ['@all'], body: 'Please run migration' });
      expect(result).toContain('Notice created');
      expect(result).toContain('n2');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/notices');
      const body = JSON.parse(opts.body);
      expect(body.title).toBe('New task');
      expect(body.audience).toEqual(['@all']);
      expect(body.body).toBe('Please run migration');
    });

    it('rejects empty title', async () => {
      const result = await postNotice('');
      expect(result).toContain('Error');
      expect(result).toContain('title');
    });
  });

  describe('acknowledgeNotice', () => {
    it('marks notice as read', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ notice_id: 'n1', read_at: '2026-03-27T10:05:00Z' }),
      });

      const result = await acknowledgeNotice('n1');
      expect(result).toContain('acknowledged');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/notices/n1/read'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('throws when telemetry config is missing', async () => {
    delete process.env.TELEMETRY_API_URL;
    delete process.env.TELEMETRY_REGISTRATION_TOKEN;

    await expect(readNotices()).rejects.toThrow('TELEMETRY_API_URL');
  });
});
