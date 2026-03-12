import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock env.ts — getValidToken falls back to this
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import {
  readCredentials,
  writeCredentials,
  refreshOAuthToken,
  getValidToken,
  TOKEN_ENDPOINT,
  CLIENT_ID,
  type OAuthCredentials,
} from './oauth.js';
import { readEnvFile } from './env.js';

const CREDS_PATH = path.join(process.cwd(), 'oauth-credentials.json');

// Helper to create valid credentials
function validCreds(overrides?: Partial<OAuthCredentials>): OAuthCredentials {
  return {
    accessToken: 'sk-ant-oat01-valid-access-token',
    refreshToken: 'sk-ant-ort01-valid-refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
    ...overrides,
  };
}

describe('readCredentials', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed credentials from valid file', () => {
    const creds = validCreds();
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(creds));

    const result = readCredentials();
    expect(result).toEqual(creds);
  });

  it('returns null on missing file', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(readCredentials()).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('not json {{{');

    expect(readCredentials()).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ accessToken: 'x' }),
    );

    expect(readCredentials()).toBeNull();
  });
});

describe('writeCredentials', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes atomic file with correct content', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

    const creds = validCreds();
    writeCredentials(creds);

    // Written to tmp file first
    expect(writeSpy).toHaveBeenCalledWith(
      CREDS_PATH + '.tmp',
      JSON.stringify(creds, null, 2) + '\n',
      { mode: 0o600 },
    );

    // Renamed atomically
    expect(renameSpy).toHaveBeenCalledWith(CREDS_PATH + '.tmp', CREDS_PATH);
  });
});

describe('refreshOAuthToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends correct POST body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-token',
          token_type: 'bearer',
        }),
        { status: 200 },
      ),
    );

    await refreshOAuthToken('my-refresh-token');

    expect(fetchSpy).toHaveBeenCalledWith(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'my-refresh-token',
        client_id: CLIENT_ID,
      }).toString(),
    });
  });

  it('parses success response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 54000,
          token_type: 'bearer',
        }),
        { status: 200 },
      ),
    );

    const result = await refreshOAuthToken('old-refresh');
    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBe('new-refresh');
    expect(result.expiresIn).toBe(54000);
  });

  it('handles response with no refresh_token (no rotation)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          token_type: 'bearer',
        }),
        { status: 200 },
      ),
    );

    const result = await refreshOAuthToken('old-refresh');
    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBeUndefined();
    expect(result.expiresIn).toBeUndefined();
  });

  it('throws on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('invalid_grant', { status: 400 }),
    );

    await expect(refreshOAuthToken('bad-token')).rejects.toThrow(
      'OAuth refresh failed (400)',
    );
  });
});

describe('getValidToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns accessToken when not expired', async () => {
    const creds = validCreds({ expiresAt: Date.now() + 60 * 60 * 1000 });
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(creds));

    const token = await getValidToken();
    expect(token).toBe(creds.accessToken);
  });

  it('falls back to .env when no credentials file', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.mocked(readEnvFile).mockReturnValue({
      CLAUDE_CODE_OAUTH_TOKEN: 'env-token',
    });

    const token = await getValidToken();
    expect(token).toBe('env-token');
  });

  it('returns empty string when no token anywhere', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.mocked(readEnvFile).mockReturnValue({});

    const token = await getValidToken();
    expect(token).toBe('');
  });

  it('calls refresh when near expiry', async () => {
    // Token expires in 2 minutes (within 5-min buffer)
    const creds = validCreds({ expiresAt: Date.now() + 2 * 60 * 1000 });
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(creds));
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'refreshed-token',
          expires_in: 54000,
          token_type: 'bearer',
        }),
        { status: 200 },
      ),
    );

    const token = await getValidToken();
    expect(token).toBe('refreshed-token');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('persists rotated refresh token', async () => {
    const creds = validCreds({ expiresAt: Date.now() + 1000 }); // nearly expired
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(creds));
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'rotated-refresh',
          expires_in: 54000,
          token_type: 'bearer',
        }),
        { status: 200 },
      ),
    );

    await getValidToken();

    // Check that the written credentials include the rotated refresh token
    const writtenContent = writeSpy.mock.calls[0][1] as string;
    const written = JSON.parse(writtenContent);
    expect(written.refreshToken).toBe('rotated-refresh');
  });

  it('falls back to stale token on refresh failure', async () => {
    const creds = validCreds({ expiresAt: Date.now() + 1000 }); // nearly expired
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(creds));

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const token = await getValidToken();
    expect(token).toBe(creds.accessToken); // stale fallback
  });

  it('deduplicates concurrent refresh calls', async () => {
    const creds = validCreds({ expiresAt: Date.now() + 1000 }); // nearly expired
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(creds));
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

    let resolveRefresh: (value: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockReturnValue(fetchPromise);

    // Start two concurrent calls
    const p1 = getValidToken();
    const p2 = getValidToken();

    // Resolve the single fetch
    resolveRefresh!(
      new Response(
        JSON.stringify({
          access_token: 'deduped-token',
          expires_in: 54000,
          token_type: 'bearer',
        }),
        { status: 200 },
      ),
    );

    const [t1, t2] = await Promise.all([p1, p2]);

    // Both get the same token
    expect(t1).toBe('deduped-token');
    expect(t2).toBe('deduped-token');

    // Only one fetch call was made
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps original refresh token when server does not rotate', async () => {
    const creds = validCreds({ expiresAt: Date.now() + 1000 });
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(creds));
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          // no refresh_token in response
          expires_in: 54000,
          token_type: 'bearer',
        }),
        { status: 200 },
      ),
    );

    await getValidToken();

    const writtenContent = writeSpy.mock.calls[0][1] as string;
    const written = JSON.parse(writtenContent);
    expect(written.refreshToken).toBe(creds.refreshToken); // kept original
  });
});
