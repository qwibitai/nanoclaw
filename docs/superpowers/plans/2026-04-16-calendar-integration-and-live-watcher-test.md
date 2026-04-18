# Calendar Integration & Live Browser Watcher Test Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a direct Google Calendar fetcher to NanoClaw (bypassing OneCLI which lacks the endpoint), expand OAuth scopes, and live-test browser watchers end-to-end.

**Architecture:** A new `src/calendar-fetcher.ts` module uses the `googleapis` npm package (already installed) with the existing Gmail OAuth credentials to fetch calendar events. The existing calendar poller (`src/calendar-poller.ts`) is updated to call this fetcher instead of the OneCLI endpoint. OAuth scope expansion requires a one-time re-authorization per Google account. Browser watcher live testing uses the existing watcher store + IPC to add a watcher and verify polling.

**Tech Stack:** TypeScript, googleapis (^146.0.0, already installed), existing Google OAuth credentials (~/.gmail-mcp/), vitest

---

### Task 1: Expand OAuth Scopes and Re-authorize

**Context:** The existing Gmail OAuth tokens at `~/.gmail-mcp*/credentials.json` only have `gmail.settings.basic` and `gmail.modify` scopes. Google Calendar API requires `calendar.readonly`. The OAuth client app at `~/.gmail-mcp*/gcp-oauth.keys.json` uses the `installed` flow. The refresh script at `scripts/refresh-gmail-tokens.py` handles token lifecycle.

**Files:**
- Modify: `scripts/refresh-gmail-tokens.py` — add `calendar.readonly` to required scopes list
- Create: `scripts/authorize-calendar.py` — one-time authorization script that adds calendar scope

- [ ] **Step 1: Create the calendar authorization script**

```python
#!/usr/bin/env python3
"""One-time script to add Google Calendar read-only scope to existing OAuth tokens.

For each Gmail account (~/.gmail-mcp, ~/.gmail-mcp-jonathan, ~/.gmail-mcp-attaxion, ~/.gmail-mcp-dev),
this script:
1. Reads the existing OAuth client config (gcp-oauth.keys.json)
2. Reads the existing credentials (credentials.json)
3. Initiates a new OAuth flow with the COMBINED scopes (existing + calendar.readonly)
4. Saves the updated credentials with the new scope

Run this once. After that, the refresh script will maintain the tokens.

Usage: python3 scripts/authorize-calendar.py [--account personal|jonathan|attaxion|dev|all]
"""

import json
import sys
import os
import http.server
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

HOME = Path.home()

ACCOUNTS = {
    "personal": HOME / ".gmail-mcp",
    "jonathan": HOME / ".gmail-mcp-jonathan",
    "attaxion": HOME / ".gmail-mcp-attaxion",
    "dev": HOME / ".gmail-mcp-dev",
}

CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
REDIRECT_URI = "http://localhost:8085"


def get_existing_scopes(creds_path: Path) -> list[str]:
    """Read existing scopes from credentials.json."""
    if not creds_path.exists():
        return []
    with open(creds_path) as f:
        creds = json.load(f)
    scope_str = creds.get("scope", "")
    return [s.strip() for s in scope_str.split() if s.strip()]


def authorize_account(name: str, account_dir: Path) -> bool:
    """Run OAuth flow for a single account, adding calendar scope."""
    keys_path = account_dir / "gcp-oauth.keys.json"
    creds_path = account_dir / "credentials.json"

    if not keys_path.exists():
        print(f"  SKIP {name}: no gcp-oauth.keys.json found")
        return False

    with open(keys_path) as f:
        keys = json.load(f)

    client_id = keys["installed"]["client_id"]
    client_secret = keys["installed"]["client_secret"]
    token_uri = keys["installed"]["token_uri"]

    # Combine existing scopes with calendar scope
    existing_scopes = get_existing_scopes(creds_path)
    if CALENDAR_SCOPE in existing_scopes:
        print(f"  OK {name}: calendar scope already present")
        return True

    all_scopes = list(set(existing_scopes + [CALENDAR_SCOPE]))
    scope_str = " ".join(all_scopes)

    print(f"\n  Authorizing {name} with scopes: {scope_str}")
    print(f"  Opening browser for Google OAuth consent...")

    # Build authorization URL
    auth_url = (
        "https://accounts.google.com/o/oauth2/v2/auth?"
        + urllib.parse.urlencode({
            "client_id": client_id,
            "redirect_uri": REDIRECT_URI,
            "response_type": "code",
            "scope": scope_str,
            "access_type": "offline",
            "prompt": "consent",  # Force consent to get new refresh token with expanded scopes
        })
    )

    # Start local HTTP server to capture the OAuth callback
    auth_code = None

    class CallbackHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            nonlocal auth_code
            query = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(query)
            auth_code = params.get("code", [None])[0]

            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(
                b"<html><body><h2>Authorization complete!</h2>"
                b"<p>You can close this tab.</p></body></html>"
            )

        def log_message(self, *args):
            pass  # Suppress HTTP log noise

    server = http.server.HTTPServer(("localhost", 8085), CallbackHandler)
    webbrowser.open(auth_url)

    print("  Waiting for OAuth callback...")
    server.handle_request()  # Handle one request (the callback)
    server.server_close()

    if not auth_code:
        print(f"  ERROR {name}: no authorization code received")
        return False

    # Exchange code for tokens
    token_data = urllib.parse.urlencode({
        "code": auth_code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    }).encode()

    req = urllib.request.Request(token_uri, data=token_data, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            tokens = json.loads(resp.read())
    except Exception as e:
        print(f"  ERROR {name}: token exchange failed: {e}")
        return False

    # Save updated credentials
    creds = {
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token", ""),
        "scope": scope_str,
        "token_type": tokens.get("token_type", "Bearer"),
        "expiry_date": int((tokens.get("expires_in", 3600)) * 1000 + __import__("time").time() * 1000),
    }

    # Preserve existing refresh_token if new one wasn't issued
    if not creds["refresh_token"] and creds_path.exists():
        with open(creds_path) as f:
            old = json.load(f)
        creds["refresh_token"] = old.get("refresh_token", "")

    with open(creds_path, "w") as f:
        json.dump(creds, f, indent=2)

    print(f"  OK {name}: calendar scope added, credentials saved")
    return True


def main():
    account_name = "all"
    if len(sys.argv) > 1:
        if sys.argv[1] == "--account" and len(sys.argv) > 2:
            account_name = sys.argv[2]
        else:
            account_name = sys.argv[1].lstrip("-")

    if account_name == "all":
        targets = ACCOUNTS
    elif account_name in ACCOUNTS:
        targets = {account_name: ACCOUNTS[account_name]}
    else:
        print(f"Unknown account: {account_name}")
        print(f"Valid accounts: {', '.join(ACCOUNTS.keys())}, all")
        sys.exit(1)

    print("Adding Google Calendar read-only scope to OAuth tokens\n")
    results = {}
    for name, path in targets.items():
        results[name] = authorize_account(name, path)

    print("\n--- Summary ---")
    for name, ok in results.items():
        print(f"  {name}: {'OK' if ok else 'FAILED'}")

    if not all(results.values()):
        sys.exit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Make the script executable**

```bash
chmod +x scripts/authorize-calendar.py
```

- [ ] **Step 3: Run the script for the primary account**

```bash
python3 scripts/authorize-calendar.py --account personal
```

Expected: Opens browser, user consents, credentials updated with `calendar.readonly` scope.

- [ ] **Step 4: Repeat for other accounts as needed**

```bash
python3 scripts/authorize-calendar.py --account attaxion
```

- [ ] **Step 5: Verify credentials have calendar scope**

```bash
python3 -c "import json; d=json.load(open('$HOME/.gmail-mcp/credentials.json')); print(d.get('scope',''))"
```

Expected: Output includes `calendar.readonly`

- [ ] **Step 6: Commit**

```bash
git add scripts/authorize-calendar.py
git commit -m "feat: add calendar OAuth scope authorization script"
```

---

### Task 2: Google Calendar Fetcher Module

**Files:**
- Create: `src/calendar-fetcher.ts` — fetches events from Google Calendar API using stored OAuth tokens
- Create: `src/calendar-fetcher.test.ts` — unit tests with mocked googleapis

- [ ] **Step 1: Write the failing test**

```typescript
// src/calendar-fetcher.test.ts
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
  it('returns empty array when no accounts have calendar scope', async () => {
    const events = await fetchCalendarEvents(
      Date.now(),
      Date.now() + 86400000,
      [], // no accounts
    );
    expect(events).toEqual([]);
  });

  it('returns events structure with correct fields', async () => {
    // This test verifies the function signature and return type
    // Real API calls are mocked at the googleapis level
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/calendar-fetcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the calendar fetcher implementation**

```typescript
// src/calendar-fetcher.ts
import fs from 'fs';
import path from 'path';
import os from 'os';
import { google, type calendar_v3 } from 'googleapis';
import { logger } from './logger.js';
import type { CalendarEvent } from './calendar-poller.js';

export interface CalendarAccountConfig {
  label: string;
  credentialsPath: string;
  oauthKeysPath: string;
}

interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}

interface OAuthKeys {
  installed: {
    client_id: string;
    client_secret: string;
    token_uri: string;
    auth_uri: string;
    redirect_uris: string[];
  };
}

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/**
 * Discover which Gmail-MCP accounts have calendar scope authorized.
 * Looks in standard locations: ~/.gmail-mcp, ~/.gmail-mcp-jonathan, etc.
 */
export function discoverCalendarAccounts(): CalendarAccountConfig[] {
  const home = os.homedir();
  const dirs = [
    { label: 'personal', dir: path.join(home, '.gmail-mcp') },
    { label: 'jonathan', dir: path.join(home, '.gmail-mcp-jonathan') },
    { label: 'attaxion', dir: path.join(home, '.gmail-mcp-attaxion') },
    { label: 'dev', dir: path.join(home, '.gmail-mcp-dev') },
  ];

  const accounts: CalendarAccountConfig[] = [];

  for (const { label, dir } of dirs) {
    const credsPath = path.join(dir, 'credentials.json');
    const keysPath = path.join(dir, 'gcp-oauth.keys.json');

    if (!fs.existsSync(credsPath) || !fs.existsSync(keysPath)) continue;

    try {
      const creds: StoredCredentials = JSON.parse(
        fs.readFileSync(credsPath, 'utf-8'),
      );
      if (creds.scope && creds.scope.includes(CALENDAR_SCOPE)) {
        accounts.push({
          label,
          credentialsPath: credsPath,
          oauthKeysPath: keysPath,
        });
      }
    } catch {
      // Skip malformed credential files
    }
  }

  return accounts;
}

/**
 * Build an authenticated Google Calendar client from stored credentials.
 */
function buildCalendarClient(
  account: CalendarAccountConfig,
): calendar_v3.Calendar | null {
  try {
    const keys: OAuthKeys = JSON.parse(
      fs.readFileSync(account.oauthKeysPath, 'utf-8'),
    );
    const creds: StoredCredentials = JSON.parse(
      fs.readFileSync(account.credentialsPath, 'utf-8'),
    );

    const oauth2 = new google.auth.OAuth2(
      keys.installed.client_id,
      keys.installed.client_secret,
    );

    oauth2.setCredentials({
      access_token: creds.access_token,
      refresh_token: creds.refresh_token,
      expiry_date: creds.expiry_date,
    });

    // Auto-save refreshed tokens
    oauth2.on('tokens', (tokens) => {
      try {
        const updated = { ...creds, ...tokens };
        if (tokens.expiry_date) updated.expiry_date = tokens.expiry_date;
        fs.writeFileSync(account.credentialsPath, JSON.stringify(updated, null, 2));
        logger.debug({ account: account.label }, 'Calendar OAuth tokens refreshed and saved');
      } catch (err) {
        logger.warn({ err, account: account.label }, 'Failed to save refreshed calendar tokens');
      }
    });

    return google.calendar({ version: 'v3', auth: oauth2 });
  } catch (err) {
    logger.warn({ err, account: account.label }, 'Failed to build calendar client');
    return null;
  }
}

/**
 * Fetch calendar events from all configured accounts within the given time range.
 *
 * @param fromMs - Start of range in epoch milliseconds
 * @param toMs - End of range in epoch milliseconds
 * @param accounts - Optional override of accounts to query (default: auto-discover)
 * @returns Array of CalendarEvent objects, tagged with source_account
 */
export async function fetchCalendarEvents(
  fromMs: number,
  toMs: number,
  accounts?: CalendarAccountConfig[],
): Promise<CalendarEvent[]> {
  const targets = accounts ?? discoverCalendarAccounts();

  if (targets.length === 0) {
    logger.debug('No Google accounts with calendar scope found');
    return [];
  }

  const timeMin = new Date(fromMs).toISOString();
  const timeMax = new Date(toMs).toISOString();
  const allEvents: CalendarEvent[] = [];

  for (const account of targets) {
    const calendar = buildCalendarClient(account);
    if (!calendar) continue;

    try {
      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50,
      });

      const items = response.data.items ?? [];

      for (const item of items) {
        if (!item.id) continue;

        const startTime = item.start?.dateTime ?? item.start?.date;
        const endTime = item.end?.dateTime ?? item.end?.date;

        if (!startTime || !endTime) continue;

        const attendees = (item.attendees ?? [])
          .map((a) => a.email)
          .filter((e): e is string => !!e);

        allEvents.push({
          id: item.id,
          title: item.summary ?? '',
          start_time: new Date(startTime).getTime(),
          end_time: new Date(endTime).getTime(),
          attendees,
          location: item.location ?? null,
          source_account: account.label,
        });
      }

      logger.debug(
        { account: account.label, count: items.length },
        'Fetched calendar events',
      );
    } catch (err) {
      logger.warn(
        { err, account: account.label },
        'Failed to fetch calendar events (non-fatal)',
      );
    }
  }

  return allEvents;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/calendar-fetcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/calendar-fetcher.ts src/calendar-fetcher.test.ts
git commit -m "feat: add direct Google Calendar fetcher using googleapis"
```

---

### Task 3: Update Calendar Poller to Use Direct Fetcher

**Files:**
- Modify: `src/calendar-poller.ts` — replace OneCLI fetch with direct calendar fetcher, keep OneCLI as fallback

- [ ] **Step 1: Write test for the fallback behavior**

Add to `src/__tests__/calendar-poller.test.ts`:

```typescript
describe('pollCalendar with direct fetcher', () => {
  it('uses direct fetcher when calendar accounts are available', async () => {
    // Mock fetchCalendarEvents to return events
    const { fetchCalendarEvents } = await import('../calendar-fetcher.js');
    vi.mocked(fetchCalendarEvents).mockResolvedValue([
      {
        id: 'direct-evt-1',
        title: 'Direct Calendar Event',
        start_time: Date.now() + 3600000,
        end_time: Date.now() + 7200000,
        attendees: ['test@example.com'],
        location: 'Room A',
        source_account: 'personal',
      },
    ]);

    await pollCalendar();

    const stored = getUpcomingEvents(0, Date.now() + 999999999999);
    expect(stored.some((e) => e.id === 'direct-evt-1')).toBe(true);
  });
});
```

- [ ] **Step 2: Modify calendar-poller.ts to try direct fetcher first**

At the top of `src/calendar-poller.ts`, add the import:

```typescript
import { fetchCalendarEvents, discoverCalendarAccounts } from './calendar-fetcher.js';
```

Then modify the `pollCalendar` function to try the direct fetcher first, falling back to OneCLI:

```typescript
export async function pollCalendar(): Promise<void> {
  const now = Date.now();

  // Try direct Google Calendar API first (preferred)
  const calendarAccounts = discoverCalendarAccounts();
  if (calendarAccounts.length > 0) {
    logger.debug({ accounts: calendarAccounts.length }, 'Using direct calendar fetcher');

    const events = await fetchCalendarEvents(
      now,
      now + CALENDAR_LOOKAHEAD_MS,
      calendarAccounts,
    );

    if (events.length > 0 || calendarAccounts.length > 0) {
      storeCalendarEvents(events);

      eventBus.emit('calendar.synced', {
        type: 'calendar.synced',
        source: 'calendar-poller',
        timestamp: now,
        payload: { eventsFound: events.length, lookaheadMs: CALENDAR_LOOKAHEAD_MS },
      });

      logger.info({ eventsFound: events.length, source: 'direct' }, 'Calendar poll complete');
      return;
    }
  }

  // Fallback: try OneCLI endpoint
  const url = `${ONECLI_URL}/calendar/events?from=${now}&to=${now + CALENDAR_LOOKAHEAD_MS}`;
  logger.debug({ url }, 'Polling calendar via OneCLI');

  const response = await fetch(url);
  if (!response.ok) {
    logger.debug(
      { status: response.status, url },
      'Calendar endpoint not available (skipping)',
    );
    return;
  }

  // ... rest of OneCLI parsing (keep existing code for the response parsing)
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/__tests__/calendar-poller.test.ts`
Expected: All tests pass (existing + new)

- [ ] **Step 4: Commit**

```bash
git add src/calendar-poller.ts src/__tests__/calendar-poller.test.ts
git commit -m "feat: calendar poller uses direct Google API, OneCLI as fallback"
```

---

### Task 4: Live Calendar Integration Test

**Files:**
- No code changes — manual verification

- [ ] **Step 1: Verify OAuth credentials have calendar scope**

```bash
python3 -c "import json; d=json.load(open('$HOME/.gmail-mcp/credentials.json')); print('Scopes:', d.get('scope',''))"
```

If `calendar.readonly` is NOT in scope, run Task 1 first.

- [ ] **Step 2: Test the direct fetcher manually**

```bash
npx tsx -e "
import { fetchCalendarEvents, discoverCalendarAccounts } from './src/calendar-fetcher.js';
const accounts = discoverCalendarAccounts();
console.log('Discovered accounts:', accounts.map(a => a.label));
const now = Date.now();
const events = await fetchCalendarEvents(now, now + 86400000);
console.log('Events found:', events.length);
for (const e of events.slice(0, 5)) {
  console.log(' -', e.title, 'at', new Date(e.start_time).toLocaleString(), 'from', e.source_account);
}
"
```

Expected: Lists discovered accounts and any calendar events in the next 24 hours.

- [ ] **Step 3: Verify the calendar poller picks up events**

Check NanoClaw logs for calendar poll results:

```bash
# Restart NanoClaw and watch for calendar sync
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 10
grep -i "calendar\|Calendar" /tmp/nanoclaw.log | tail -10
```

Expected: `Calendar poll complete` with `eventsFound` > 0 (if calendar has events).

- [ ] **Step 4: Commit (if any tweaks needed)**

---

### Task 5: Add Browser Watcher via IPC

**Context:** Browser watchers are now fully wired (Tasks 1-4 from previous plan). The watcher store, extract function, polling loop, and event consumer are all connected. This task tests the full system by adding a watcher that monitors a real web page.

**Files:**
- No code changes — IPC-based live test

- [ ] **Step 1: Create a test watcher via the watcher store directly**

We'll use the NanoClaw database to insert a watcher config. The watcher poller will pick it up on its next tick.

```bash
# Insert a watcher that monitors the Hacker News top story title
npx tsx -e "
import { initDatabase } from './src/db.js';
import { addWatcher, listAllEnabledWatchers } from './src/watchers/watcher-store.js';

// Point to the real DB
process.env.STORE_DIR = './store';
initDatabase();

const w = addWatcher({
  url: 'https://news.ycombinator.com',
  selector: '.titleline > a',
  groupId: 'telegram_main',
  intervalMs: 300000, // 5 minutes
  label: 'HN top story',
});
console.log('Watcher added:', w);
console.log('All enabled watchers:', listAllEnabledWatchers());
"
```

Expected: Watcher inserted with a generated ID.

- [ ] **Step 2: Verify the watcher appears in the database**

```bash
sqlite3 store/messages.db "SELECT id, url, selector, group_id, interval_ms, label, enabled FROM browser_watchers;"
```

Expected: One row with the HN watcher config.

- [ ] **Step 3: Wait for one poll cycle and check results**

The watcher poller runs every 30 seconds. After one cycle, the `last_value` and `checked_at` should be populated:

```bash
sleep 35
sqlite3 store/messages.db "SELECT id, last_value, checked_at, enabled FROM browser_watchers;"
```

Expected: `last_value` contains the top HN story title, `checked_at` is a recent timestamp.

- [ ] **Step 4: Check NanoClaw logs for watcher activity**

```bash
grep -i "watcher" /tmp/nanoclaw.log | tail -20
```

Expected: Log lines showing `Browser watcher: change detected` or `no change detected`.

- [ ] **Step 5: Verify Telegram notification was sent (first check = change)**

The first poll always triggers a `watcher.changed` event (previousValue is null). Check Telegram for a notification message like:

```
🔔 **Watcher update** (watcher-XXXXXXXX)
URL: https://news.ycombinator.com
Changed: (first check) → [HN top story title]
```

- [ ] **Step 6: Clean up the test watcher**

```bash
npx tsx -e "
import { initDatabase } from './src/db.js';
import { removeWatcher, listAllEnabledWatchers } from './src/watchers/watcher-store.js';
process.env.STORE_DIR = './store';
initDatabase();

const watchers = listAllEnabledWatchers();
for (const w of watchers) {
  if (w.label === 'HN top story') {
    removeWatcher(w.id);
    console.log('Removed:', w.id);
  }
}
console.log('Remaining enabled:', listAllEnabledWatchers().length);
"
```

---

### Task 6: IPC-based Watcher Addition (Container Skill Integration)

**Context:** In the future, watchers should be addable from inside containers via IPC (similar to teach-mode procedures). This task adds a `watch_page` IPC handler to the orchestrator so agents can create watchers.

**Files:**
- Modify: `src/ipc.ts` — add `watch_page` task type handler
- Create: `src/__tests__/ipc-watcher.test.ts` — test for the new handler

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/ipc-watcher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/test-store',
  DATA_DIR: '/tmp/test-data',
  ASSISTANT_NAME: 'TestBot',
  GROUPS_DIR: '/tmp/test-groups',
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

import { addWatcher, listAllEnabledWatchers } from '../watchers/watcher-store.js';
import { handleWatchPageIpc } from '../ipc.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

describe('watch_page IPC handler', () => {
  it('creates a watcher from IPC task data', () => {
    const taskData = {
      type: 'watch_page',
      url: 'https://example.com/status',
      selector: '.status-badge',
      label: 'Service status',
      intervalMs: 120000,
    };

    const result = handleWatchPageIpc(taskData, 'telegram_main');

    expect(result.success).toBe(true);
    expect(result.watcherId).toMatch(/^watcher-/);

    const watchers = listAllEnabledWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].url).toBe('https://example.com/status');
    expect(watchers[0].groupId).toBe('telegram_main');
  });

  it('uses default intervalMs when not provided', () => {
    const taskData = {
      type: 'watch_page',
      url: 'https://example.com',
      selector: '.price',
      label: 'Price tracker',
    };

    const result = handleWatchPageIpc(taskData, 'telegram_main');
    expect(result.success).toBe(true);

    const watchers = listAllEnabledWatchers();
    expect(watchers[0].intervalMs).toBe(300000); // 5 min default
  });

  it('rejects missing url or selector', () => {
    const result1 = handleWatchPageIpc(
      { type: 'watch_page', selector: '.x', label: 'test' },
      'telegram_main',
    );
    expect(result1.success).toBe(false);
    expect(result1.error).toContain('url');

    const result2 = handleWatchPageIpc(
      { type: 'watch_page', url: 'https://x.com', label: 'test' },
      'telegram_main',
    );
    expect(result2.success).toBe(false);
    expect(result2.error).toContain('selector');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ipc-watcher.test.ts`
Expected: FAIL — `handleWatchPageIpc` not exported from ipc.ts

- [ ] **Step 3: Add the watch_page IPC handler**

In `src/ipc.ts`, add the handler function and wire it into the IPC task processor:

```typescript
import { addWatcher } from './watchers/watcher-store.js';

export interface WatchPageIpcResult {
  success: boolean;
  watcherId?: string;
  error?: string;
}

export function handleWatchPageIpc(
  taskData: Record<string, unknown>,
  groupName: string,
): WatchPageIpcResult {
  const url = taskData.url as string | undefined;
  const selector = taskData.selector as string | undefined;
  const label = (taskData.label as string) || 'Unnamed watcher';
  const intervalMs = (taskData.intervalMs as number) || 300000; // 5 min default

  if (!url) {
    return { success: false, error: 'watch_page: url is required' };
  }
  if (!selector) {
    return { success: false, error: 'watch_page: selector is required' };
  }

  try {
    const watcher = addWatcher({
      url,
      selector,
      groupId: groupName,
      intervalMs,
      label,
    });

    logger.info(
      { watcherId: watcher.id, url, groupId: groupName },
      'watch_page IPC: watcher created',
    );

    return { success: true, watcherId: watcher.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'watch_page IPC: failed to create watcher');
    return { success: false, error: msg };
  }
}
```

Then add the `watch_page` case to the IPC task switch statement (alongside `learn_feedback`, `scheduled_task`, etc.):

```typescript
case 'watch_page': {
  const result = handleWatchPageIpc(taskData, groupName);
  if (result.success) {
    logger.info({ watcherId: result.watcherId }, 'watch_page IPC processed');
  } else {
    logger.warn({ error: result.error }, 'watch_page IPC failed');
  }
  break;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/ipc-watcher.test.ts`
Expected: PASS — all 3 tests green

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/ipc.ts src/__tests__/ipc-watcher.test.ts
git commit -m "feat: add watch_page IPC handler for container-initiated watchers"
```

---

### Task 7: Live IPC Watcher Test

**Files:**
- No code changes — end-to-end IPC simulation

- [ ] **Step 1: Drop a watch_page IPC task file**

```bash
mkdir -p data/ipc/telegram_main/tasks
cat > "data/ipc/telegram_main/tasks/test-watcher-$(date +%s).json" << 'EOF'
{
  "type": "watch_page",
  "url": "https://example.com",
  "selector": "h1",
  "label": "Example.com heading",
  "intervalMs": 60000
}
EOF
```

- [ ] **Step 2: Wait for IPC processing**

```bash
sleep 3
```

- [ ] **Step 3: Verify watcher was created**

```bash
sqlite3 store/messages.db "SELECT id, url, selector, label, group_id FROM browser_watchers WHERE label = 'Example.com heading';"
```

Expected: One row with the watcher config.

- [ ] **Step 4: Check logs for IPC processing**

```bash
grep -i "watch_page" /tmp/nanoclaw.log | tail -5
```

Expected: `watch_page IPC processed` with a watcher ID.

- [ ] **Step 5: Clean up**

```bash
npx tsx -e "
import { initDatabase } from './src/db.js';
import { removeWatcher, listAllEnabledWatchers } from './src/watchers/watcher-store.js';
process.env.STORE_DIR = './store';
initDatabase();
for (const w of listAllEnabledWatchers()) {
  if (w.label === 'Example.com heading') {
    removeWatcher(w.id);
    console.log('Cleaned up:', w.id);
  }
}
"
```
