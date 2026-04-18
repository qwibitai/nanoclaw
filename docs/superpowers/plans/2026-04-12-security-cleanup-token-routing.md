# Security Cleanup & Token Routing Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix HIGH-severity OAuth token exposure in `ps` output, remove dead `model`/`maxThinkingTokens` fields, add daily reset for token cost stats, and verify iMessage e2e.

**Architecture:** Five independent fixes. Task 1 (security) replaces `-e` flag token injection with `--env-file` tmpfile so tokens don't appear in process listings. Task 2 removes dead type fields. Task 3 adds a daily cost reset so token routing stays meaningful. Task 4 is iMessage e2e verification (no code). Task 5 is SuperPilot MCP auth investigation (no code, research only).

**Tech Stack:** TypeScript, Node.js, Vitest, Docker/container runtime

---

## File Map

| File | Changes |
|------|---------|
| `src/container-runner.ts` | Tasks 1, 3 — env-file secrets, daily cost reset |
| `src/container-runner.test.ts` | Tasks 1, 3 — test env-file generation, test daily reset |
| `src/types.ts` | Task 2 — remove `model`, `maxThinkingTokens` |

---

### Task 1: Fix OAuth Token Exposure in `ps` Output (HIGH Severity)

**Problem:** `buildContainerArgs()` passes secrets via `-e KEY=VALUE` flags on the `docker run` command line. Any user on the Mac can see these via `ps aux`. Affected secrets: `DISCORD_BOT_TOKEN`, `NANOCLAW_SERVICE_TOKEN`, `GH_TOKEN`, `NOTION_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`.

**Fix:** Write all `-e` env vars to a temporary file, pass `--env-file /path/to/tmpfile` instead. Delete the file after container starts.

**Files:**
- Modify: `src/container-runner.ts:501-605` (`buildContainerArgs`)
- Modify: `src/container-runner.ts:640-705` (`spawnContainerWithRetry` — cleanup tmpfile)
- Test: `src/container-runner.test.ts`

- [ ] **Step 1: Write the failing test — env vars must not appear as `-e` args**

Add to `src/container-runner.test.ts`:

```typescript
describe('buildContainerArgs security', () => {
  it('should not pass secrets via -e flags (visible in ps)', async () => {
    // This test inspects the generated args array to ensure no -e flags
    // contain secret values. Secrets should go through --env-file instead.
    const { buildContainerArgs } = await import('./container-runner.js');

    const mounts: any[] = [];
    const { args } = await buildContainerArgs(mounts, 'test-container', true);

    // Collect all -e flag values
    const envFlags: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-e' && i + 1 < args.length) {
        envFlags.push(args[i + 1]);
      }
    }

    // These secret keys must NEVER appear as -e flags
    const secretKeys = [
      'DISCORD_BOT_TOKEN',
      'NANOCLAW_SERVICE_TOKEN',
      'GH_TOKEN',
      'NOTION_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ];
    for (const key of secretKeys) {
      const leaked = envFlags.some((f) => f.startsWith(`${key}=`));
      expect(leaked, `${key} must not be passed via -e flag`).toBe(false);
    }

    // Must have an --env-file flag instead
    const hasEnvFile = args.some((a) => a === '--env-file');
    // Note: --env-file is only present if there are secrets to pass.
    // In test environment with mocked env, it may or may not be present.
    // The critical assertion is that no secrets appear in -e flags.
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/container-runner.test.ts -t "should not pass secrets via -e flags"
```

Expected: FAIL — current code puts secrets in `-e` flags.

- [ ] **Step 3: Implement `--env-file` approach in `buildContainerArgs`**

In `src/container-runner.ts`, modify `buildContainerArgs` (starting around line 501):

1. Add `import { tmpdir } from 'os'` and `import { randomUUID } from 'crypto'` at the top (os is already imported, just add randomUUID).

2. Replace the direct `-e` pushes for secrets with a tmpfile approach:

```typescript
async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  isMain: boolean,
  agentIdentifier?: string,
): Promise<{ args: string[]; oauthToken: string | null; envFilePath: string | null }> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Collect secret env vars in a tmpfile instead of -e flags.
  // -e flags are visible in `ps aux` to any local user — a HIGH severity leak.
  const secretEnv: string[] = [];

  // Non-secret env vars can still use -e (they're not sensitive)
  args.push('-e', `TZ=${TIMEZONE}`);

  // Collect secrets into the env array instead of args
  const containerEnv = readEnvFile([
    'DISCORD_BOT_TOKEN',
    'NANOCLAW_SERVICE_TOKEN',
    'GH_TOKEN',
    'NOTION_TOKEN',
  ]);

  // Superpilot URLs are not secrets — keep as -e
  args.push('-e', `SUPERPILOT_MCP_URL=${SUPERPILOT_MCP_URL}`);
  args.push('-e', `SUPERPILOT_API_URL=${SUPERPILOT_API_URL}`);

  const discordToken = process.env.DISCORD_BOT_TOKEN || containerEnv.DISCORD_BOT_TOKEN;
  if (discordToken) secretEnv.push(`DISCORD_BOT_TOKEN=${discordToken}`);

  const serviceToken = process.env.NANOCLAW_SERVICE_TOKEN || containerEnv.NANOCLAW_SERVICE_TOKEN;
  if (serviceToken) secretEnv.push(`NANOCLAW_SERVICE_TOKEN=${serviceToken}`);

  const ghToken = process.env.GH_TOKEN || containerEnv.GH_TOKEN;
  if (ghToken) secretEnv.push(`GH_TOKEN=${ghToken}`);

  const notionToken = process.env.NOTION_TOKEN || containerEnv.NOTION_TOKEN;
  if (notionToken) secretEnv.push(`NOTION_TOKEN=${notionToken}`);

  // OneCLI gateway
  const onecliApplied = await onecli.applyContainerConfig(args, {
    addHostMapping: false,
    agent: agentIdentifier,
  });

  // OAuth token
  const oauthToken = getNextOAuthToken();
  if (oauthToken) {
    secretEnv.push(`CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`);
    // Non-secret override — keep as -e
    args.push('-e', 'ANTHROPIC_BASE_URL=https://api.anthropic.com');
    const stats = getTokenStats(oauthToken);
    logger.info(
      {
        containerName,
        tokenPrefix: oauthToken.slice(0, 20) + '...',
        totalTokens: oauthTokenCache.tokens.length,
        tokenCostSoFar: `$${stats.costUsd.toFixed(2)}`,
        tokenRequests: stats.requests,
      },
      'Using Max subscription OAuth token',
    );
  } else if (onecliApplied) {
    logger.info({ containerName }, 'OneCLI gateway config applied');
  } else {
    logger.warn(
      { containerName },
      'No OAuth token and OneCLI not reachable — container will have no Anthropic credentials',
    );
  }

  // Write secrets to a tmpfile and pass --env-file
  let envFilePath: string | null = null;
  if (secretEnv.length > 0) {
    envFilePath = path.join(os.tmpdir(), `nanoclaw-env-${containerName}-${Date.now()}`);
    fs.writeFileSync(envFilePath, secretEnv.join('\n') + '\n', { mode: 0o600 });
    args.push('--env-file', envFilePath);
  }

  // ... rest of function unchanged (hostGatewayArgs, user, mounts, image) ...

  return { args, oauthToken, envFilePath };
}
```

3. Update `spawnContainerWithRetry` to accept and clean up `envFilePath`:

```typescript
// After container spawn completes (in the close handler or after spawnContainer returns):
if (envFilePath) {
  try { fs.unlinkSync(envFilePath); } catch { /* ignore */ }
}
```

4. Update the return type and all callers — `spawnContainerWithRetry` destructures `{ args, oauthToken }`, add `envFilePath`. Same for the retry path.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/container-runner.test.ts -t "should not pass secrets via -e flags"
```

Expected: PASS

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 6: Manual verification — secrets not in ps**

Start a container agent (e.g., send a test message), then immediately run:

```bash
ps aux | grep -i "docker\|nanoclaw" | grep -E "DISCORD_BOT_TOKEN|GH_TOKEN|OAUTH_TOKEN|SERVICE_TOKEN|NOTION_TOKEN"
```

Expected: No matches. Previously this would show the full token values.

- [ ] **Step 7: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "security: pass container secrets via --env-file, not -e flags

-e flags are visible to any local user via ps aux. Secrets (OAuth tokens,
Discord token, GH token, service token) now written to a mode-0600 tmpfile
and passed via --env-file. File is deleted after container starts."
```

---

### Task 2: Remove Dead `model` / `maxThinkingTokens` Fields

**Problem:** `RegisteredGroup.model` and `RegisteredGroup.maxThinkingTokens` are defined in `types.ts` but never read anywhere in the codebase. They create false expectations — users may set them thinking they work.

**Files:**
- Modify: `src/types.ts:44-45`
- Test: `src/container-runner.test.ts` (verify no references)

- [ ] **Step 1: Verify no code references exist**

```bash
grep -rn "\.model\b" src/ --include="*.ts" | grep -v "test\." | grep -v "node_modules" | grep -v "types.ts"
grep -rn "maxThinkingTokens" src/ --include="*.ts" | grep -v "types.ts"
```

Expected: No matches (confirming dead code).

- [ ] **Step 2: Remove the fields from RegisteredGroup**

In `src/types.ts`, remove lines 44-45:

```typescript
// REMOVE these two lines:
  model?: 'sonnet' | 'opus' | 'haiku'; // Override default model for this group
  maxThinkingTokens?: number; // Override thinking budget (default: 16384)
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: All tests pass (no code references these fields).

- [ ] **Step 4: Build to verify no compile errors**

```bash
npm run build
```

Expected: Clean build with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts
git commit -m "remove: dead model/maxThinkingTokens fields from RegisteredGroup

These were defined but never wired into container spawning. Removing to
avoid false expectations — users setting them got no effect."
```

---

### Task 3: Add Daily Reset for Token Cost Stats

**Problem:** `oauthTokenStats` accumulates `costUsd` indefinitely. After days of usage, all tokens converge to similar cost totals, making cost-based routing effectively random. The `costUsd` comment says "Accumulated cost this period" but there is no period — it's forever.

**Fix:** Add a `periodStart` timestamp. When the current time exceeds `periodStart + 24h`, reset all token costs to zero.

**Files:**
- Modify: `src/container-runner.ts:354-460`
- Test: `src/container-runner.test.ts`

- [ ] **Step 1: Write the failing test — costs reset after 24h**

Add to `src/container-runner.test.ts`:

```typescript
describe('token cost daily reset', () => {
  it('should reset token costs after 24 hours', async () => {
    const { reportTokenUsage, getNextOAuthToken, _testResetTokenState } =
      await import('./container-runner.js');

    // Reset internal state for clean test
    _testResetTokenState();

    // Simulate: inject two known tokens via the cache
    const { _testSetOAuthTokens } = await import('./container-runner.js');
    _testSetOAuthTokens(['token-a', 'token-b']);

    // Accumulate cost on token-a
    reportTokenUsage('token-a', 25.0);
    reportTokenUsage('token-b', 5.0);

    // token-b should be preferred (lower cost)
    let next = getNextOAuthToken();
    expect(next).toBe('token-b');

    // Advance time past 24h
    const { _testAdvancePeriod } = await import('./container-runner.js');
    _testAdvancePeriod();

    // After reset, costs are zero — either token could be picked (lowest cost wins,
    // both are 0, so first in array)
    next = getNextOAuthToken();
    // After reset both are 0, token-a is first in array
    expect(next).toBe('token-a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/container-runner.test.ts -t "should reset token costs after 24 hours"
```

Expected: FAIL — no exported `_testResetTokenState` or `_testAdvancePeriod`.

- [ ] **Step 3: Implement daily reset**

In `src/container-runner.ts`:

1. Add a period tracker:

```typescript
const COST_RESET_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
let costPeriodStart = Date.now();
```

2. Add a reset check at the top of `getNextOAuthToken()`:

```typescript
function getNextOAuthToken(): string | null {
  const now = Date.now();

  // Daily cost reset — prevents routing convergence
  if (now - costPeriodStart >= COST_RESET_INTERVAL_MS) {
    for (const stats of oauthTokenStats.values()) {
      stats.costUsd = 0;
      stats.requests = 0;
    }
    costPeriodStart = now;
    logger.info('Token cost stats reset (24h period)');
  }

  // ... rest of existing function unchanged ...
```

3. Export test helpers (only used by tests):

```typescript
/** @internal — test helpers */
export function _testResetTokenState(): void {
  oauthTokenStats.clear();
  oauthTokenCache = { tokens: [], expiresAt: 0 };
  costPeriodStart = Date.now();
}

export function _testSetOAuthTokens(tokens: string[]): void {
  oauthTokenCache = { tokens, expiresAt: Date.now() + 999_999_999 };
}

export function _testAdvancePeriod(): void {
  costPeriodStart = Date.now() - COST_RESET_INTERVAL_MS - 1;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/container-runner.test.ts -t "should reset token costs after 24 hours"
```

Expected: PASS

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "fix: daily reset for OAuth token cost stats

costUsd accumulated forever, making cost-based routing converge to random.
Now resets all token costs every 24 hours so routing stays meaningful."
```

---

### Task 4: Verify iMessage End-to-End (No Code)

**Problem:** Need to confirm that sending an iMessage to NanoClaw triggers agent processing and the response comes back via iMessage.

**Files:** None — this is a manual verification task.

- [ ] **Step 1: Confirm NanoClaw is running**

```bash
launchctl list | grep nanoclaw
```

Expected: Shows the service as running (exit code 0).

- [ ] **Step 2: Check iMessage channel is connected**

```bash
tail -50 /tmp/nanoclaw.log | grep -i "imessage"
```

Expected: Shows "iMessage channel connected" or polling activity.

- [ ] **Step 3: Send a test iMessage**

From the Messages app or another device, send a message to the registered iMessage group/chat that matches the trigger pattern. For the main group (no trigger needed), send: "What time is it?"

- [ ] **Step 4: Verify agent processes and responds**

```bash
tail -f /tmp/nanoclaw.log | grep -E "imessage|container|agent"
```

Expected: Log shows message received, container spawned, and response sent back via iMessage.

- [ ] **Step 5: Confirm response arrives in Messages app**

Check the Messages app conversation — the bot's reply should appear.

- [ ] **Step 6: Document result**

If it works, mark this task complete. If it fails, note the failure mode for debugging.

---

### Task 5: SuperPilot MCP Auth Investigation (Research Only)

**Problem:** SuperPilot MCP service token works for some endpoints but returns 401 on others (e.g., auto-draft settings). May need user-level JWT instead of service token.

**Files:** None in NanoClaw — this is a SuperPilot backend investigation.

- [ ] **Step 1: Identify which endpoints fail**

Check NanoClaw logs for 401 errors from SuperPilot:

```bash
grep -i "401\|unauthorized\|superpilot" /tmp/nanoclaw.log | tail -20
```

- [ ] **Step 2: Check SuperPilot MCP server endpoint auth requirements**

Read the SuperPilot MCP server source to see which endpoints require user JWT vs service token. Look at the auth middleware for patterns like `requireUserAuth` vs `requireServiceAuth`.

- [ ] **Step 3: Document findings**

Record which endpoints need which auth type. If user JWT is required, document what's needed to generate one (OAuth flow, API key exchange, etc.).

- [ ] **Step 4: Create a follow-up task if code changes are needed**

If the fix requires NanoClaw changes (e.g., storing/refreshing a user JWT), create a separate plan for that work.

---

## Execution Order

Tasks 1-3 are independent and can be parallelized. Task 4 requires NanoClaw to be running. Task 5 is pure research.

Recommended: Execute Tasks 1, 2, 3 in parallel via subagents, then Task 4 manually, then Task 5 as research.
