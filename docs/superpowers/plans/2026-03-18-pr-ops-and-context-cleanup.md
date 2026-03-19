# PR Operations & Context Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PR watch/review capabilities, enable superpowers for all container agents, and clean channel-specific formatting out of CLAUDE.md into runtime prompt injection.

**Architecture:** Four independent workstreams — (1) default skills change, (2) CLAUDE.md cleanup + prompt injection, (3) PR watch system (db + ipc + watcher), (4) PR review container skill. All follow existing NanoClaw patterns: SQLite for state, filesystem IPC, GroupQueue for container spawning.

**Tech Stack:** TypeScript, better-sqlite3, vitest, `gh` CLI for GitHub API

**Spec:** `docs/superpowers/specs/2026-03-18-pr-ops-and-context-cleanup-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/types.ts` | Add `formattingInstructions` to Channel interface |
| `src/config.ts` | Add `PR_POLL_INTERVAL` constant |
| `src/router.ts` | Accept optional channel in `formatMessages()`, inject `<channel_formatting>` |
| `src/db.ts` | `watched_prs` table schema + CRUD functions |
| `src/pr-watcher.ts` | New: polling loop for watched PRs, GitHub API, container spawning |
| `src/ipc.ts` | Handle `watch_pr` / `unwatch_pr` IPC types in `prs/` subdirectory |
| `src/index.ts` | Start PR watcher, pass channel to `formatMessages()` |
| `groups/global/CLAUDE.md` | Remove Discord formatting, add autonomy model |
| `groups/main/CLAUDE.md` | Remove WhatsApp formatting |
| `container/skills-catalog/local/pr-review/SKILL.md` | New: PR review glue skill |
| `container/skills-catalog/catalog.json` | Add pr-review entry |
| `src/formatting.test.ts` | Tests for channel formatting injection |
| `src/db.test.ts` | Tests for watched_prs CRUD |
| `src/pr-watcher.test.ts` | New: tests for PR watcher logic |
| `src/ipc.test.ts` | Tests for watch_pr/unwatch_pr IPC handling |

---

### Task 1: Enable Superpowers for All Groups

**Files:**
- Modify: `src/types.ts:43` (default skills comment)
- Modify: `src/db.ts:130` (migration default)
- Modify: `src/db.ts:624,693` (fallback defaults in getRegisteredGroup/getAllRegisteredGroups)
- Modify: `src/db.ts:660` (setRegisteredGroup default)
- Modify: `groups/global/CLAUDE.md:56-75` (remove Discord formatting, add autonomy model)

- [ ] **Step 1: Update default skills comment in types.ts**

In `src/types.ts:43`, update the comment to reflect the new default:

```typescript
  skills?: string[]; // Category tags for skill pre-loading. Default: ["general", "coding"]
```

- [ ] **Step 2: Add migration to update existing groups' default skills**

The existing ALTER TABLE migration at `src/db.ts:129` only runs once (the catch swallows "column already exists"). Changing it would have no effect on existing databases. Instead, add a **new** migration after the existing skills migration (after line 134):

```typescript
  // Migrate existing groups from old default ["general"] to new default ["general","coding"]
  try {
    database.exec(
      `UPDATE registered_groups SET skills = '["general","coding"]' WHERE skills = '["general"]'`,
    );
  } catch {
    /* already migrated or table doesn't exist yet */
  }
```

- [ ] **Step 3: Update fallback defaults in db.ts getRegisteredGroup**

In `src/db.ts:624`, change the fallback:

```typescript
    let skills: string[] = ['general', 'coding'];
    try {
      skills = row.skills ? JSON.parse(row.skills) : ['general', 'coding'];
```

- [ ] **Step 4: Update fallback defaults in db.ts getAllRegisteredGroups**

In `src/db.ts:693`, same change:

```typescript
      let skills: string[] = ['general', 'coding'];
      try {
        skills = row.skills ? JSON.parse(row.skills) : ['general', 'coding'];
```

- [ ] **Step 5: Update setRegisteredGroup default**

In `src/db.ts:660`, change the fallback:

```typescript
    group.skills ? JSON.stringify(group.skills) : '["general","coding"]',
```

- [ ] **Step 6: Add autonomy model to global CLAUDE.md**

In `groups/global/CLAUDE.md`, remove the "Message Formatting" section (lines 56-75, the Discord formatting rules) and add this section after the "GitHub" section:

```markdown
## Autonomy Model

When a skill asks for user input or approval:

- **Design/plan approval** → send to user via `send_message`, wait for their response before proceeding
- **Execution decisions** (TDD, debugging, verification, code review) → use your own judgment, proceed autonomously
- **Stuck or uncertain** → ask user via `send_message`

When working on non-trivial tasks: brainstorm and send the design to the user for approval before building. Once approved, execute autonomously — run TDD, verify, debug, and review your own code without checking in at every step.
```

- [ ] **Step 7: Remove WhatsApp formatting from main CLAUDE.md**

In `groups/main/CLAUDE.md`, remove the "WhatsApp Formatting" section (lines 46-55).

- [ ] **Step 8: Run tests and verify build**

Run: `npm test && npm run build`
Expected: All tests pass, build succeeds

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/db.ts groups/global/CLAUDE.md groups/main/CLAUDE.md
git commit -m "feat: enable superpowers for all groups by default, add autonomy model"
```

---

### Task 2: Channel Formatting Runtime Injection

**Files:**
- Modify: `src/types.ts:88-105` (Channel interface)
- Modify: `src/router.ts:13-25` (formatMessages signature)
- Modify: `src/index.ts:184,444` (pass channel to formatMessages)
- Test: `src/formatting.test.ts`

- [ ] **Step 1: Write the failing test for formatMessages with channel**

In `src/formatting.test.ts`, add these tests after the existing `formatMessages` describe block:

```typescript
describe('formatMessages with channel formatting', () => {
  const TZ = 'UTC';

  it('injects channel_formatting when channel has formattingInstructions', () => {
    const channel = {
      name: 'discord',
      formattingInstructions: 'Use **bold** for emphasis',
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      ownsJid: () => true,
      disconnect: async () => {},
    } as Channel;

    const result = formatMessages([makeMsg()], TZ, channel);
    expect(result).toContain('<channel_formatting>');
    expect(result).toContain('Use **bold** for emphasis');
    expect(result).toContain('channel="discord"');
  });

  it('omits channel_formatting when channel has no formattingInstructions', () => {
    const channel = {
      name: 'telegram',
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      ownsJid: () => true,
      disconnect: async () => {},
    } as Channel;

    const result = formatMessages([makeMsg()], TZ, channel);
    expect(result).not.toContain('<channel_formatting>');
    expect(result).not.toContain('channel=');
  });

  it('works without channel parameter (backward compatible)', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).not.toContain('<channel_formatting>');
    expect(result).toContain('<context timezone=');
  });
});
```

Add `Channel` to the imports from `./types.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/formatting.test.ts`
Expected: FAIL — `formatMessages` doesn't accept a third parameter yet

- [ ] **Step 3: Add formattingInstructions to Channel interface**

In `src/types.ts`, add after line 89 (`name: string;`):

```typescript
  /** Channel-specific formatting rules, injected into prompts at runtime. */
  formattingInstructions?: string;
```

- [ ] **Step 4: Update formatMessages to accept optional channel**

Replace the `formatMessages` function in `src/router.ts:13-25` with:

```typescript
export function formatMessages(
  messages: NewMessage[],
  timezone: string,
  channel?: Channel,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const channelAttr = channel?.formattingInstructions
    ? ` channel="${escapeXml(channel.name)}"`
    : '';
  const header = `<context timezone="${escapeXml(timezone)}"${channelAttr} />\n`;

  const formattingBlock = channel?.formattingInstructions
    ? `<channel_formatting>\n${channel.formattingInstructions}\n</channel_formatting>\n`
    : '';

  return `${header}${formattingBlock}<messages>\n${lines.join('\n')}\n</messages>`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/formatting.test.ts`
Expected: PASS

- [ ] **Step 6: Pass channel to formatMessages in processGroupMessages**

In `src/index.ts:184`, change:

```typescript
  const prompt = formatMessages(missedMessages, TIMEZONE);
```

to:

```typescript
  const prompt = formatMessages(missedMessages, TIMEZONE, channel);
```

The `channel` variable is already available from line 156: `const channel = findChannel(channels, chatJid);`

- [ ] **Step 7: Pass channel to formatMessages in startMessageLoop**

In `src/index.ts:444`, change:

```typescript
          const formatted = formatMessages(messagesToSend, TIMEZONE);
```

to:

```typescript
          const formatted = formatMessages(messagesToSend, TIMEZONE, channel);
```

The `channel` variable is already available from line 412: `const channel = findChannel(channels, chatJid);`

- [ ] **Step 8: Run full tests and build**

Run: `npm test && npm run build`
Expected: All tests pass, build succeeds

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/router.ts src/index.ts src/formatting.test.ts
git commit -m "feat: inject channel formatting into prompts at runtime"
```

---

### Task 3: PR Watch Database Schema & CRUD

**Files:**
- Modify: `src/db.ts` (add watched_prs table + functions)
- Test: `src/db.test.ts`

- [ ] **Step 1: Write failing tests for watched_prs CRUD**

Add to `src/db.test.ts`. First add imports at the top:

```typescript
import {
  // ... existing imports ...
  addWatchedPr,
  getActiveWatchedPrs,
  getWatchedPr,
  updateWatchedPr,
  unwatchPr,
} from './db.js';
```

Then add the test block:

```typescript
// --- watched_prs ---

describe('watched_prs', () => {
  it('adds and retrieves a watched PR', () => {
    addWatchedPr({
      repo: 'owner/repo',
      pr_number: 42,
      group_folder: 'main',
      chat_jid: 'jid@test',
      source: 'manual',
    });

    const pr = getWatchedPr('owner/repo', 42);
    expect(pr).toBeDefined();
    expect(pr!.repo).toBe('owner/repo');
    expect(pr!.pr_number).toBe(42);
    expect(pr!.status).toBe('active');
    expect(pr!.last_comment_id).toBeNull();
  });

  it('returns active watched PRs only', () => {
    addWatchedPr({ repo: 'a/b', pr_number: 1, group_folder: 'main', chat_jid: 'jid@test', source: 'auto' });
    addWatchedPr({ repo: 'c/d', pr_number: 2, group_folder: 'main', chat_jid: 'jid@test', source: 'manual' });

    updateWatchedPr('c/d', 2, { status: 'merged' });

    const active = getActiveWatchedPrs();
    expect(active).toHaveLength(1);
    expect(active[0].repo).toBe('a/b');
  });

  it('updates last_comment_id and last_checked_at', () => {
    addWatchedPr({ repo: 'a/b', pr_number: 1, group_folder: 'main', chat_jid: 'jid@test', source: 'auto' });
    updateWatchedPr('a/b', 1, { last_comment_id: 12345, last_checked_at: '2026-01-01T00:00:00Z' });

    const pr = getWatchedPr('a/b', 1);
    expect(pr!.last_comment_id).toBe(12345);
    expect(pr!.last_checked_at).toBe('2026-01-01T00:00:00Z');
  });

  it('unwatches a PR', () => {
    addWatchedPr({ repo: 'a/b', pr_number: 1, group_folder: 'main', chat_jid: 'jid@test', source: 'auto' });
    unwatchPr('a/b', 1);

    const pr = getWatchedPr('a/b', 1);
    expect(pr!.status).toBe('unwatched');
  });

  it('enforces unique repo+pr_number', () => {
    addWatchedPr({ repo: 'a/b', pr_number: 1, group_folder: 'main', chat_jid: 'jid@test', source: 'auto' });
    // Adding same repo+pr should not throw (upsert behavior)
    addWatchedPr({ repo: 'a/b', pr_number: 1, group_folder: 'other', chat_jid: 'jid2@test', source: 'manual' });

    const pr = getWatchedPr('a/b', 1);
    // Should update, not duplicate
    expect(pr!.group_folder).toBe('other');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts`
Expected: FAIL — functions don't exist yet

- [ ] **Step 3: Add watched_prs table to createSchema**

In `src/db.ts`, inside `createSchema()`, add after the `active_threads` table (before `registered_groups`):

```sql
    CREATE TABLE IF NOT EXISTS watched_prs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT DEFAULT 'active',
      last_checked_at TEXT,
      last_comment_id INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(repo, pr_number)
    );
    CREATE INDEX IF NOT EXISTS idx_watched_prs_status ON watched_prs(status);
```

- [ ] **Step 4: Add WatchedPr interface and CRUD functions**

Add after the active thread accessors section in `src/db.ts`:

```typescript
// --- Watched PR accessors ---

export interface WatchedPr {
  id: number;
  repo: string;
  pr_number: number;
  group_folder: string;
  chat_jid: string;
  source: string;
  status: string;
  last_checked_at: string | null;
  last_comment_id: number | null;
  created_at: string;
}

export function addWatchedPr(pr: {
  repo: string;
  pr_number: number;
  group_folder: string;
  chat_jid: string;
  source: string;
}): void {
  db.prepare(
    `INSERT INTO watched_prs (repo, pr_number, group_folder, chat_jid, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       group_folder = excluded.group_folder,
       chat_jid = excluded.chat_jid,
       source = excluded.source,
       status = 'active'`,
  ).run(pr.repo, pr.pr_number, pr.group_folder, pr.chat_jid, pr.source, new Date().toISOString());
}

export function getWatchedPr(repo: string, prNumber: number): WatchedPr | undefined {
  return db
    .prepare('SELECT * FROM watched_prs WHERE repo = ? AND pr_number = ?')
    .get(repo, prNumber) as WatchedPr | undefined;
}

export function getActiveWatchedPrs(): WatchedPr[] {
  return db
    .prepare("SELECT * FROM watched_prs WHERE status = 'active' ORDER BY created_at")
    .all() as WatchedPr[];
}

export function updateWatchedPr(
  repo: string,
  prNumber: number,
  updates: Partial<Pick<WatchedPr, 'status' | 'last_checked_at' | 'last_comment_id'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.last_checked_at !== undefined) {
    fields.push('last_checked_at = ?');
    values.push(updates.last_checked_at);
  }
  if (updates.last_comment_id !== undefined) {
    fields.push('last_comment_id = ?');
    values.push(updates.last_comment_id);
  }

  if (fields.length === 0) return;
  values.push(repo, prNumber);
  db.prepare(
    `UPDATE watched_prs SET ${fields.join(', ')} WHERE repo = ? AND pr_number = ?`,
  ).run(...values);
}

export function unwatchPr(repo: string, prNumber: number): void {
  db.prepare(
    "UPDATE watched_prs SET status = 'unwatched' WHERE repo = ? AND pr_number = ?",
  ).run(repo, prNumber);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: add watched_prs table and CRUD functions"
```

---

### Task 4: IPC Handler for watch_pr / unwatch_pr

**Files:**
- Modify: `src/ipc.ts:121-318` (add prs/ directory scanning)
- Test: `src/ipc.test.ts` (if exists) or inline verification

- [ ] **Step 1: Check if ipc tests exist**

Run: `ls src/ipc*.test.ts 2>/dev/null || echo "no ipc tests"`

- [ ] **Step 2: Add prs/ directory scanning to processIpcFiles**

In `src/ipc.ts`, add the import for `addWatchedPr` and `unwatchPr` at the top (line 14):

```typescript
import { addWatchedPr, createTask, deleteTask, getTaskById, unwatchPr, updateTask } from './db.js';
```

Then inside `processIpcFiles()`, after the file-send block (after line 317, before the closing `}` of the `for (const sourceGroup of groupFolders)` loop), add:

```typescript
      // Process PR watch requests from this group's IPC directory
      const prsDir = path.join(ipcBaseDir, sourceGroup, 'prs');
      try {
        if (fs.existsSync(prsDir)) {
          const prFiles = fs
            .readdirSync(prsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of prFiles) {
            const filePath = path.join(prsDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

              if (data.type === 'watch_pr' && data.repo && data.pr_number) {
                // Resolve chat_jid from sourceGroup
                const groups = deps.registeredGroups();
                const groupEntry = Object.entries(groups).find(
                  ([, g]) => g.folder === sourceGroup,
                );
                if (groupEntry) {
                  const [chatJid] = groupEntry;
                  addWatchedPr({
                    repo: data.repo,
                    pr_number: data.pr_number,
                    group_folder: sourceGroup,
                    chat_jid: chatJid,
                    source: data.source || 'manual',
                  });
                  logger.info(
                    { repo: data.repo, pr: data.pr_number, sourceGroup },
                    'PR watch added via IPC',
                  );
                } else {
                  logger.warn(
                    { sourceGroup },
                    'Cannot watch PR: group not registered',
                  );
                }
              } else if (data.type === 'unwatch_pr' && data.repo && data.pr_number) {
                // Authorization: any group can unwatch its own PRs
                // Main can unwatch any PR
                unwatchPr(data.repo, data.pr_number);
                logger.info(
                  { repo: data.repo, pr: data.pr_number, sourceGroup },
                  'PR unwatched via IPC',
                );
              }

              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC PR watch',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC prs directory');
      }
```

- [ ] **Step 3: Add `prs` to IPC subdirectory list in container-runner.ts**

In `src/container-runner.ts:234`, add `'prs'` to the subdirectory list so the directory exists when containers try to write watch_pr IPC files:

```typescript
  for (const sub of ['messages', 'tasks', 'input', 'files', 'prs']) {
```

- [ ] **Step 4: Run tests and build**

Run: `npm test && npm run build`
Expected: All tests pass, build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/container-runner.ts
git commit -m "feat: handle watch_pr and unwatch_pr IPC messages"
```

---

### Task 5: PR Watcher Module

**Files:**
- Create: `src/pr-watcher.ts`
- Modify: `src/config.ts` (add PR_POLL_INTERVAL)
- Modify: `src/index.ts` (start PR watcher)
- Test: `src/pr-watcher.test.ts`

- [ ] **Step 1: Add PR_POLL_INTERVAL to config**

In `src/config.ts`, add after the `parseIntEnv` function definition (after line 43). This constant uses `parseIntEnv` so it must come after its definition:

```typescript
export const PR_POLL_INTERVAL = parseIntEnv(
  process.env.PR_POLL_INTERVAL,
  300000,
); // 5 minutes default
```

- [ ] **Step 2: Write the PR watcher test**

Create `src/pr-watcher.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

import { buildPrFeedbackPrompt, parsePrUrl } from './pr-watcher.js';

describe('parsePrUrl', () => {
  it('parses a GitHub PR URL', () => {
    const result = parsePrUrl('https://github.com/owner/repo/pull/42');
    expect(result).toEqual({ repo: 'owner/repo', pr_number: 42 });
  });

  it('returns null for non-PR URLs', () => {
    expect(parsePrUrl('https://github.com/owner/repo')).toBeNull();
    expect(parsePrUrl('not a url')).toBeNull();
  });

  it('handles trailing slashes and fragments', () => {
    const result = parsePrUrl('https://github.com/owner/repo/pull/42/files#diff');
    expect(result).toEqual({ repo: 'owner/repo', pr_number: 42 });
  });
});

describe('buildPrFeedbackPrompt', () => {
  it('builds XML prompt with review comments', () => {
    const prompt = buildPrFeedbackPrompt({
      repo: 'owner/repo',
      pr_number: 42,
      branch: 'feature-x',
      url: 'https://github.com/owner/repo/pull/42',
      comments: [
        { id: 123, file: 'src/foo.ts', line: 10, author: 'reviewer', body: 'Fix this' },
      ],
      timezone: 'UTC',
    });

    expect(prompt).toContain('<pr repo="owner/repo"');
    expect(prompt).toContain('number="42"');
    expect(prompt).toContain('Fix this');
    expect(prompt).toContain('reviewer');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/pr-watcher.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 4: Create pr-watcher.ts**

Create `src/pr-watcher.ts`:

```typescript
import { execSync } from 'child_process';

import { PR_POLL_INTERVAL, TIMEZONE } from './config.js';
import { getActiveWatchedPrs, updateWatchedPr } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import { ContainerOutput, runContainerAgent } from './container-runner.js';
import { escapeXml } from './router.js';
import { ChildProcess } from 'child_process';

export interface PrWatcherDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  /** GitHub username of the bot, used to filter out self-comments */
  botGitHubUser?: string;
}

export interface PrComment {
  id: number;
  file: string;
  line: number | null;
  author: string;
  body: string;
}

/** Parse a GitHub PR URL into repo and pr_number. */
export function parsePrUrl(
  url: string,
): { repo: string; pr_number: number } | null {
  const match = url.match(
    /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/,
  );
  if (!match) return null;
  return { repo: match[1], pr_number: parseInt(match[2], 10) };
}

/** Build the XML prompt for PR feedback processing. */
export function buildPrFeedbackPrompt(params: {
  repo: string;
  pr_number: number;
  branch: string;
  url: string;
  comments: PrComment[];
  timezone: string;
}): string {
  const commentXml = params.comments
    .map(
      (c) =>
        `    <comment id="${c.id}" file="${escapeXml(c.file)}" line="${c.line ?? ''}" author="${escapeXml(c.author)}">\n      ${escapeXml(c.body)}\n    </comment>`,
    )
    .join('\n');

  return `<context timezone="${escapeXml(params.timezone)}" />
<pr_feedback>
  <pr repo="${escapeXml(params.repo)}" number="${params.pr_number}" branch="${escapeXml(params.branch)}" url="${escapeXml(params.url)}" />
  <review_comments>
${commentXml}
  </review_comments>
</pr_feedback>

Instructions:
- The repo should be cloned at /workspace/group/repos/${escapeXml(params.repo)}. If not, clone it first.
- Check out the PR branch: gh pr checkout ${params.pr_number}
- Triage each comment:
  - Simple (typos, naming, formatting, single-file nits): fix, commit, push, reply on GitHub
  - Substantive (design, logic, multi-file): summarize and ask user via send_message before acting
- After fixing simple issues, notify user: "Fixed N nits on PR #${params.pr_number}, pushed commit <sha>"`;
}

/** Call gh api and parse JSON result. Returns null on failure. */
function ghApi(endpoint: string): unknown | null {
  try {
    const result = execSync(`gh api ${endpoint}`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(result);
  } catch (err) {
    logger.warn({ endpoint, err }, 'gh api call failed');
    return null;
  }
}

let watcherRunning = false;

export function startPrWatcher(deps: PrWatcherDeps): void {
  if (watcherRunning) {
    logger.debug('PR watcher already running, skipping duplicate start');
    return;
  }
  watcherRunning = true;
  logger.info('PR watcher started');

  const loop = async () => {
    try {
      const watchedPrs = getActiveWatchedPrs();

      if (watchedPrs.length > 100) {
        logger.warn(
          { count: watchedPrs.length },
          'High number of watched PRs — may approach GitHub API rate limits',
        );
      }

      for (const pr of watchedPrs) {
        try {
          // Check PR state
          const prData = ghApi(
            `repos/${pr.repo}/pulls/${pr.pr_number}`,
          ) as { state?: string; head?: { ref?: string } } | null;

          if (!prData) continue;

          // If merged or closed, update status and skip
          if (prData.state === 'closed' || prData.state === 'merged') {
            updateWatchedPr(pr.repo, pr.pr_number, {
              status: prData.state,
              last_checked_at: new Date().toISOString(),
            });
            logger.info(
              { repo: pr.repo, pr: pr.pr_number, state: prData.state },
              'PR no longer open, stopping watch',
            );
            continue;
          }

          // Get review comments
          const comments = ghApi(
            `repos/${pr.repo}/pulls/${pr.pr_number}/comments`,
          ) as Array<{
            id: number;
            path: string;
            line: number | null;
            user: { login: string };
            body: string;
          }> | null;

          if (!comments || !Array.isArray(comments)) {
            updateWatchedPr(pr.repo, pr.pr_number, {
              last_checked_at: new Date().toISOString(),
            });
            continue;
          }

          // Filter to new comments (id > last_comment_id) and not from bot
          const botUser = deps.botGitHubUser;
          const newComments = comments.filter(
            (c) =>
              (pr.last_comment_id === null || c.id > pr.last_comment_id) &&
              (!botUser || c.user.login !== botUser),
          );

          if (newComments.length === 0) {
            updateWatchedPr(pr.repo, pr.pr_number, {
              last_checked_at: new Date().toISOString(),
            });
            continue;
          }

          // Find the max comment ID for watermark
          const maxCommentId = Math.max(...newComments.map((c) => c.id));
          const branch = prData.head?.ref || 'unknown';

          const prComments: PrComment[] = newComments.map((c) => ({
            id: c.id,
            file: c.path,
            line: c.line,
            author: c.user.login,
            body: c.body,
          }));

          const prompt = buildPrFeedbackPrompt({
            repo: pr.repo,
            pr_number: pr.pr_number,
            branch,
            url: `https://github.com/${pr.repo}/pull/${pr.pr_number}`,
            comments: prComments,
            timezone: TIMEZONE,
          });

          // Find the registered group for this PR
          const groups = deps.registeredGroups();
          const group = Object.values(groups).find(
            (g) => g.folder === pr.group_folder,
          );

          if (!group) {
            logger.warn(
              { groupFolder: pr.group_folder },
              'PR watch group not found, skipping',
            );
            continue;
          }

          const sessions = deps.getSessions();
          const sessionId = sessions[pr.group_folder];

          // Enqueue via GroupQueue for concurrency control
          const taskId = `pr-feedback-${pr.repo}-${pr.pr_number}-${Date.now()}`;
          deps.queue.enqueueTask(pr.chat_jid, taskId, async () => {
            const isMain = group.isMain === true;

            let closeTimer: ReturnType<typeof setTimeout> | null = null;
            const CLOSE_DELAY_MS = 10000;

            const scheduleClose = () => {
              if (closeTimer) return;
              closeTimer = setTimeout(() => {
                deps.queue.closeStdin(pr.chat_jid);
              }, CLOSE_DELAY_MS);
            };

            try {
              await runContainerAgent(
                group,
                {
                  prompt,
                  sessionId,
                  groupFolder: pr.group_folder,
                  chatJid: pr.chat_jid,
                  isMain,
                  isScheduledTask: true,
                  assistantName: 'Jarvis',
                },
                (proc, containerName) =>
                  deps.onProcess(pr.chat_jid, proc, containerName, pr.group_folder),
                async (streamedOutput: ContainerOutput) => {
                  if (streamedOutput.result) {
                    await deps.sendMessage(pr.chat_jid, streamedOutput.result);
                    scheduleClose();
                  }
                  if (streamedOutput.status === 'success') {
                    deps.queue.notifyIdle(pr.chat_jid);
                    scheduleClose();
                  }
                },
              );
            } finally {
              if (closeTimer) clearTimeout(closeTimer);
            }
          });

          // Update watermark
          updateWatchedPr(pr.repo, pr.pr_number, {
            last_comment_id: maxCommentId,
            last_checked_at: new Date().toISOString(),
          });

          logger.info(
            { repo: pr.repo, pr: pr.pr_number, newComments: newComments.length },
            'Enqueued PR feedback processing',
          );
        } catch (err) {
          logger.error(
            { repo: pr.repo, pr: pr.pr_number, err },
            'Error polling PR',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in PR watcher loop');
    }

    setTimeout(loop, PR_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetPrWatcherForTests(): void {
  watcherRunning = false;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/pr-watcher.test.ts`
Expected: PASS

- [ ] **Step 6: Wire PR watcher into index.ts**

In `src/index.ts`, add import after the scheduler import (line 61):

```typescript
import { startPrWatcher } from './pr-watcher.js';
```

Then after the `startSchedulerLoop()` call (after line 647), add:

```typescript
  startPrWatcher({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send PR message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    botGitHubUser: process.env.GIT_AUTHOR_NAME || undefined,
  });
```

- [ ] **Step 7: Run full tests and build**

Run: `npm test && npm run build`
Expected: All tests pass, build succeeds

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/pr-watcher.ts src/pr-watcher.test.ts src/index.ts
git commit -m "feat: add PR watcher module for polling review feedback"
```

---

### Task 6: PR Review Container Skill

**Files:**
- Create: `container/skills-catalog/local/pr-review/SKILL.md`
- Modify: `container/skills-catalog/catalog.json`

- [ ] **Step 1: Create PR review skill**

Create `container/skills-catalog/local/pr-review/SKILL.md`:

```markdown
---
name: pr-review
description: Review GitHub PRs using structured code review methodology. Trigger when asked to review a PR or given a PR URL to review.
---

# PR Review

When asked to review a PR, follow this workflow:

## 1. Get the PR

```bash
# Clone if needed
gh repo clone {owner}/{repo} /workspace/group/repos/{owner}/{repo} 2>/dev/null || true
cd /workspace/group/repos/{owner}/{repo}

# Fetch and checkout the PR
gh pr checkout {number}

# Get the diff
gh pr diff {number} > /tmp/pr-diff.txt
```

## 2. Review the Code

Use the `requesting-code-review` skill methodology. Review the diff for:

**Code Quality:** Clean separation of concerns, proper error handling, type safety, DRY, edge cases
**Architecture:** Sound design decisions, scalability, performance, security
**Testing:** Tests actually test logic, edge cases covered, integration tests where needed
**Requirements:** Does the PR accomplish what it claims?

For large diffs (>5000 lines), review file-by-file rather than the full diff at once.

## 3. Post the Review

Map your findings to a GitHub review action:

- **Critical or Important issues found** → request changes:
  ```bash
  gh pr review {number} --request-changes --body "review summary here"
  ```

- **Only Minor issues** → comment:
  ```bash
  gh pr review {number} --comment --body "review summary here"
  ```

- **No issues (clean)** → approve:
  ```bash
  gh pr review {number} --approve --body "review summary here"
  ```

### Inline Comments

For file-specific feedback, post inline comments:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments \
  -f body="suggestion here" \
  -f path="src/file.ts" \
  -F line=42 \
  -f commit_id="$(gh pr view {number} --json headRefOid -q .headRefOid)"
```

## 4. Auth Scope

If you get a 403 or permission error when posting a review, the `GH_TOKEN` likely doesn't have access to that repo. In that case:
- Notify the user via `send_message` with the review summary instead
- Explain that you couldn't post directly due to permissions

## 5. Optional: Watch the PR

After reviewing, offer to watch the PR for follow-up changes:

```bash
echo '{"type": "watch_pr", "repo": "{owner}/{repo}", "pr_number": {number}, "source": "manual"}' > /workspace/ipc/prs/watch_$(date +%s).json
```
```

- [ ] **Step 2: Add pr-review to catalog.json**

In `container/skills-catalog/catalog.json`, add a new entry in the `skills` array (before the closing `]`):

```json
    {
      "name": "pr-review",
      "source": "local",
      "description": "Review GitHub PRs using structured code review methodology. Trigger when asked to review a PR or given a PR URL to review.",
      "categories": [
        "coding"
      ],
      "path": "/skills-catalog/local/pr-review"
    }
```

- [ ] **Step 3: Run build to verify no issues**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add container/skills-catalog/local/pr-review/SKILL.md container/skills-catalog/catalog.json
git commit -m "feat: add PR review container skill"
```

---

### Task 7: Integration Verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Verify CLAUDE.md files are clean**

Read `groups/global/CLAUDE.md` and verify:
- No Discord formatting section
- Autonomy model section present
- All other sections intact

Read `groups/main/CLAUDE.md` and verify:
- No WhatsApp formatting section
- All other sections intact

- [ ] **Step 4: Verify catalog.json is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('container/skills-catalog/catalog.json', 'utf-8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 5: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: integration verification fixes"
```
