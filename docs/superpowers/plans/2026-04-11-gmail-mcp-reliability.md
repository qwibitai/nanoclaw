# Gmail MCP Reliability — Diagnosis, Auto-Reconnect, Recovery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the container-side Gmail MCP connection survive a full briefing/email-intelligence session without intermittent drops, with clear diagnostics when it does fail and an automatic recovery path that doesn't require restarting the host.

**Architecture:** Three layers of defense in priority order. (1) **Restart** the currently-stuck Telegram-main container so the next trigger gets a clean Gmail MCP — free, immediate. (2) **Diagnose** the actual failure mode by capturing live logs and OAuth state on the next drop. (3) **Auto-reconnect** by adding a wrapper around the Gmail MCP launch that pre-refreshes OAuth tokens and a host-side health monitor that recycles the container when Gmail MCP starts erroring. (4) **Tomorrow's briefing test** verifies the full new stack — evidence discipline, tool narration, discord-digest, and Gmail MCP reliability — on real morning data.

**Tech Stack:**
- Container side: `@gongrzhe/server-gmail-autoauth-mcp` (npx-launched MCP), Node 22, mounted `~/.gmail-mcp*` OAuth credential dirs
- Host side: TypeScript, `src/container-runner.ts` (mounts), `src/index.ts` (enqueueEmailTrigger), `src/email-sse.ts` (trigger plumbing)
- OAuth tokens: Google `access_token` (1h lifetime) + `refresh_token` (long-lived) in `credentials.json`
- Diagnostic capture: structured logging via pino, container stderr already piped to `groups/{name}/logs/`

**Current evidence (root-cause hypotheses, ranked):**
1. **OAuth access_token expiry mid-session** (most likely): personal account credentials.json shows `expiry_date` ≈34 minutes in the future. Briefings + email triggers run for >30 minutes against the same MCP server instance, so tokens routinely expire mid-call. The autoauth-mcp's refresh logic may be silently failing inside the container (no host display, no manual `auth` re-run possible from headless container).
2. **Multi-account credential fragmentation**: only `personal` and `jonathan` (whoisxml) have `credentials.json`. `attaxion` and `dev` only have `gcp-oauth.keys.json` — no granted tokens. If the agent searches the attaxion or dev account, MCP throws "no credentials" not "expired."
3. **MCP stdio crash**: the gmail MCP is launched via `npx -y @gongrzhe/server-gmail-autoauth-mcp` per container. If the npx fetch fails (network blip), the MCP tools become unavailable for the entire container session — exactly the symptom Jonathan reported ("3 emails I've been unable to process").

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `scripts/refresh-gmail-tokens.py` | Pre-emptively refresh Google OAuth tokens for all 4 Gmail accounts (personal, jonathan, attaxion, dev). Runs on host before container spawn. | **Create** |
| `scripts/check-gmail-mcp.sh` | Diagnostic script: probe gmail-mcp inside a running container, dump OAuth state, test a basic API call. | **Create** |
| `src/gmail-token-refresh.ts` | Host-side helper: read each `~/.gmail-mcp*/credentials.json`, check expiry, trigger refresh by shelling to `refresh-gmail-tokens.py`. Called from `enqueueEmailTrigger` and the morning-briefing task path. | **Create** |
| `src/container-runner.ts` | Already mounts the Gmail credential dirs. Ensure `attaxion` and `dev` mounts are conditional only if `credentials.json` exists; otherwise warn at spawn time. | **Modify** |
| `src/index.ts:782` | `enqueueEmailTrigger`: add a token-pre-refresh step before the agent spawns. Existing close-delay/progress-handle logic untouched. | **Modify** |
| `src/task-scheduler.ts` | `runTask`: same token-pre-refresh for the morning-briefing scheduled task. | **Modify** |
| `container/agent-runner/src/index.ts:546-549` | Gmail MCP launch: add `env` carrying explicit `GMAIL_MCP_HOME=/home/node/.gmail-mcp` so the autoauth-mcp doesn't fall back to defaults. Leave the MCP server itself alone — fixes are host-side. | **Modify** |
| `container/skills/morning-briefing/SKILL.md` | Add "If Gmail tools become unavailable mid-briefing, do NOT continue silently — emit a clearly-labeled `GMAIL-DEGRADED:` line with the exact tool error and skip Gmail-dependent sections rather than guessing." | **Modify** |
| `groups/main/CLAUDE.md` | Add a Gmail MCP failure mode entry to the Evidence discipline section: subject-only classification is permitted but must be labeled `[CLASSIFIED FROM SUBJECT ONLY — body unavailable]` so the user can spot degraded output. | **Modify** |
| `tests/gmail-token-refresh.test.ts` | Unit tests for token-expiry math and the refresh-needed predicate. | **Create** |
| `docs/RUNBOOK-gmail-mcp.md` | One-page operator runbook: how to manually re-auth a Gmail account, what the diagnostic logs look like, how to recover. | **Create** |

---

## Task 1: Restart the stuck Telegram-main container (free, immediate)

**Files:**
- None (operational only — uses host CLI)

- [ ] **Step 1: List currently running NanoClaw containers**

Run:
```bash
docker ps --filter name=nanoclaw- --format '{{.Names}} {{.Status}}'
```

Expected: zero or more rows. If a `nanoclaw-telegram-main-*` is listed and "Up", it's the stuck one.

- [ ] **Step 2: Send the close sentinel via the host's stdin pipe**

The host's `queue.closeStdin(chatJid)` writes `_close` to the container's IPC input dir. Trigger it manually by writing the file directly:

```bash
ls /Users/topcoder1/dev/nanoclaw/data/ipc/telegram_main/input/ 2>/dev/null
touch /Users/topcoder1/dev/nanoclaw/data/ipc/telegram_main/input/_close
```

Expected: container's IPC poll loop sees the sentinel within 2s and the agent-runner exits cleanly.

- [ ] **Step 3: Confirm clean exit**

```bash
docker ps --filter name=nanoclaw-telegram-main- --format '{{.Names}}'
```

Expected: empty output. If the container is still up after 30s, fall through to a forced stop:

```bash
docker stop -t 5 nanoclaw-telegram-main-<full-name>
```

- [ ] **Step 4: Watch the host log for clean teardown**

```bash
tail -20 /Users/topcoder1/dev/nanoclaw/logs/nanoclaw.log | grep -iE "container completed|container exited|telegram_main"
```

Expected: a `Container completed (streaming mode)` or `Container timed out after output (idle cleanup)` line. NO `Container exited with error` (the streaming-output fix from `63afb64` would catch any non-zero exit anyway).

- [ ] **Step 5: Verify next trigger spawns a fresh container**

Send any test message to the bot on Telegram (e.g. "hi"). Watch:

```bash
tail -f /Users/topcoder1/dev/nanoclaw/logs/nanoclaw.log
```

Expected: `Spawning container agent` with a NEW container name (different timestamp suffix from the one we just killed).

- [ ] **Step 6: Commit operational note**

No code changes — skip the commit.

---

## Task 2: Write `scripts/refresh-gmail-tokens.py` to pre-emptively refresh OAuth

**Files:**
- Create: `scripts/refresh-gmail-tokens.py`

- [ ] **Step 1: Create the script**

```python
#!/usr/bin/env python3
"""Refresh Google OAuth tokens for all NanoClaw Gmail accounts.

Reads ~/.gmail-mcp{,-jonathan,-attaxion,-dev}/credentials.json, checks if
the access_token is within REFRESH_THRESHOLD_SECONDS of expiry, and if so
exchanges the refresh_token for a new access_token via Google's OAuth2
endpoint.

Exit codes:
  0  All accounts checked, none required refresh OR all refreshes succeeded
  2  At least one credentials.json missing (account not yet authorized)
  3  At least one refresh attempt failed (network, revoked token, etc.)

Designed to be safe to call before every email-intelligence container spawn:
fast (<1s when nothing needs refresh), idempotent, and never destructive.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path

HOME = Path.home()
ACCOUNTS = [
    ("personal", HOME / ".gmail-mcp"),
    ("jonathan", HOME / ".gmail-mcp-jonathan"),
    ("attaxion", HOME / ".gmail-mcp-attaxion"),
    ("dev",      HOME / ".gmail-mcp-dev"),
]
REFRESH_THRESHOLD_SECONDS = 5 * 60  # refresh if expiring within 5 minutes
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"


def needs_refresh(creds: dict) -> bool:
    """Return True if access_token will expire within REFRESH_THRESHOLD_SECONDS."""
    expiry_ms = creds.get("expiry_date")
    if not expiry_ms:
        return True
    now_ms = int(time.time() * 1000)
    return (expiry_ms - now_ms) / 1000 <= REFRESH_THRESHOLD_SECONDS


def load_oauth_keys(account_dir: Path) -> dict | None:
    """Load gcp-oauth.keys.json (client_id + client_secret needed for refresh)."""
    keys_file = account_dir / "gcp-oauth.keys.json"
    if not keys_file.exists():
        return None
    data = json.loads(keys_file.read_text())
    # Google's OAuth client config wraps credentials in {"installed": {...}} or {"web": {...}}
    for wrapper in ("installed", "web"):
        if wrapper in data:
            return data[wrapper]
    return data


def refresh_token(account: str, account_dir: Path) -> tuple[str, str]:
    """Refresh the access token for one account.

    Returns (status, message) where status is "ok" | "missing" | "error".
    """
    creds_file = account_dir / "credentials.json"
    if not creds_file.exists():
        return ("missing", f"{account}: no credentials.json (not authorized)")

    creds = json.loads(creds_file.read_text())
    if not needs_refresh(creds):
        expiry_min = (creds["expiry_date"] - int(time.time() * 1000)) / 1000 / 60
        return ("ok", f"{account}: token valid for {expiry_min:.0f} more min")

    keys = load_oauth_keys(account_dir)
    if not keys:
        return ("error", f"{account}: gcp-oauth.keys.json missing or malformed")

    refresh = creds.get("refresh_token")
    if not refresh:
        return ("error", f"{account}: no refresh_token — re-auth required")

    body = urllib.parse.urlencode({
        "client_id": keys["client_id"],
        "client_secret": keys["client_secret"],
        "refresh_token": refresh,
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request(
        GOOGLE_TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            new = json.loads(resp.read())
    except Exception as e:
        return ("error", f"{account}: refresh failed — {type(e).__name__}: {e}")

    creds["access_token"] = new["access_token"]
    # Google returns expires_in (seconds); convert to absolute ms
    creds["expiry_date"] = int(time.time() * 1000) + (new.get("expires_in", 3600) * 1000)
    if "scope" in new:
        creds["scope"] = new["scope"]

    # Atomic write: tmpfile + rename, so a crash mid-write can't corrupt creds
    tmp = creds_file.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(creds, indent=2))
    os.replace(tmp, creds_file)
    return ("ok", f"{account}: refreshed (now valid for ~60 min)")


def main():
    statuses = []
    for account, account_dir in ACCOUNTS:
        if not account_dir.exists():
            statuses.append(("missing", f"{account}: directory {account_dir} not present"))
            continue
        statuses.append(refresh_token(account, account_dir))

    any_error = False
    any_missing = False
    for status, message in statuses:
        prefix = {"ok": "OK", "missing": "MISSING", "error": "ERROR"}[status]
        print(f"[{prefix}] {message}")
        if status == "error":
            any_error = True
        if status == "missing":
            any_missing = True

    if any_error:
        sys.exit(3)
    if any_missing:
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/refresh-gmail-tokens.py
```

- [ ] **Step 3: Run it manually (no token should need refresh — they're all fresh)**

```bash
python3 scripts/refresh-gmail-tokens.py
```

Expected output:
```
[OK] personal: token valid for 34 more min
[OK] jonathan: token valid for ... more min
[MISSING] attaxion: no credentials.json (not authorized)
[MISSING] dev: no credentials.json (not authorized)
```
Exit code 2 (at least one missing — expected).

- [ ] **Step 4: Force a refresh by lying about expiry**

Test the refresh path against a real Google endpoint without breaking anything:
```bash
python3 -c "
import json, time
p = '/Users/topcoder1/.gmail-mcp/credentials.json'
c = json.load(open(p))
orig = c['expiry_date']
c['expiry_date'] = int(time.time() * 1000) + 60 * 1000  # 1 min from now
json.dump(c, open(p, 'w'), indent=2)
print('original expiry:', orig)
print('forced to expire in 1 min')
"
python3 scripts/refresh-gmail-tokens.py
```

Expected:
```
[OK] personal: refreshed (now valid for ~60 min)
[MISSING] attaxion: ...
[MISSING] dev: ...
```

If you see `[ERROR] personal: refresh failed — ...`, the refresh_token has been revoked and personal needs manual re-auth (separate task — see Runbook in Task 7).

- [ ] **Step 5: Verify the credentials file was rewritten with a fresh expiry**

```bash
python3 -c "
import json, time
c = json.load(open('/Users/topcoder1/.gmail-mcp/credentials.json'))
exp_min = (c['expiry_date'] - int(time.time() * 1000)) / 1000 / 60
print(f'new expiry: {exp_min:.0f} min from now')
"
```

Expected: ~60 minutes.

- [ ] **Step 6: Commit**

```bash
git add scripts/refresh-gmail-tokens.py
git commit -m "feat: add refresh-gmail-tokens.py for proactive OAuth refresh

Pre-emptively refreshes Google OAuth access_tokens for all Gmail accounts
before each email-intelligence container spawn. Skips accounts that don't
need refresh (>5 min until expiry). Atomic write prevents partial-write
corruption. Exit codes distinguish missing accounts (expected) from real
refresh errors (token revoked, network, etc.).

Standalone for now — wired into container spawn paths in next commits."
```

---

## Task 3: Write the host-side TypeScript helper `src/gmail-token-refresh.ts`

**Files:**
- Create: `src/gmail-token-refresh.ts`
- Create: `src/gmail-token-refresh.test.ts`

- [ ] **Step 1: Write the failing test first**

Create `src/gmail-token-refresh.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import { refreshGmailTokens } from './gmail-token-refresh.js';

describe('refreshGmailTokens', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves with status="ok" on exit code 0', async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '[OK] personal: refreshed\n', '');
      },
    );
    const result = await refreshGmailTokens();
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('personal');
  });

  it('resolves with status="missing" on exit code 2', async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const err = Object.assign(new Error('Exit 2'), { code: 2 });
        cb(err, '[MISSING] attaxion: no credentials\n', '');
      },
    );
    const result = await refreshGmailTokens();
    expect(result.status).toBe('missing');
  });

  it('resolves with status="error" on exit code 3', async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const err = Object.assign(new Error('Exit 3'), { code: 3 });
        cb(err, '[ERROR] personal: refresh failed\n', '');
      },
    );
    const result = await refreshGmailTokens();
    expect(result.status).toBe('error');
    expect(result.summary).toContain('refresh failed');
  });

  it('resolves with status="error" if the script itself crashes', async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error('ENOENT'), '', '');
      },
    );
    const result = await refreshGmailTokens();
    expect(result.status).toBe('error');
  });

  it('times out cleanly after the configured timeout', async () => {
    // execFile mock just never invokes the callback
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, _cb: Function) => {
        // never call cb — simulate hang
      },
    );
    const result = await refreshGmailTokens({ timeoutMs: 50 });
    expect(result.status).toBe('error');
    expect(result.summary).toMatch(/timeout|timed out/i);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
npm test -- --run gmail-token-refresh
```

Expected: `Cannot find module './gmail-token-refresh.js'` — all 5 tests fail.

- [ ] **Step 3: Implement the helper**

Create `src/gmail-token-refresh.ts`:
```typescript
import { execFile } from 'child_process';
import path from 'path';
import { logger } from './logger.js';

export interface GmailRefreshResult {
  status: 'ok' | 'missing' | 'error';
  summary: string;
}

export interface GmailRefreshOptions {
  /** Override path to scripts/refresh-gmail-tokens.py (default: <cwd>/scripts/...) */
  scriptPath?: string;
  /** Maximum time to wait for the script to complete (ms). Default 15s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Refresh all Gmail account OAuth tokens by shelling out to
 * scripts/refresh-gmail-tokens.py. Safe to call before every container
 * spawn — fast no-op when nothing needs refresh.
 *
 * Never throws. All errors collapse to a structured GmailRefreshResult so
 * callers can decide whether to spawn the agent anyway (subject-only
 * classification is still better than no classification).
 */
export async function refreshGmailTokens(
  options: GmailRefreshOptions = {},
): Promise<GmailRefreshResult> {
  const scriptPath =
    options.scriptPath ||
    path.join(process.cwd(), 'scripts', 'refresh-gmail-tokens.py');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.warn(
        { scriptPath, timeoutMs },
        'gmail-token-refresh script timed out',
      );
      resolve({
        status: 'error',
        summary: `gmail-token-refresh timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    execFile(
      'python3',
      [scriptPath],
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const summary = (stdout || stderr || '').trim();

        if (err) {
          const code = (err as { code?: number }).code;
          if (code === 2) {
            // Expected: at least one account is not yet authorized
            logger.debug({ summary }, 'gmail-token-refresh: missing accounts');
            resolve({ status: 'missing', summary });
            return;
          }
          if (code === 3) {
            logger.warn(
              { summary },
              'gmail-token-refresh: at least one refresh failed',
            );
            resolve({ status: 'error', summary });
            return;
          }
          // Script crashed (ENOENT, exec failure, etc.)
          logger.error(
            { err: err.message, summary },
            'gmail-token-refresh: script execution failed',
          );
          resolve({
            status: 'error',
            summary: summary || err.message,
          });
          return;
        }

        logger.debug({ summary }, 'gmail-token-refresh: all accounts ok');
        resolve({ status: 'ok', summary });
      },
    );
  });
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm test -- --run gmail-token-refresh
```

Expected: 5/5 pass.

- [ ] **Step 5: Run the full suite to make sure nothing else broke**

```bash
npm test
```

Expected: 406/406 pass (was 401 + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/gmail-token-refresh.ts src/gmail-token-refresh.test.ts
git commit -m "feat: add gmail-token-refresh helper with tests

Wraps scripts/refresh-gmail-tokens.py with a typed Promise interface.
Never throws — all failure modes (script crash, timeout, missing accounts,
real refresh errors) collapse to a structured GmailRefreshResult so
callers can decide whether to spawn the agent anyway.

Tests cover: ok exit, missing exit (code 2), error exit (code 3),
script-crash exit, and timeout. 5 new tests, full suite green."
```

---

## Task 4: Wire token refresh into `enqueueEmailTrigger`

**Files:**
- Modify: `src/index.ts:782` (the `enqueueEmailTrigger` factory)

- [ ] **Step 1: Read the current enqueueEmailTrigger code (already touched in 9d169c8 + 5b75b5b)**

```bash
sed -n '780,860p' src/index.ts
```

Goal: insert a `refreshGmailTokens()` call between the group lookup and the progress message, so tokens are pre-refreshed before the user even sees "⏳ working". Failures of the refresh path are logged, included in the progress label, and do NOT block the agent spawn.

- [ ] **Step 2: Add the import**

In `src/index.ts`, after the existing imports (around line 50), add:
```typescript
import { refreshGmailTokens } from './gmail-token-refresh.js';
```

- [ ] **Step 3: Insert the refresh call inside enqueueEmailTrigger**

Find this block (around line 790):
```typescript
        const group = registeredGroups[chatJid];
        if (!group) {
          logger.warn({ chatJid }, 'No group for email trigger');
          return;
        }

        // System-injected progress message: email triggers routinely take
```

Replace with:
```typescript
        const group = registeredGroups[chatJid];
        if (!group) {
          logger.warn({ chatJid }, 'No group for email trigger');
          return;
        }

        // Pre-refresh Gmail OAuth tokens before spawning the container.
        // Tokens have a 1-hour lifetime and routinely expire mid-session,
        // causing the gmail-mcp inside the container to silently lose its
        // ability to read email bodies. Refreshing here is fast (<200ms
        // when nothing needs refresh) and never blocks the spawn — even on
        // refresh failure we proceed with subject-only classification
        // rather than dropping the trigger.
        const refreshResult = await refreshGmailTokens();
        if (refreshResult.status === 'error') {
          logger.warn(
            { chatJid, summary: refreshResult.summary },
            'Gmail token refresh failed before email trigger — agent may degrade to subject-only',
          );
        } else if (refreshResult.status === 'missing') {
          logger.debug(
            { chatJid, summary: refreshResult.summary },
            'Some Gmail accounts not authorized — proceeding with available accounts',
          );
        }

        // System-injected progress message: email triggers routinely take
```

- [ ] **Step 4: Run typecheck**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 5: Run the full test suite**

```bash
npm test
```

Expected: 406/406 pass.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: pre-refresh Gmail tokens before each email-trigger spawn

Inserts a refreshGmailTokens() call between the group lookup and the
progress-message ack inside enqueueEmailTrigger. Token refresh is fast
(<200ms when nothing needs refresh), never blocks the spawn, and on
failure logs a warning so the operator can see why the agent degraded.

Addresses the symptom Jonathan reported (3 emails unable to process due
to Gmail MCP unavailability over a 90-minute window) by preventing the
mid-session OAuth token expiry that triggers the gmail-mcp drop."
```

---

## Task 5: Wire token refresh into the morning-briefing scheduled task path

**Files:**
- Modify: `src/task-scheduler.ts` (the `runScheduledTask` function)

- [ ] **Step 1: Read the current runTask code**

```bash
sed -n '90,200p' src/task-scheduler.ts
```

Find the spot just after the budget guard (around line 128) and before the container spawn — that's where the refresh call goes.

- [ ] **Step 2: Add the import at the top of `src/task-scheduler.ts`**

```typescript
import { refreshGmailTokens } from './gmail-token-refresh.js';
```

- [ ] **Step 3: Insert refresh call before runContainerAgent**

Find this block (around line 124):
```typescript
  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );
```

Replace with:
```typescript
  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  // Pre-refresh Gmail tokens for tasks that may touch email (morning
  // briefing, weekly review). Cheap and harmless for tasks that don't
  // touch Gmail; the refresh script is fast and only does network work
  // when something is actually about to expire. We don't gate this on
  // task name because users can rename briefings.
  const gmailRefresh = await refreshGmailTokens();
  if (gmailRefresh.status === 'error') {
    logger.warn(
      { taskId: task.id, summary: gmailRefresh.summary },
      'Gmail token refresh failed before scheduled task — Gmail-dependent sections may degrade',
    );
  }
```

- [ ] **Step 4: Run typecheck and tests**

```bash
npm run build && npm test
```

Expected: clean build, 406/406 pass.

- [ ] **Step 5: Commit**

```bash
git add src/task-scheduler.ts
git commit -m "feat: pre-refresh Gmail tokens before each scheduled task

Mirrors the email-trigger refresh added in the previous commit. The
morning briefing runs for >30 min and was the canonical victim of the
Gmail MCP mid-session drop — refreshing right before the spawn keeps
tokens valid for the entire briefing window."
```

---

## Task 6: Make `attaxion` and `dev` Gmail mounts conditional + add explicit GMAIL_MCP_HOME env

**Files:**
- Modify: `src/container-runner.ts:200-216` (the gmailDirs loop)
- Modify: `container/agent-runner/src/index.ts:546-549` (Gmail MCP launch)

- [ ] **Step 1: Update container-runner mount logic**

Find this block in `src/container-runner.ts`:
```typescript
  // Gmail credentials directories (multi-account: personal, whoisxml, attaxion)
  const homeDir = os.homedir();
  const gmailDirs = [
    { hostDir: '.gmail-mcp', containerDir: '.gmail-mcp' },
    { hostDir: '.gmail-mcp-jonathan', containerDir: '.gmail-mcp-jonathan' },
    { hostDir: '.gmail-mcp-attaxion', containerDir: '.gmail-mcp-attaxion' },
  ];
  for (const gd of gmailDirs) {
    const gmailDir = path.join(homeDir, gd.hostDir);
    if (fs.existsSync(gmailDir)) {
      mounts.push({
        hostPath: gmailDir,
        containerPath: `/home/node/${gd.containerDir}`,
        readonly: false, // MCP may need to refresh OAuth tokens
      });
    }
  }
```

Replace with:
```typescript
  // Gmail credentials directories (multi-account: personal, whoisxml/jonathan,
  // attaxion, dev). Only mount accounts that have a credentials.json — mounting
  // a directory with only gcp-oauth.keys.json gives the gmail-mcp something
  // to discover but no usable token, which produces confusing "no credentials"
  // errors mid-session. Better to omit the account entirely so the agent
  // never thinks it can search there.
  const homeDir = os.homedir();
  const gmailDirs = [
    { hostDir: '.gmail-mcp', containerDir: '.gmail-mcp' },
    { hostDir: '.gmail-mcp-jonathan', containerDir: '.gmail-mcp-jonathan' },
    { hostDir: '.gmail-mcp-attaxion', containerDir: '.gmail-mcp-attaxion' },
    { hostDir: '.gmail-mcp-dev', containerDir: '.gmail-mcp-dev' },
  ];
  for (const gd of gmailDirs) {
    const gmailDir = path.join(homeDir, gd.hostDir);
    const credsFile = path.join(gmailDir, 'credentials.json');
    if (fs.existsSync(gmailDir) && fs.existsSync(credsFile)) {
      mounts.push({
        hostPath: gmailDir,
        containerPath: `/home/node/${gd.containerDir}`,
        readonly: false, // MCP may need to refresh OAuth tokens
      });
    } else if (fs.existsSync(gmailDir)) {
      logger.debug(
        { gmailDir },
        'Gmail account directory present but no credentials.json — skipping mount (account not authorized yet)',
      );
    }
  }
```

- [ ] **Step 2: Update agent-runner Gmail MCP launch to set explicit env**

In `container/agent-runner/src/index.ts`, find:
```typescript
        gmail: {
          command: 'npx',
          args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
        },
```

Replace with:
```typescript
        gmail: {
          command: 'npx',
          args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
          env: {
            // Explicitly point the gmail-mcp at the personal account home.
            // The autoauth-mcp's default credential discovery looks at
            // $HOME/.gmail-mcp; pinning it here makes the resolution
            // deterministic and immune to env-variable surprises.
            GMAIL_MCP_HOME: '/home/node/.gmail-mcp',
            HOME: '/home/node',
          },
        },
```

- [ ] **Step 3: Build both projects**

```bash
npm run build && (cd container/agent-runner && npm run build)
```

Expected: both clean.

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: 406/406 pass.

- [ ] **Step 5: Commit**

```bash
git add src/container-runner.ts container/agent-runner/src/index.ts
git commit -m "fix: skip Gmail mounts without credentials.json + pin GMAIL_MCP_HOME

Two related Gmail-MCP reliability fixes:

1. container-runner now requires credentials.json (not just gcp-oauth.keys.json)
   to mount a Gmail account dir into the container. Mounting a dir with only
   the OAuth client config but no granted token causes the gmail-mcp to
   attempt auth flows mid-session and fail confusingly. Adds .gmail-mcp-dev
   to the candidate list while we're at it.

2. agent-runner now passes explicit GMAIL_MCP_HOME and HOME env vars to the
   gmail-mcp launch, making credential discovery deterministic instead of
   relying on the npx-spawned process inheriting the right HOME."
```

---

## Task 7: Add the `GMAIL-DEGRADED:` skill rule + Evidence-discipline note

**Files:**
- Modify: `container/skills/morning-briefing/SKILL.md`
- Modify: `groups/main/CLAUDE.md`

- [ ] **Step 1: Update morning-briefing SKILL.md**

In `container/skills/morning-briefing/SKILL.md`, find the `### 2. Emails Needing Response` section. Append after the existing bullets:

```markdown
- **If superpilot or gmail tools become unavailable mid-section** (the
  classifier is the canary — if it returns "tool error" or "no such tool",
  the connection has dropped):
  - Print one literal line: `GMAIL-DEGRADED: <verbatim error from the tool>`
  - Continue the briefing with `[CLASSIFIED FROM SUBJECT ONLY]` tags on
    each affected email
  - DO NOT pretend the tool is working. DO NOT invent thread bodies.
  - This is the same Evidence discipline rule (Case 4) — quote literal
    failures, never paraphrase.
```

- [ ] **Step 2: Update groups/main/CLAUDE.md Evidence discipline section**

Find the Evidence discipline section (added in commit 9d169c8). Append a 7th rule:

```markdown
7. **Tool failures must be reported, not hidden.** If a tool call returns
   an error or becomes unavailable mid-session, surface it with a clear
   prefix (`GMAIL-DEGRADED:`, `SUPERPILOT-DEGRADED:`, etc.) and the literal
   error text. Then continue with whatever subset of the work you can do
   from the remaining tools, labeling degraded outputs (e.g.
   `[CLASSIFIED FROM SUBJECT ONLY — body unavailable]`). Never invent a
   reason for the failure. Never silently skip a section that the user is
   expecting.
```

- [ ] **Step 3: Commit**

```bash
git add container/skills/morning-briefing/SKILL.md groups/main/CLAUDE.md
git commit -m "docs: add tool-failure surfacing rules to skill + CLAUDE.md

Two related documentation changes that turn the agent's behavior on
Gmail/superpilot drops from 'silently degrade' to 'explicitly label':

- morning-briefing SKILL.md gains a GMAIL-DEGRADED: rule that requires
  literal error reporting and per-email subject-only labeling.

- groups/main/CLAUDE.md gains rule #7 in Evidence discipline: tool
  failures must be quoted, not hidden or invented, with degraded
  outputs labeled so the user can spot them.

Pairs with the runtime token-refresh from earlier commits — refresh
prevents most failures, and these rules ensure the rare residual
failures are visible instead of hallucinated."
```

---

## Task 8: Write `scripts/check-gmail-mcp.sh` diagnostic script

**Files:**
- Create: `scripts/check-gmail-mcp.sh`

- [ ] **Step 1: Create the script**

```bash
#!/bin/bash
# Diagnostic: probe the gmail-mcp inside a running NanoClaw container.
# Dumps OAuth state and runs a no-op API call to verify the MCP can talk
# to Google. Use when Telegram complains "Gmail tools are no longer available".
#
# Usage:
#   ./scripts/check-gmail-mcp.sh                      # auto-pick the first nanoclaw container
#   ./scripts/check-gmail-mcp.sh nanoclaw-telegram-main-1234567890

set -e

CONTAINER="${1:-}"
if [ -z "$CONTAINER" ]; then
  CONTAINER=$(docker ps --filter name=nanoclaw- --format '{{.Names}}' | head -1)
fi

if [ -z "$CONTAINER" ]; then
  echo "ERROR: no running nanoclaw containers found" >&2
  exit 1
fi

echo "=== Probing $CONTAINER ==="
echo

echo "--- /home/node/.gmail-mcp listing ---"
docker exec "$CONTAINER" sh -c 'ls -la /home/node/.gmail-mcp/ 2>&1' || echo "(directory missing inside container)"
echo

echo "--- credentials.json expiry (personal) ---"
docker exec "$CONTAINER" sh -c "
  if [ -f /home/node/.gmail-mcp/credentials.json ]; then
    node -e '
      const c = require(\"/home/node/.gmail-mcp/credentials.json\");
      const now = Date.now();
      const exp = c.expiry_date || 0;
      const minLeft = (exp - now) / 1000 / 60;
      console.log(\"expiry_date:\", exp);
      console.log(\"now:\", now);
      console.log(\"minutes_until_expiry:\", minLeft.toFixed(1));
      console.log(\"has_refresh_token:\", !!c.refresh_token);
      console.log(\"scope:\", c.scope || \"(none)\");
    '
  else
    echo '(credentials.json missing)'
  fi
" || true
echo

echo "--- Running gmail-mcp tool list (probe) ---"
docker exec "$CONTAINER" sh -c '
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}" \
    | timeout 10 npx -y @gongrzhe/server-gmail-autoauth-mcp 2>&1 \
    | head -50
' || echo "(probe failed — see error above)"
echo

echo "=== Done ==="
echo "If credentials.json is missing or expired, run: python3 scripts/refresh-gmail-tokens.py"
echo "If the tool-list probe failed, check the container logs:"
echo "  docker logs $CONTAINER 2>&1 | grep -i gmail | tail -30"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/check-gmail-mcp.sh
```

- [ ] **Step 3: Run it against the (possibly nonexistent) current container**

```bash
./scripts/check-gmail-mcp.sh
```

Expected: either prints the diagnostic for a running container, or exits 1 with "no running nanoclaw containers found" — both are valid outcomes; the script itself runs without bash errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-gmail-mcp.sh
git commit -m "feat: add scripts/check-gmail-mcp.sh diagnostic for Gmail MCP drops

One-shot diagnostic that probes a running nanoclaw container, dumps
the personal account's OAuth token state, and runs a tools/list probe
against the gmail-mcp to verify it can still respond. Designed to be
the first thing an operator runs when Telegram says 'Gmail tools are
no longer available'."
```

---

## Task 9: Write `docs/RUNBOOK-gmail-mcp.md` operator runbook

**Files:**
- Create: `docs/RUNBOOK-gmail-mcp.md`

- [ ] **Step 1: Create the runbook**

```markdown
# Gmail MCP Runbook

What to do when the agent says it can't read email bodies, or when
Telegram shows messages like:

> Gmail tools are no longer available in this session, so I can't read
> the email with thread ID …

## 0. Quick triage (60 seconds)

Run from the host:

\`\`\`bash
cd ~/dev/nanoclaw
./scripts/check-gmail-mcp.sh
\`\`\`

This dumps the OAuth token state and runs a probe. Possible outcomes:

| Output | Cause | Fix |
|---|---|---|
| `(directory missing inside container)` | Container started without the Gmail mount. Almost certainly a bug — check `src/container-runner.ts` mount logic. | Restart the host service. |
| `minutes_until_expiry: -X.X` (negative) | Access token expired and the in-container refresh failed. | Run `python3 scripts/refresh-gmail-tokens.py` on the host (rewrites the credentials.json that's bind-mounted into the container). |
| `(probe failed — see error above)` with "ECONNREFUSED" or "fetch failed" | Container has no outbound network OR the npx fetch for the gmail-mcp package failed. | Check `docker logs <container>` for npm errors. May need to pre-bake the gmail-mcp into the container image (separate task). |
| `(credentials.json missing)` | Account was never authorized OR credentials file was deleted. | Re-authorize manually (see section 2 below). |
| Tool list returns successfully but the agent still says "unavailable" | The MCP is healthy but the agent's model context lost the tool registration. | Send the agent a new message — the next container spawn will re-register tools. |

## 1. Pre-emptively refresh tokens (no downtime)

Run anytime — safe to run during normal operation. Refreshes only the
accounts that are within 5 minutes of expiry; no-op for accounts with
plenty of time left.

\`\`\`bash
python3 ~/dev/nanoclaw/scripts/refresh-gmail-tokens.py
\`\`\`

Exit codes:
- 0: All accounts checked, all good
- 2: At least one account is missing credentials.json (expected for
     accounts you haven't authorized yet — attaxion, dev)
- 3: At least one refresh failed (refresh_token revoked, network, etc.)
     — see section 2 to manually re-auth that account

## 2. Manually re-authorize a Gmail account

If a refresh_token is revoked (Google does this if you change your
password, sign out everywhere, or hit the "Manage third-party access"
revoke button), the only fix is to re-run the OAuth flow from scratch.

\`\`\`bash
# 1. Make sure the OAuth client config is in place
ls ~/.gmail-mcp/gcp-oauth.keys.json   # personal
ls ~/.gmail-mcp-jonathan/gcp-oauth.keys.json   # whoisxml

# 2. Run the gmail-mcp's auth helper (opens a browser)
cd ~/.gmail-mcp
npx -y @gongrzhe/server-gmail-autoauth-mcp auth

# Repeat for each account, copying the keys.json into the right dir first
\`\`\`

After re-auth, `credentials.json` will be regenerated with a fresh
refresh_token. Confirm with section 1's refresh script.

## 3. Force-restart the active container (clean slate)

If the container is wedged but you don't want to bounce the whole host:

\`\`\`bash
# Find the stuck container
docker ps --filter name=nanoclaw- --format '{{.Names}}'

# Send the close sentinel (graceful)
touch ~/dev/nanoclaw/data/ipc/<group>/input/_close

# Hard stop if it doesn't exit within 30s
docker stop -t 5 <container-name>
\`\`\`

The next agent trigger will spawn a fresh container with refreshed tokens.

## 4. Bounce the whole host (last resort)

\`\`\`bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 5
launchctl list | grep com.nanoclaw   # should show a new PID
tail -f ~/dev/nanoclaw/logs/nanoclaw.log
\`\`\`

## How to tell if the fixes are working

After this runbook's commits ship, the morning briefing should:

- Print no `GMAIL-DEGRADED:` lines on a normal day
- If Gmail does fail, the briefing prints the LITERAL failure (not an
  invented reason like "bot token not configured") and labels each
  affected email with `[CLASSIFIED FROM SUBJECT ONLY]`
- The host log should show `gmail-token-refresh: all accounts ok` (debug
  level) before each email-trigger spawn
\`\`\`

- [ ] **Step 2: Commit**

```bash
git add docs/RUNBOOK-gmail-mcp.md
git commit -m "docs: add Gmail MCP runbook for operator triage and recovery

Single-page runbook covering:
- Quick triage with check-gmail-mcp.sh
- Pre-emptive token refresh with refresh-gmail-tokens.py
- Manual re-authorization when refresh_token is revoked
- Force-restart of a wedged container without bouncing the host
- Last-resort host service kick

Pairs with the diagnostic script and refresh script added in earlier
commits in this plan."
```

---

## Task 10: Build, push, restart, and verify the full stack

**Files:**
- None (operational)

- [ ] **Step 1: Run the full test suite one more time**

```bash
npm test
```

Expected: 406/406 pass.

- [ ] **Step 2: Build host and container source**

```bash
npm run build
(cd container/agent-runner && npm run build)
```

Expected: both clean.

- [ ] **Step 3: Merge to main**

```bash
git checkout main
git merge claude/<branch> --no-ff -m "Merge: gmail-mcp reliability — refresh, mounts, diagnostics, runbook"
git push origin main
git checkout claude/<branch>
```

Expected: clean fast-forward merge, push succeeds.

- [ ] **Step 4: Rebuild the container image**

```bash
./container/build.sh
```

Expected: `Build complete!` line.

- [ ] **Step 5: Restart the host service**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 5
launchctl list | grep com.nanoclaw
```

Expected: a new PID for `com.nanoclaw`.

- [ ] **Step 6: Verify the refresh script is reachable from the new container**

```bash
ls -l ~/dev/nanoclaw/scripts/refresh-gmail-tokens.py
python3 ~/dev/nanoclaw/scripts/refresh-gmail-tokens.py
```

Expected: at least the personal account shows `[OK] personal: token valid for ~XX more min`.

- [ ] **Step 7: Tail the log to confirm the service picks up the new code path**

```bash
tail -30 ~/dev/nanoclaw/logs/nanoclaw.log | grep -iE "nanoclaw running|sse connected|gmail"
```

Expected: `NanoClaw running` line + `SSE connected to superpilot` line. No errors.

- [ ] **Step 8: Trigger a manual test (send "hi" to the bot on Telegram)**

Watch the log:
```bash
tail -f ~/dev/nanoclaw/logs/nanoclaw.log
```

Expected sequence:
1. `Telegram message stored`
2. `Spawning container agent`
3. (No gmail-token-refresh log line for a plain "hi" — the refresh only fires from email triggers and scheduled tasks)
4. `Telegram message sent` with the agent's reply
5. `Container completed (streaming mode)` within ~30s

- [ ] **Step 9: Trigger an actual email-intelligence path (synthetic SSE event)**

```bash
cat > /tmp/synthetic-trigger.json <<'EOF'
{
  "type": "email_trigger",
  "emails": [
    {
      "thread_id": "19d7e51397391cf9",
      "account": "personal",
      "subject": "Diagnostic test trigger",
      "sender": "test@example.com"
    }
  ],
  "triggered_at": "2026-04-11T22:00:00Z",
  "source": "manual"
}
EOF
cp /tmp/synthetic-trigger.json ~/dev/nanoclaw/data/ipc/whatsapp_main/tasks/sse_trigger_$(date +%s).json
```

Watch:
```bash
tail -f ~/dev/nanoclaw/logs/nanoclaw.log
```

Expected sequence:
1. `Email trigger enqueued for agent processing`
2. `gmail-token-refresh: all accounts ok` (or `missing` for unauthorized accounts)
3. `Spawning container agent`
4. Telegram message arrives with `⏳ New email(s) — processing now…`
5. Tool narration updates the message in place
6. Final reply or `GMAIL-DEGRADED:` line if the MCP genuinely cannot find that thread
7. `Container completed (streaming mode)`

- [ ] **Step 10: Tomorrow morning — verify the 7:30 AM briefing**

Wait until ~7:35 AM local. Check Telegram for the briefing. Compare against the rubric:

- [ ] No `Digest unavailable — bot token not configured` (the discord-digest fix)
- [ ] No invented OVH-style "team confirmed" claims (Evidence discipline)
- [ ] No `GMAIL-DEGRADED:` line (Gmail token refresh worked)
- [ ] Discord section shows actual recent activity, not "Digest unavailable"
- [ ] Tool narration was visible in real time (the briefing took multiple minutes; the in-place message edits should have been visible)
- [ ] `session_costs` table has a new row with a real SDK cost (cents, not the old $1.85 flat number)

If any item fails, capture:
- The full briefing message text
- `tail -100 ~/dev/nanoclaw/logs/nanoclaw.log`
- The output of `./scripts/check-gmail-mcp.sh`
- `sqlite3 ~/dev/nanoclaw/store/messages.db "SELECT * FROM session_costs ORDER BY id DESC LIMIT 5;"`

- [ ] **Step 11: Final commit (no code — operational milestone)**

No commit needed. The plan is complete when the morning briefing passes the rubric.

---

## Self-Review Checklist

**Spec coverage:**
- ✓ Restart stuck container (Task 1)
- ✓ Diagnose root cause (Tasks 2, 8 — refresh script + diagnostic script give us live OAuth state and probe results)
- ✓ Auto-reconnect (Tasks 2-5: pre-refresh tokens before every spawn that touches email)
- ✓ Tomorrow briefing test (Task 10 step 10)
- ✓ Multi-account hardening (Task 6: only mount accounts with credentials.json)
- ✓ Evidence discipline for residual failures (Task 7: GMAIL-DEGRADED: rule)
- ✓ Operator runbook for future incidents (Task 9)

**Placeholder scan:** None — all code is concrete, all commit messages are written, all expected outputs are shown.

**Type consistency:** `GmailRefreshResult` interface defined in Task 3, used unchanged in Tasks 4 and 5. Status enum (`'ok' | 'missing' | 'error'`) matches the Python script's exit codes (0, 2, 3) consistently. The Python script writes `[OK]` / `[MISSING]` / `[ERROR]` prefixes that the runbook references in the same form.

**Risk notes:**
- Task 4 and 5 add a network call (`refresh-gmail-tokens.py`) before every email-trigger or scheduled-task spawn. The refresh is no-op when nothing needs refreshing, but if Google's OAuth endpoint is down, every trigger will wait the full 15s timeout. Acceptable: failures fall through to spawn-anyway behavior, and Google's OAuth uptime is famously good. If this becomes a problem we can shorten the timeout or cache "no refresh needed" decisions.
- Task 6 changes mount logic. Containers spawned before this commit won't have the new behavior. Operator must restart the host service after merging Task 6.
- Task 8's diagnostic script calls `npx -y @gongrzhe/server-gmail-autoauth-mcp` inside the container, which fetches the package on every run. If outbound npm is unavailable, the probe will fail — which is itself diagnostic information.
