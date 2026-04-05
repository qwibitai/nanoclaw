# API Key Migration + OAuth Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Claude Max subscription OAuth passthrough with Anthropic API key injection, removing all OAuth code.

**Architecture:** The credential proxy stays as an HTTP reverse proxy that injects `x-api-key` on every request. All OAuth machinery (token refresh, credential staging, auth failure callbacks) is removed. Containers continue routing through the proxy so they never see the real key.

**Tech Stack:** Node.js, TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-04-05-mcp-migration-design.md` (PR 1 section)

---

### Task 1: Create branch and update config files

**Files:**
- Modify: `.env` (remove dead lines, add `ANTHROPIC_API_KEY`)
- Modify: `.env.example` (add `ANTHROPIC_API_KEY` placeholder)

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b feat/api-key-migration
```

- [ ] **Step 2: Update `.env`**

Remove the dead `CLAUDE_AUTH_DIR` and `CLAUDE_CONFIG` lines (not referenced anywhere in code). Add `ANTHROPIC_API_KEY` placeholder:

```
# Replace:
# Claude auth paths (mounted into containers for Max subscription)
CLAUDE_AUTH_DIR=/home/martin/.claude
CLAUDE_CONFIG=/home/martin/.claude.json

# With:
# Anthropic API key (injected into containers via credential proxy)
ANTHROPIC_API_KEY=
```

Note: The actual key value will be set manually by the operator after merge.

- [ ] **Step 3: Update `.env.example`**

Add after the existing content:

```
# Anthropic API key (injected into containers via credential proxy)
ANTHROPIC_API_KEY=
```

- [ ] **Step 4: Commit**

```bash
git add .env .env.example
git commit -m "config: swap OAuth config for ANTHROPIC_API_KEY in .env"
```

---

### Task 2: Strip OAuth from credential-proxy.ts

**Files:**
- Modify: `src/credential-proxy.ts`

The file currently has two auth modes. Remove everything OAuth-related, keeping only the API key proxy. The resulting file should be ~80 lines.

- [ ] **Step 1: Rewrite credential-proxy.ts**

Remove all OAuth types, functions, and the OAuth branch from `startCredentialProxy`. The file should contain only:

```typescript
/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects the real API key so containers never see it.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export async function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);

  if (!secrets.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY not set in .env — cannot start credential proxy',
    );
  }

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

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

        // Inject real API key
        delete headers['x-api-key'];
        headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;

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

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
```

- [ ] **Step 2: Verify the build compiles**

```bash
npx tsc --noEmit
```

Expected: Errors in files that import removed exports (`container-runner.ts`, `index.ts`, `credential-proxy.test.ts`). That's expected — we'll fix those in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add src/credential-proxy.ts
git commit -m "refactor: remove OAuth machinery from credential proxy

Keep only the API key injection path. Removes ~400 lines of OAuth token
refresh, credential staging, and auth failure recovery."
```

---

### Task 3: Update credential-proxy tests

**Files:**
- Modify: `src/credential-proxy.test.ts`

Remove all OAuth test suites (`readCredentials`, `refreshOAuthToken`, `ensureValidToken`, `proactiveRefresh`) and the OAuth proxy test. Keep the API key proxy tests, hop-by-hop test, and 502 test. Add a test for the missing API key error.

- [ ] **Step 1: Rewrite credential-proxy.test.ts**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startCredentialProxy } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

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
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0, '127.0.0.1');
    return (proxyServer.address() as AddressInfo).port;
  }

  it('injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    Object.assign(mockEnv, {});
    await expect(startCredentialProxy(0, '127.0.0.1')).rejects.toThrow(
      /ANTHROPIC_API_KEY not set/,
    );
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/credential-proxy.test.ts
```

Expected: All 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/credential-proxy.test.ts
git commit -m "test: update credential-proxy tests for API-key-only mode"
```

---

### Task 4: Update container-runner.ts — remove OAuth paths

**Files:**
- Modify: `src/container-runner.ts`

Remove OAuth credential staging, remove `detectAuthMode()` branching, always inject proxy URL + placeholder key.

- [ ] **Step 1: Update imports**

Replace line 29:

```typescript
// Old:
import { copyFreshCredentials, detectAuthMode } from './credential-proxy.js';

// New:
// credential-proxy import removed — no longer needed in container-runner
```

Remove the import entirely. The container runner no longer calls any credential-proxy functions.

- [ ] **Step 2: Remove OAuth credential staging mount from `buildVolumeMounts`**

Remove lines 208-223 (the `data/credentials/<group>/.credentials.json` mount block):

```typescript
// Remove this entire block:
  // OAuth credentials are staged in data/credentials/<group>/ by the host process
  // (with token refresh if needed) then bind-mounted read-only into the container.
  // This overlays the session dir mount above, giving the container a fresh token.
  const credStagingPath = path.join(
    DATA_DIR,
    'credentials',
    group.folder,
    '.credentials.json',
  );
  if (fs.existsSync(credStagingPath)) {
    mounts.push({
      hostPath: credStagingPath,
      containerPath: '/home/node/.claude/.credentials.json',
      readonly: true,
    });
  }
```

- [ ] **Step 3: Remove `detectAuthMode()` branch from `buildContainerArgs`**

Replace lines 367-377:

```typescript
// Old:
  // Auth injection depends on mode:
  // API key mode: route through credential proxy which injects the real key.
  // OAuth mode:   mount credentials file directly; SDK handles auth natively.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push(
      '-e',
      `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
    );
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  }

// New:
  // Route all API calls through the credential proxy which injects the real key.
  // Containers get a placeholder key — the proxy replaces it with the real one.
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );
  args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
```

- [ ] **Step 4: Remove pre-run credential staging from `runContainerAgent`**

Remove lines 416-432:

```typescript
// Remove this entire block:
  // Stage fresh OAuth credentials before building mounts (so the file exists for the mount check)
  const stagedCredPath = path.join(
    DATA_DIR,
    'credentials',
    group.folder,
    '.credentials.json',
  );
  if (detectAuthMode() === 'oauth') {
    try {
      await copyFreshCredentials(stagedCredPath);
    } catch (err) {
      logger.error(
        { err, group: group.name },
        'Failed to stage OAuth credentials — container will have no credentials mount',
      );
    }
  }
```

- [ ] **Step 5: Clean up unused imports**

`DATA_DIR` is still used? Check: it's imported from config but after removing the credential staging block, check if it's still referenced elsewhere in the file. It is NOT used elsewhere in container-runner.ts (mounts use `GROUPS_DIR`, `SHARED_FILES_DIR`, etc.). Remove `DATA_DIR` from the config import.

Wait — `DATA_DIR` IS used on line 125 (`path.join(DATA_DIR, 'sessions', ...)`), line 293 (`path.join(DATA_DIR, 'sessions', ...)`), and line 313. Keep it.

The `copyFreshCredentials` and `detectAuthMode` imports are the only things to remove.

- [ ] **Step 6: Verify build**

```bash
npx tsc --noEmit
```

Expected: Only `src/index.ts` should have errors (onAuthFailure callback). That's fixed in the next task.

- [ ] **Step 7: Commit**

```bash
git add src/container-runner.ts
git commit -m "refactor: remove OAuth credential staging from container runner

Always route through credential proxy with placeholder API key.
No more detectAuthMode() branching or credential file mounting."
```

---

### Task 5: Update container-runner tests

**Files:**
- Modify: `src/container-runner.test.ts`

The mock for `credential-proxy.js` exports `detectAuthMode` which no longer exists. Remove it.

- [ ] **Step 1: Remove credential-proxy mock**

Remove lines 64-67:

```typescript
// Remove:
// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/container-runner.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/container-runner.test.ts
git commit -m "test: remove credential-proxy mock from container-runner tests"
```

---

### Task 6: Update index.ts — simplify proxy startup

**Files:**
- Modify: `src/index.ts`

The `startCredentialProxy` call passes `credsPath` and `onAuthFailure` callback. The new signature only takes `port` and `host`.

- [ ] **Step 1: Simplify the startCredentialProxy call**

Replace lines 534-548:

```typescript
// Old:
  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
    undefined, // credentialsPath — use default
    (message) => {
      // Notify the main group (or first registered group) about auth failure
      const jid =
        Object.entries(registeredGroups).find(([, g]) => g.isMain)?.[0] ??
        Object.keys(registeredGroups)[0];
      if (!jid) return;
      const channel = findChannel(channels, jid);
      if (channel) channel.sendMessage(jid, message).catch(() => {});
    },
  );

// New:
  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );
```

- [ ] **Step 2: Verify full build**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "refactor: simplify credential proxy startup in index.ts

Remove OAuth credentials path and auth failure callback — no longer
needed with API-key-only auth."
```

---

### Task 7: Final verification and cleanup

- [ ] **Step 1: Search for any remaining OAuth references**

```bash
grep -rn "oauth\|OAuth\|copyFreshCredentials\|detectAuthMode\|refreshOAuth\|ensureValidToken\|proactiveRefresh\|credentialsPath\|AuthMode\|OAuthRefreshError\|CLAUDE_AUTH_DIR\|CLAUDE_CONFIG" src/ --include="*.ts"
```

Expected: No matches in `src/`. (There may be matches in docs/specs/plans which is fine.)

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: Clean build with no errors.

- [ ] **Step 4: Verify credential proxy requires API key**

The proxy now throws if `ANTHROPIC_API_KEY` is not set. This is the correct behavior — NanoClaw should fail fast rather than silently falling back to a broken OAuth path.
