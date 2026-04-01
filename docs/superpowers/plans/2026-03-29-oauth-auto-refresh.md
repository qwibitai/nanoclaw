# OAuth Auto-Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the credential proxy auto-refresh OAuth tokens from `~/.claude/.credentials.json` so Claude Max subscription tokens stay valid without manual intervention.

**Architecture:** The credential proxy (`src/credential-proxy.ts`) gains three new functions: `readCredentials()` reads the credentials file, `refreshOAuthToken()` calls the Anthropic refresh endpoint, and `ensureValidToken()` orchestrates check-and-refresh. A 4-minute interval timer keeps tokens fresh. The proxy request handler reads the current token from a mutable reference that gets updated on refresh.

**Tech Stack:** Node.js, native `https` module for refresh calls, `fs` for credentials file I/O, Vitest for tests.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/credential-proxy.ts` | Modify | Add credential reading, refresh logic, periodic timer |
| `src/credential-proxy.test.ts` | Modify | Add tests for reading, refresh, write-back, timer, error handling |

No new files needed. The two existing OAuth test cases that use `CLAUDE_CODE_OAUTH_TOKEN` from `.env` will be replaced with credentials-file-based equivalents.

---

### Task 1: Add credential file reading and refresh function

**Files:**
- Modify: `src/credential-proxy.ts`
- Modify: `src/credential-proxy.test.ts`

- [ ] **Step 1: Write the failing test for `readCredentials()`**

Add to `src/credential-proxy.test.ts` — a new `describe` block after the existing one. Remove the top-level `vi.mock('./env.js')` and existing `mockEnv` pattern (they'll be replaced in Task 3). For now, add these tests at the bottom of the file:

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('readCredentials', () => {
  let tmpDir: string;
  let credsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-test-'));
    credsPath = path.join(tmpDir, '.credentials.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads accessToken and refreshToken from credentials file', () => {
    fs.writeFileSync(
      credsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'access-123',
          refreshToken: 'refresh-456',
          expiresAt: Date.now() + 3600000,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
      }),
    );

    const creds = readCredentials(credsPath);
    expect(creds.accessToken).toBe('access-123');
    expect(creds.refreshToken).toBe('refresh-456');
    expect(creds.expiresAt).toBeGreaterThan(Date.now());
  });

  it('throws if file does not exist', () => {
    expect(() => readCredentials('/nonexistent/.credentials.json')).toThrow();
  });

  it('throws if claudeAiOauth is missing', () => {
    fs.writeFileSync(credsPath, JSON.stringify({ other: 'data' }));
    expect(() => readCredentials(credsPath)).toThrow('claudeAiOauth');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/credential-proxy.test.ts`
Expected: FAIL — `readCredentials` is not exported / does not exist.

- [ ] **Step 3: Write the failing test for `refreshOAuthToken()`**

Add to `src/credential-proxy.test.ts`:

```typescript
describe('refreshOAuthToken', () => {
  let mockRefreshServer: http.Server;
  let refreshPort: number;

  beforeEach(async () => {
    mockRefreshServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (body.includes('refresh_token=valid-refresh')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'new-access-token',
              refresh_token: 'new-refresh-token',
              expires_in: 3600,
            }),
          );
        } else {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
      });
    });
    await new Promise<void>((resolve) =>
      mockRefreshServer.listen(0, '127.0.0.1', resolve),
    );
    refreshPort = (mockRefreshServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => mockRefreshServer?.close(() => r()));
  });

  it('returns new tokens on successful refresh', async () => {
    const result = await refreshOAuthToken(
      'valid-refresh',
      `http://127.0.0.1:${refreshPort}`,
    );
    expect(result.accessToken).toBe('new-access-token');
    expect(result.refreshToken).toBe('new-refresh-token');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('throws on 401 response', async () => {
    await expect(
      refreshOAuthToken(
        'invalid-refresh',
        `http://127.0.0.1:${refreshPort}`,
      ),
    ).rejects.toThrow('401');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/credential-proxy.test.ts`
Expected: FAIL — `refreshOAuthToken` is not exported / does not exist.

- [ ] **Step 5: Implement `readCredentials()` and `refreshOAuthToken()`**

Add to `src/credential-proxy.ts`, after the existing imports:

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';

const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export function defaultCredentialsPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

export function readCredentials(credentialsPath: string): OAuthCredentials {
  const raw = fs.readFileSync(credentialsPath, 'utf-8');
  const data = JSON.parse(raw);
  const oauth = data.claudeAiOauth;
  if (!oauth) {
    throw new Error(
      'credentials file missing claudeAiOauth — run "claude" to authenticate',
    );
  }
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
  };
}

export async function refreshOAuthToken(
  refreshToken: string,
  tokenUrl = REFRESH_URL,
): Promise<OAuthCredentials> {
  const url = new URL(tokenUrl);
  const isHttps = url.protocol === 'https:';
  const makeReq = isHttps ? httpsRequest : httpRequest;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = makeReq(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `OAuth refresh failed with ${res.statusCode}: ${Buffer.concat(chunks).toString()}`,
              ),
            );
            return;
          }
          const json = JSON.parse(Buffer.concat(chunks).toString());
          resolve({
            accessToken: json.access_token,
            refreshToken: json.refresh_token,
            expiresAt: Date.now() + json.expires_in * 1000,
          });
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/credential-proxy.test.ts`
Expected: All `readCredentials` and `refreshOAuthToken` tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/credential-proxy.ts src/credential-proxy.test.ts
git commit -m "feat: add readCredentials and refreshOAuthToken to credential proxy"
```

---

### Task 2: Add ensureValidToken with write-back and retry

**Files:**
- Modify: `src/credential-proxy.ts`
- Modify: `src/credential-proxy.test.ts`

- [ ] **Step 1: Write the failing test for `ensureValidToken()`**

Add to `src/credential-proxy.test.ts`:

```typescript
describe('ensureValidToken', () => {
  let tmpDir: string;
  let credsPath: string;
  let mockRefreshServer: http.Server;
  let refreshPort: number;
  let refreshCallCount: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-test-'));
    credsPath = path.join(tmpDir, '.credentials.json');
    refreshCallCount = 0;

    mockRefreshServer = http.createServer((req, res) => {
      refreshCallCount++;
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: `refreshed-access-${refreshCallCount}`,
            refresh_token: `refreshed-refresh-${refreshCallCount}`,
            expires_in: 3600,
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      mockRefreshServer.listen(0, '127.0.0.1', resolve),
    );
    refreshPort = (mockRefreshServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await new Promise<void>((r) => mockRefreshServer?.close(() => r()));
  });

  it('refreshes token when within 5 minutes of expiry', async () => {
    const credsData = {
      claudeAiOauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() + 2 * 60 * 1000, // 2 min from now (within buffer)
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
    };
    fs.writeFileSync(credsPath, JSON.stringify(credsData));

    const result = await ensureValidToken(
      credsPath,
      `http://127.0.0.1:${refreshPort}`,
    );

    expect(result.accessToken).toBe('refreshed-access-1');

    // Verify write-back
    const written = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    expect(written.claudeAiOauth.accessToken).toBe('refreshed-access-1');
    expect(written.claudeAiOauth.refreshToken).toBe('refreshed-refresh-1');
    expect(written.claudeAiOauth.scopes).toEqual(['user:inference']);
    expect(written.claudeAiOauth.subscriptionType).toBe('max');
  });

  it('does not refresh when token is still valid', async () => {
    const credsData = {
      claudeAiOauth: {
        accessToken: 'still-valid',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
      },
    };
    fs.writeFileSync(credsPath, JSON.stringify(credsData));

    const result = await ensureValidToken(
      credsPath,
      `http://127.0.0.1:${refreshPort}`,
    );

    expect(result.accessToken).toBe('still-valid');
    expect(refreshCallCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/credential-proxy.test.ts`
Expected: FAIL — `ensureValidToken` is not exported / does not exist.

- [ ] **Step 3: Implement `ensureValidToken()`**

Add to `src/credential-proxy.ts`:

```typescript
export async function ensureValidToken(
  credentialsPath: string,
  tokenUrl = REFRESH_URL,
  maxRetries = 3,
): Promise<OAuthCredentials> {
  const creds = readCredentials(credentialsPath);

  // Token still valid (outside 5-minute buffer)
  if (creds.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return creds;
  }

  logger.info('OAuth token expiring soon, refreshing...');

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const refreshed = await refreshOAuthToken(creds.refreshToken, tokenUrl);

      // Write back to credentials file, preserving other fields
      const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
      raw.claudeAiOauth = {
        ...raw.claudeAiOauth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      };
      fs.writeFileSync(credentialsPath, JSON.stringify(raw, null, 2));

      logger.info('OAuth token refreshed successfully');
      return refreshed;
    } catch (err) {
      lastError = err as Error;
      logger.warn(
        { err, attempt, maxRetries },
        'OAuth refresh attempt failed',
      );
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  logger.error({ err: lastError }, 'All OAuth refresh attempts failed, using current token');
  return creds;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/credential-proxy.test.ts`
Expected: All `ensureValidToken` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/credential-proxy.ts src/credential-proxy.test.ts
git commit -m "feat: add ensureValidToken with write-back and retry logic"
```

---

### Task 3: Wire auto-refresh into the proxy server and update existing tests

**Files:**
- Modify: `src/credential-proxy.ts` (lines 26-119 — `startCredentialProxy`)
- Modify: `src/credential-proxy.test.ts` (update existing tests)

- [ ] **Step 1: Write the failing test for OAuth mode using credentials file**

Replace the two existing OAuth tests in the `credential-proxy` describe block. The test setup needs to change: instead of mocking `readEnvFile` for OAuth tokens, we'll write a temporary credentials file. Keep the `readEnvFile` mock for `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` only.

Update the test to:

```typescript
describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let tmpDir: string;
  let credsPath: string;

  beforeEach(async () => {
    lastUpstreamHeaders = {};
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-'));
    credsPath = path.join(tmpDir, '.credentials.json');

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  // ... keep the startProxy helper for API-key mode tests ...

  it('OAuth mode reads token from credentials file and injects Authorization', async () => {
    fs.writeFileSync(
      credsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'creds-file-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 3600000,
        },
      }),
    );

    Object.assign(mockEnv, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0, '127.0.0.1', credsPath);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer creds-file-token',
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/credential-proxy.test.ts`
Expected: FAIL — `startCredentialProxy` doesn't accept a `credentialsPath` parameter yet.

- [ ] **Step 3: Update `startCredentialProxy` to use credentials file for OAuth mode**

Modify the `startCredentialProxy` function signature and body in `src/credential-proxy.ts`:

```typescript
export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  credentialsPath = defaultCredentialsPath(),
): Promise<Server> {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  // For OAuth mode, read token from credentials file
  let currentToken: string | undefined;
  let currentRefreshToken: string | undefined;
  if (authMode === 'oauth') {
    const creds = readCredentials(credentialsPath);
    currentToken = creds.accessToken;
    currentRefreshToken = creds.refreshToken;
  }

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // Start periodic refresh timer for OAuth mode
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  if (authMode === 'oauth') {
    const refreshInterval = async () => {
      try {
        const refreshed = await ensureValidToken(credentialsPath);
        currentToken = refreshed.accessToken;
        currentRefreshToken = refreshed.refreshToken;
      } catch (err) {
        logger.error({ err }, 'Periodic OAuth refresh failed');
      }
    };
    refreshTimer = setInterval(refreshInterval, 4 * 60 * 1000); // 4 minutes
    refreshTimer.unref(); // Don't keep process alive for refresh timer
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          if (headers['authorization']) {
            delete headers['authorization'];
            if (currentToken) {
              headers['authorization'] = `Bearer ${currentToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.on('close', () => {
      if (refreshTimer) clearInterval(refreshTimer);
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
```

Also update `detectAuthMode` to no longer check for `.env` OAuth tokens:

```typescript
/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
```

(This function is unchanged — it already only checks `ANTHROPIC_API_KEY`.)

- [ ] **Step 4: Update existing tests**

The API-key mode tests in the existing `credential-proxy` describe block should continue working without changes (they set `ANTHROPIC_API_KEY` in `mockEnv`).

Update the two old OAuth tests (that used `CLAUDE_CODE_OAUTH_TOKEN` in `mockEnv`) to use the credentials file approach shown in Step 1. Also update the `startProxy` helper to pass `credsPath`:

```typescript
  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0, '127.0.0.1', credsPath);
    return (proxyServer.address() as AddressInfo).port;
  }
```

For the old "OAuth mode does not inject Authorization when container omits it" test, create a credentials file in the test:

```typescript
  it('OAuth mode does not inject Authorization when container omits it', async () => {
    fs.writeFileSync(
      credsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'real-oauth-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 3600000,
        },
      }),
    );

    proxyPort = await startProxy({});

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });
```

- [ ] **Step 5: Run all tests to verify they pass**

Run: `npx vitest run src/credential-proxy.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Build and run full test suite**

Run: `npm run build && npx vitest run src/credential-proxy.test.ts src/container-runner.test.ts`
Expected: Build clean, all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/credential-proxy.ts src/credential-proxy.test.ts
git commit -m "feat: wire OAuth auto-refresh into credential proxy with periodic timer"
```

---

### Task 4: Verify end-to-end and restart service

**Files:**
- No code changes — validation only.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Restart the nanoclaw service**

Run: `systemctl --user restart nanoclaw`

- [ ] **Step 4: Check logs for successful proxy startup**

Run: `sleep 3 && tail -30 logs/nanoclaw.log | grep -i "credential\|proxy\|oauth"`
Expected: `Credential proxy started` with `authMode: "oauth"`.

- [ ] **Step 5: Send a test message in Slack to verify the agent responds**

Manually trigger a message in one of the Slack channels and verify the agent responds without 401 errors.
