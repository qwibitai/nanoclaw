import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authMe, postSteer } from './api.js';

describe('api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('test_api_authMe_includes_credentials', () => {
    it('authMe includes credentials: include', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user_id: 'u1', scopes: { role: 'owner', allowed_group_ids: [], no_filter: true } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await authMe();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.credentials).toBe('include');
    });
  });

  describe('test_api_postSteer_body_shape', () => {
    it('postSteer sends correct body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ task_id: 'spawn-abc', message_id: 'msg-1', echo_status: 'pending' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await postSteer('spawn-abc', { idempotency_key: 'uuid-1', text: 'hi' });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/dashboard/api/tasks/spawn-abc/message');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ idempotency_key: 'uuid-1', text: 'hi' });
    });
  });

  describe('test_api_throws_typed_error_on_non_2xx', () => {
    it('throws typed error on 422', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: () => Promise.resolve({ error: 'mismatched_idempotency_payload' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(
        postSteer('spawn-abc', { idempotency_key: 'x', text: 'hi' })
      ).rejects.toMatchObject({ status: 422, error: 'mismatched_idempotency_payload' });
    });
  });

  describe('test_api_throws_retry_after_on_429', () => {
    it('throws typed error with retry_after on 429', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ error: 'rate_limit_exceeded', retry_after: 5 }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(
        postSteer('spawn-abc', { idempotency_key: 'x', text: 'hi' })
      ).rejects.toMatchObject({ status: 429, error: 'rate_limit_exceeded', retry_after: 5 });
    });
  });
});
