# OAuth Refresh Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the silent sign-out bug where a failed OAuth token refresh leaves NanoClaw serving dead credentials indefinitely.

**Architecture:** Three changes to `ensureValidToken()` in `src/credential-proxy.ts`: (1) re-read credentials from disk before each retry attempt so external refreshes are picked up, (2) throw on unrecoverable failure instead of returning stale creds, (3) log actual expiry minutes. TDD against a local HTTP mock server.

**Tech Stack:** Node.js, Vitest, native `http`/`fs` modules.

---

### Task 1: Add test for re-reading credentials before each retry

**Files:**
- Modify: `src/credential-proxy.test.ts`

- [ ] **Step 1: Write the failing test for re-read behavior**

Add to the `ensureValidToken` describe block in `src/credential-proxy.test.ts`:

```typescript
it('re-reads credentials from disk before each retry (picks up external refresh)', async () => {
  const credsPath = path.join(tmpDir, '.credentials.json');
  // Start with an expired token and a refresh token the server will reject
  fs.writeFileSync(
    credsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-access',
        refreshToken: 'dead-refresh-token',
        expiresAt: Date.now() - 1000,
      },
    }),
  );

  // Server rejects 'dead-refresh-token' but accepts 'externally-refreshed'
  await new Promise<void>((r) => refreshServer.close(() => r()));
  refreshCallCount = 0;
  refreshServer = http.createServer((req, res) => {
    refreshCallCount++;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      const rt = body.get('refresh_token');
      if (rt === 'externally-refreshed') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'new-access-from-retry',
            refresh_token: 'new-refresh-from-retry',
            expires_in: 7200,
          }),
        );
      } else {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Refresh token not found or invalid',
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) =>
    refreshServer.listen(0, '127.0.0.1', resolve),
  );
  refreshPort = (refreshServer.address() as AddressInfo).port;

  // Simulate external process refreshing credentials after a short delay
  setTimeout(() => {
    fs.writeFileSync(
      credsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'externally-set-access',
          refreshToken: 'externally-refreshed',
          expiresAt: Date.now() - 1000, // still expired, but new refresh token
        },
      }),
    );
  }, 1500); // fires between retry 1 (immediate) and retry 2 (after 2s delay)

  const result = await ensureValidToken(
    credsPath,
    `http://127.0.0.1:${refreshPort}/v1/oauth/token`,
  );

  expect(result.accessToken).toBe('new-access-from-retry');
  expect(result.refreshToken).toBe('new-refresh-from-retry');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/credential-proxy.test.ts -t "re-reads credentials"`
Expected: FAIL — current code reads credentials once, so retry 2 still uses `dead-refresh-token` and all 3 attempts fail, returning stale creds instead of the refreshed ones.

---

### Task 2: Add test for throwing on unrecoverable failure

**Files:**
- Modify: `src/credential-proxy.test.ts`

- [ ] **Step 1: Write the failing test for throw behavior**

Add to the `ensureValidToken` describe block:

```typescript
it('throws when all retries fail and token on disk is still expired', async () => {
  const credsPath = path.join(tmpDir, '.credentials.json');
  fs.writeFileSync(
    credsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-access',
        refreshToken: 'permanently-dead',
        expiresAt: Date.now() - 1000,
      },
    }),
  );

  // Server always rejects
  await new Promise<void>((r) => refreshServer.close(() => r()));
  refreshServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Refresh token not found or invalid',
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    refreshServer.listen(0, '127.0.0.1', resolve),
  );
  refreshPort = (refreshServer.address() as AddressInfo).port;

  await expect(
    ensureValidToken(
      credsPath,
      `http://127.0.0.1:${refreshPort}/v1/oauth/token`,
    ),
  ).rejects.toThrow(/OAuth refresh failed/);
});
```

- [ ] **Step 2: Add test that returns creds when external refresh makes token valid between retries**

```typescript
it('returns valid token from disk without refreshing if externally refreshed during retries', async () => {
  const credsPath = path.join(tmpDir, '.credentials.json');
  fs.writeFileSync(
    credsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-access',
        refreshToken: 'dead-refresh',
        expiresAt: Date.now() - 1000,
      },
    }),
  );

  // Server always rejects
  await new Promise<void>((r) => refreshServer.close(() => r()));
  refreshCallCount = 0;
  refreshServer = http.createServer((req, res) => {
    refreshCallCount++;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
    });
  });
  await new Promise<void>((resolve) =>
    refreshServer.listen(0, '127.0.0.1', resolve),
  );
  refreshPort = (refreshServer.address() as AddressInfo).port;

  // Simulate external login writing a fully valid token after first retry
  setTimeout(() => {
    fs.writeFileSync(
      credsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fresh-from-login',
          refreshToken: 'fresh-refresh',
          expiresAt: Date.now() + 3600000, // 1 hour, well outside buffer
        },
      }),
    );
  }, 1500);

  const result = await ensureValidToken(
    credsPath,
    `http://127.0.0.1:${refreshPort}/v1/oauth/token`,
  );

  // Should pick up the valid token from disk without needing a successful refresh
  expect(result.accessToken).toBe('fresh-from-login');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/credential-proxy.test.ts -t "throws when all retries|returns valid token from disk"`
Expected: FAIL — current code returns stale creds on failure (doesn't throw), and doesn't re-read from disk (doesn't detect external login).

---

### Task 3: Implement the fix in ensureValidToken

**Files:**
- Modify: `src/credential-proxy.ts:127-190`

- [ ] **Step 1: Replace `ensureValidToken()` with the resilient version**

Replace lines 127-190 in `src/credential-proxy.ts` with:

```typescript
export async function ensureValidToken(
  credentialsPath: string,
  tokenUrl = REFRESH_URL,
  maxRetries = 3,
): Promise<OAuthCredentials> {
  const creds = readCredentials(credentialsPath);

  // Token still valid (outside 5-minute buffer)
  const minutesRemaining = Math.round(
    (creds.expiresAt - Date.now()) / 60000,
  );
  if (creds.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    logger.info(
      { minutesRemaining },
      'OAuth token valid',
    );
    return creds;
  }

  // If another call is already refreshing, wait for it
  if (refreshInProgress) {
    return refreshInProgress;
  }

  logger.info(
    { minutesRemaining },
    'OAuth token expiring soon, refreshing...',
  );

  refreshInProgress = (async () => {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Re-read credentials from disk before each attempt — an external
      // process (e.g. `claude` CLI login) may have refreshed the token.
      const freshCreds = readCredentials(credentialsPath);
      if (freshCreds.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
        logger.info('OAuth token refreshed externally, using disk credentials');
        return freshCreds;
      }

      try {
        const refreshed = await refreshOAuthToken(
          freshCreds.refreshToken,
          tokenUrl,
        );

        // Write back to credentials file, preserving other fields
        const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
        raw.claudeAiOauth = {
          ...raw.claudeAiOauth,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
        };
        fs.writeFileSync(credentialsPath, JSON.stringify(raw, null, 2), {
          mode: 0o600,
        });

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

    // Final check: maybe an external process refreshed while we were retrying
    const finalCreds = readCredentials(credentialsPath);
    if (finalCreds.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
      logger.info('OAuth token refreshed externally after retries exhausted');
      return finalCreds;
    }

    throw new Error(
      `OAuth refresh failed after ${maxRetries} attempts: ${lastError?.message}`,
    );
  })();

  try {
    return await refreshInProgress;
  } finally {
    refreshInProgress = null;
  }
}
```

- [ ] **Step 2: Run all ensureValidToken tests**

Run: `npx vitest run src/credential-proxy.test.ts -t "ensureValidToken"`
Expected: All tests PASS (both existing and new).

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run src/credential-proxy.test.ts`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/credential-proxy.ts src/credential-proxy.test.ts
git commit -m "fix: re-read credentials on each retry and throw on unrecoverable refresh failure

Fixes silent sign-out caused by single-use refresh token being burned
but write-back failing. ensureValidToken now re-reads credentials from
disk before each retry (picks up external refreshes) and throws instead
of returning stale credentials when all retries are exhausted."
```

---

### Task 4: Update periodic refresh log message

**Files:**
- Modify: `src/credential-proxy.ts:224-231`

The `startCredentialProxy` periodic refresh interval currently logs "Periodic OAuth token refresh check" (seen in the logs). The `ensureValidToken` function now logs the actual minutes remaining, so verify that the periodic timer's log messages are consistent.

- [ ] **Step 1: Check and update the periodic refresh log**

Look at the periodic refresh interval in `startCredentialProxy()` (~line 224-231). If it has its own "check" log message separate from `ensureValidToken`'s logging, remove the redundant log since `ensureValidToken` now logs `minutesRemaining` on every call.

If the only logging is inside `ensureValidToken` (called by the interval), no change needed — just verify by reading the code.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run src/credential-proxy.test.ts`
Expected: All tests PASS.

- [ ] **Step 3: Commit (if changes were made)**

```bash
git add src/credential-proxy.ts
git commit -m "fix: remove redundant periodic refresh log, ensureValidToken now logs expiry minutes"
```

---

### Task 5: Build and verify

**Files:**
- None (verification only)

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.
