import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Temp dir for credential store
const tmpDir = path.join(os.tmpdir(), `nanoclaw-claude-test-${Date.now()}`);
vi.stubEnv('HOME', tmpDir);

beforeEach(() => {
  fs.mkdirSync(path.join(tmpDir, '.config', 'nanoclaw'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Mock logger
vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock env.ts
vi.mock('../../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

const { initCredentialStore, encrypt, decrypt, saveCredential } = await import(
  '../store.js'
);
const { readEnvFile } = await import('../../env.js');

// Mock config.js for IDLE_TIMEOUT
vi.mock('../../config.js', () => ({
  IDLE_TIMEOUT: 1800_000,
}));

// Mock exec.js for authSessionDir
vi.mock('../exec.js', () => ({
  authSessionDir: vi.fn((scope: string) => path.join(tmpDir, 'sessions', scope)),
}));

// Import after mocks
const { claudeProvider, isAuthError, waitForOutput, UrlExtractor, LineExtractor, detectCodeDelivery, deliverCode } = await import(
  './claude.js'
);

describe('claudeProvider', () => {
  beforeEach(() => {
    initCredentialStore();
  });

  describe('provision', () => {
    it('returns empty env when no credentials exist', () => {
      const result = claudeProvider.provision('nonexistent');
      expect(result.env).toEqual({});
    });

    it('provisions api_key as ANTHROPIC_API_KEY', () => {
      claudeProvider.storeResult('test', {
        auth_type: 'api_key',
        token: 'sk-ant-api03-test',
        expires_at: null,
      });

      const result = claudeProvider.provision('test');
      expect(result.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-test');
    });

    it('provisions setup_token as CLAUDE_CODE_OAUTH_TOKEN', () => {
      claudeProvider.storeResult('test', {
        auth_type: 'setup_token',
        token: 'sk-ant-oat01-test',
        expires_at: null,
      });

      const result = claudeProvider.provision('test');
      expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test');
    });

    it('provisions auth_login by extracting accessToken', () => {
      const credsJson = JSON.stringify({
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });

      claudeProvider.storeResult('test', {
        auth_type: 'auth_login',
        token: credsJson,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });

      const result = claudeProvider.provision('test');
      expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('access-123');
    });

    it('returns empty env for expired auth_login', () => {
      const credsJson = JSON.stringify({
        accessToken: 'expired-access',
        refreshToken: 'refresh',
        expiresAt: new Date(Date.now() - 3600_000).toISOString(),
      });

      claudeProvider.storeResult('test', {
        auth_type: 'auth_login',
        token: credsJson,
        expires_at: new Date(Date.now() - 3600_000).toISOString(),
      });

      const result = claudeProvider.provision('test');
      expect(result.env).toEqual({});
    });

    it('provisions env_fallback by parsing stored JSON', () => {
      const envVars = {
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-from-env',
        ANTHROPIC_BASE_URL: 'https://custom.api',
      };

      saveCredential('test', 'claude_auth', {
        auth_type: 'env_fallback',
        token: encrypt(JSON.stringify(envVars)),
        expires_at: null,
        updated_at: new Date().toISOString(),
      });

      const result = claudeProvider.provision('test');
      expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-from-env');
      expect(result.env.ANTHROPIC_BASE_URL).toBe('https://custom.api');
    });
  });

  describe('hasAuth', () => {
    it('returns false when no credential stored', () => {
      expect(claudeProvider.hasAuth('empty')).toBe(false);
    });

    it('returns true after storing', () => {
      claudeProvider.storeResult('has-test', {
        auth_type: 'api_key',
        token: 'key',
        expires_at: null,
      });
      expect(claudeProvider.hasAuth('has-test')).toBe(true);
    });
  });

  describe('storeResult', () => {
    it('encrypts the token', () => {
      claudeProvider.storeResult('enc-test', {
        auth_type: 'api_key',
        token: 'plaintext-secret',
        expires_at: null,
      });

      // Read raw file to verify encryption
      const configDir = path.join(tmpDir, '.config', 'nanoclaw');
      const credFile = path.join(
        configDir,
        'credentials',
        'enc-test',
        'claude_auth.json',
      );
      const raw = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
      expect(raw.token).toMatch(/^enc:aes-256-gcm:/);
      expect(decrypt(raw.token)).toBe('plaintext-secret');
    });
  });

  describe('importEnv', () => {
    it('imports .env values into scope', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        ANTHROPIC_API_KEY: 'sk-ant-api03-from-env',
      });

      claudeProvider.importEnv!('default');
      expect(claudeProvider.hasAuth('default')).toBe(true);

      const result = claudeProvider.provision('default');
      expect(result.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-from-env');
    });

    it('skips import if credentials already exist', () => {
      claudeProvider.storeResult('default', {
        auth_type: 'api_key',
        token: 'existing-key',
        expires_at: null,
      });

      vi.mocked(readEnvFile).mockReturnValueOnce({
        ANTHROPIC_API_KEY: 'should-not-overwrite',
      });

      claudeProvider.importEnv!('default');

      const result = claudeProvider.provision('default');
      expect(result.env.ANTHROPIC_API_KEY).toBe('existing-key');
    });

    it('skips import when .env has no relevant keys', () => {
      vi.mocked(readEnvFile).mockReset();
      vi.mocked(readEnvFile).mockReturnValue({});

      claudeProvider.importEnv!('empty-env-scope');
      expect(claudeProvider.hasAuth('empty-env-scope')).toBe(false);
    });
  });

  describe('authOptions', () => {
    it('returns 3 options', () => {
      const options = claudeProvider.authOptions('test');
      expect(options).toHaveLength(3);
      expect(options[0].label).toContain('Setup token');
      expect(options[1].label).toContain('Auth login');
      expect(options[2].label).toContain('API key');
    });
  });
});

describe('isAuthError', () => {
  it('detects auth errors', () => {
    expect(isAuthError('invalid token')).toBe(true);
    expect(isAuthError('unauthorized')).toBe(true);
    expect(isAuthError('authentication failed')).toBe(true);
    expect(isAuthError('HTTP 401')).toBe(true);
    expect(isAuthError('expired token')).toBe(true);
    expect(isAuthError('invalid_grant')).toBe(true);
  });

  it('detects billing errors', () => {
    expect(isAuthError('Credit balance is too low')).toBe(true);
    expect(isAuthError('insufficient credits')).toBe(true);
    expect(isAuthError('billing issue')).toBe(true);
    expect(isAuthError('rate limit exceeded')).toBe(true);
    expect(isAuthError('quota exceeded')).toBe(true);
  });

  it('returns false for non-auth errors', () => {
    expect(isAuthError('timeout after 300s')).toBe(false);
    expect(isAuthError('connection refused')).toBe(false);
    expect(isAuthError('out of memory')).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError('')).toBe(false);
  });
});

describe('waitForOutput', () => {
  it('matches URL in complete line', async () => {
    const output = { value: '' };
    const promise = waitForOutput(
      output,
      new UrlExtractor(/https:\/\/console\.anthropic\.com\S+/),
      5000,
    );

    // Simulate output arriving all at once
    output.value = 'Open this link:\nhttps://console.anthropic.com/oauth/authorize?code=abc123\n\n';

    const match = await promise;
    expect(match).not.toBeNull();
    expect(match![0]).toBe(
      'https://console.anthropic.com/oauth/authorize?code=abc123',
    );
  });

  it('waits for newline before matching — prevents partial URL', async () => {
    const output = { value: '' };
    const promise = waitForOutput(
      output,
      new UrlExtractor(/https:\/\/console\.anthropic\.com\S+/),
      3000,
    );

    // Chunk 1: URL starts but no newline yet
    output.value = 'https://console.anthropic.com/oauth';

    // Wait a poll cycle — should NOT match yet (no newline)
    await new Promise((r) => setTimeout(r, 600));

    // Chunk 2: URL continues and completes with newline
    output.value += '/authorize?code=abc123&state=xyz\n\n';

    const match = await promise;
    expect(match).not.toBeNull();
    expect(match![0]).toBe(
      'https://console.anthropic.com/oauth/authorize?code=abc123&state=xyz',
    );
  });

  it('returns null on timeout', async () => {
    const output = { value: 'no url here\n' };
    const match = await waitForOutput(
      output,
      new UrlExtractor(/https:\/\/console\.anthropic\.com\S+/),
      500,
    );
    expect(match).toBeNull();
  });

  it('handles multiple chunks building up a complete line', async () => {
    const output = { value: '' };
    const promise = waitForOutput(
      output,
      new LineExtractor(/sk-ant-oat01-\S+/),
      3000,
    );

    // Chunk 1: partial token, no newline
    output.value = 'Your token: sk-ant-oat01-abc';

    await new Promise((r) => setTimeout(r, 600));

    // Chunk 2: rest of token + newline
    output.value += 'def123\n';

    const match = await promise;
    expect(match).not.toBeNull();
    expect(match![0]).toBe('sk-ant-oat01-abcdef123');
  });

  it('ignores incomplete last line but matches earlier complete lines', async () => {
    const output = { value: '' };
    const promise = waitForOutput(
      output,
      new UrlExtractor(/https:\/\/console\.anthropic\.com\S+/),
      3000,
    );

    // Complete URL on first line, incomplete data on second line
    output.value =
      'https://console.anthropic.com/oauth/authorize?id=full\n\npartial data no newline';

    const match = await promise;
    expect(match).not.toBeNull();
    expect(match![0]).toBe(
      'https://console.anthropic.com/oauth/authorize?id=full',
    );
  });
});

describe('UrlExtractor', () => {
  it('extracts URL split across lines with ANSI sequences', () => {
    const extractor = new UrlExtractor(/https:\/\/console\.anthropic\.com\S+/);
    extractor.feed(
      'Open this link:\n' +
      'https://console.anthropic.com/oauth/authorize?client_id=abc&\x1b[1C\n' +
      'redirect_uri=http%3A%2F%2Flocalhost%3A9876\n' +
      '\n',
    );
    const match = extractor.result();
    expect(match).not.toBeNull();
    expect(match![0]).toContain('client_id=abc');
    expect(match![0]).toContain('redirect_uri=');
  });

  it('stops at empty line after URL', () => {
    const extractor = new UrlExtractor(/https:\/\/example\.com\S+/);
    extractor.feed('https://example.com/path?q=1\n\nother stuff\n');
    const match = extractor.result();
    expect(match).not.toBeNull();
    expect(match![0]).toBe('https://example.com/path?q=1');
  });

  it('returns null while URL is still accumulating', () => {
    const extractor = new UrlExtractor(/https:\/\/example\.com\S+/);
    extractor.feed('https://example.com/path');
    expect(extractor.result()).toBeNull();
    // Complete the line
    extractor.feed('https://example.com/path?q=1\n\n');
    expect(extractor.result()).not.toBeNull();
  });

  it('strips ANSI from URL fragments', () => {
    const extractor = new UrlExtractor(/https:\/\/example\.com\S+/);
    extractor.feed('https://example.com/\x1b[0mpath\n\n');
    const match = extractor.result();
    expect(match).not.toBeNull();
    expect(match![0]).toBe('https://example.com/path');
  });
});

describe('LineExtractor', () => {
  it('matches pattern on a complete line with ANSI stripped', () => {
    const extractor = new LineExtractor(/Paste\s+code\s+here/);
    extractor.feed('some output\n\x1b[1CPaste\x1b[1C code here\n');
    expect(extractor.result()).not.toBeNull();
  });

  it('returns null on partial line', () => {
    const extractor = new LineExtractor(/Paste\s+code/);
    extractor.feed('Paste code');
    expect(extractor.result()).toBeNull();
  });

  it('does not re-process already consumed lines', () => {
    const extractor = new LineExtractor(/token: (\S+)/);
    extractor.feed('line1\n');
    extractor.feed('line1\ntoken: abc123\n');
    const match = extractor.result();
    expect(match).not.toBeNull();
    expect(match![1]).toBe('abc123');
  });
});

describe('detectCodeDelivery', () => {
  function makeHandle(): import('../types.js').ExecHandle {
    let waitResolve: (v: { exitCode: number; stdout: string; stderr: string }) => void;
    const waitPromise = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (r) => { waitResolve = r; },
    );
    return {
      onStdout: vi.fn(),
      stdin: { write: vi.fn(), end: vi.fn() },
      wait: () => waitPromise,
      kill: vi.fn(),
      // Expose for test control
      _resolve: (v: { exitCode: number; stdout: string; stderr: string }) => waitResolve(v),
    } as any;
  }

  it('detects stdin when paste prompt appears in stdout', async () => {
    const sessionDir = path.join(tmpDir, 'detect-stdin');
    fs.mkdirSync(sessionDir, { recursive: true });
    const output = { value: '' };
    const handle = makeHandle();

    const promise = detectCodeDelivery(output, sessionDir, 5000, handle);

    // Simulate paste prompt appearing (no trailing \n — it's a prompt)
    output.value = 'Opening browser...\nPaste code here if prompted > ';

    const result = await promise;
    expect(result).toEqual({ method: 'stdin' });
  });

  it('detects callback when .oauth-url file appears', async () => {
    const sessionDir = path.join(tmpDir, 'detect-callback');
    fs.mkdirSync(sessionDir, { recursive: true });
    const output = { value: '' };
    const handle = makeHandle();

    const promise = detectCodeDelivery(output, sessionDir, 5000, handle);

    // Simulate shim writing the OAuth URL (with encoded redirect_uri containing localhost port)
    fs.writeFileSync(
      path.join(sessionDir, '.oauth-url'),
      'https://console.anthropic.com/oauth/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcallback\n',
    );

    const result = await promise;
    expect(result).toEqual({ method: 'callback', callbackPort: 54321 });
  });

  it('prefers stdin over callback when both appear', async () => {
    const sessionDir = path.join(tmpDir, 'detect-both');
    fs.mkdirSync(sessionDir, { recursive: true });
    const output = { value: '' };
    const handle = makeHandle();

    // Write URL file before starting detection (gets cleaned up by detectCodeDelivery)
    fs.writeFileSync(
      path.join(sessionDir, '.oauth-url'),
      'https://console.anthropic.com/oauth?redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback\n',
    );

    const promise = detectCodeDelivery(output, sessionDir, 5000, handle);

    // stdin check runs first in the interval, so set it immediately
    output.value = 'Paste code here if prompted > ';

    const result = await promise;
    expect(result).toEqual({ method: 'stdin' });
  });

  it('returns null on timeout', async () => {
    const sessionDir = path.join(tmpDir, 'detect-timeout');
    fs.mkdirSync(sessionDir, { recursive: true });
    const output = { value: 'nothing useful\n' };
    const handle = makeHandle();

    const result = await detectCodeDelivery(output, sessionDir, 500, handle);
    expect(result).toBeNull();
  });

  it('returns null when container exits', async () => {
    const sessionDir = path.join(tmpDir, 'detect-exit');
    fs.mkdirSync(sessionDir, { recursive: true });
    const output = { value: '' };
    const handle = makeHandle();

    const promise = detectCodeDelivery(output, sessionDir, 30_000, handle);

    // Simulate container exit
    (handle as any)._resolve({ exitCode: 1, stdout: '', stderr: '' });

    const result = await promise;
    expect(result).toBeNull();
  });

  it('cleans up stale .oauth-url from previous attempt', async () => {
    const sessionDir = path.join(tmpDir, 'detect-cleanup');
    fs.mkdirSync(sessionDir, { recursive: true });
    const staleFile = path.join(sessionDir, '.oauth-url');
    fs.writeFileSync(staleFile, 'http://localhost:99999/callback\n');

    const output = { value: '' };
    const handle = makeHandle();

    // Start detection — it should unlink the stale file
    const promise = detectCodeDelivery(output, sessionDir, 1000, handle);

    // File should be gone immediately
    expect(fs.existsSync(staleFile)).toBe(false);

    // Let it timeout
    const result = await promise;
    expect(result).toBeNull();
  });
});

describe('deliverCode', () => {
  it('writes to stdin for stdin delivery', async () => {
    const stdin = { write: vi.fn(), end: vi.fn() };
    const handle = {
      onStdout: vi.fn(),
      stdin,
      wait: vi.fn(),
      kill: vi.fn(),
    } as any;

    const result = await deliverCode('authcode123#stateabc', { method: 'stdin' as const }, handle);
    expect(result).toBe(true);
    expect(stdin.write).toHaveBeenCalledWith('authcode123#stateabc\n');
  });

  it('returns false for callback without hash separator', async () => {
    const handle = { onStdout: vi.fn(), stdin: { write: vi.fn(), end: vi.fn() }, wait: vi.fn(), kill: vi.fn() } as any;
    const result = await deliverCode('no-hash-here', { method: 'callback' as const, callbackPort: 12345 }, handle);
    expect(result).toBe(false);
  });

  it('returns false for callback without port', async () => {
    const handle = { onStdout: vi.fn(), stdin: { write: vi.fn(), end: vi.fn() }, wait: vi.fn(), kill: vi.fn() } as any;
    const result = await deliverCode('code#state', { method: 'callback' as const }, handle);
    expect(result).toBe(false);
  });
});
