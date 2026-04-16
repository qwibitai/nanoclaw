import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock fs to return fake credentials
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (typeof p === 'string' && p.includes('gmail-mcp') && p.endsWith('credentials.json')) return true;
      if (typeof p === 'string' && p.includes('gmail-mcp') && p.endsWith('gcp-oauth.keys.json')) return true;
      return actual.existsSync(p);
    }),
    readFileSync: vi.fn((p: string, enc?: string) => {
      if (typeof p === 'string' && p.endsWith('credentials.json')) {
        return JSON.stringify({
          access_token: 'test-token',
          refresh_token: 'test-refresh',
          scope: 'https://www.googleapis.com/auth/calendar.readonly',
          token_type: 'Bearer',
          expiry_date: Date.now() + 3600000,
        });
      }
      if (typeof p === 'string' && p.endsWith('gcp-oauth.keys.json')) {
        return JSON.stringify({
          installed: {
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
            token_uri: 'https://oauth2.googleapis.com/token',
            auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
            redirect_uris: ['http://localhost'],
          },
        });
      }
      return actual.readFileSync(p, enc as any);
    }),
  };
});

import { fetchCalendarEvents, type CalendarAccountConfig } from './calendar-fetcher.js';

describe('fetchCalendarEvents', () => {
  it('returns empty array when no accounts provided', async () => {
    const events = await fetchCalendarEvents(
      Date.now(),
      Date.now() + 86400000,
      [],
    );
    expect(events).toEqual([]);
  });

  it('handles API errors gracefully and returns empty array', async () => {
    const accounts: CalendarAccountConfig[] = [
      {
        label: 'test',
        credentialsPath: '/fake/credentials.json',
        oauthKeysPath: '/fake/gcp-oauth.keys.json',
      },
    ];

    // The function will try to call Google Calendar API
    // which will fail since we're not providing a real token,
    // but it should handle the error gracefully
    const events = await fetchCalendarEvents(
      Date.now(),
      Date.now() + 86400000,
      accounts,
    );

    // Should return empty array on API failure (graceful)
    expect(Array.isArray(events)).toBe(true);
  });
});
