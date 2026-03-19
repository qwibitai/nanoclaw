# PR Operations & Context Cleanup Design

## Overview

Three changes to NanoClaw:

1. **PR review feedback response** — poll watched PRs for new review comments, triage by severity, auto-fix simple issues, ask user about substantive feedback
2. **PR review capability** — review PRs on demand using superpowers code-reviewer methodology, post results on GitHub
3. **CLAUDE.md context cleanup** — move channel-specific formatting out of CLAUDE.md into runtime prompt injection

All three are connected by a foundational change: **making superpowers skills available to all container agents by default**.

---

## 1. Enable Superpowers for All Groups

### What

Superpowers skills are already in the catalog (`container/skills-catalog/plugins/superpowers/`) with category `"coding"`. The default group skills list is `["general"]`, so most groups don't receive them. Change the default so all groups get superpowers.

### How

Add `"coding"` to the default skills list in `src/types.ts` (line 43), changing the default from `["general"]` to `["general", "coding"]`. This means all groups receive superpowers skills (brainstorming, TDD, debugging, verification, code review, etc.) without any catalog changes.

### Autonomy Model

Add a section to `groups/global/CLAUDE.md` establishing the "design with me, execute alone" rule:

- **Design/plan approval** → send to user via `send_message`, wait for response
- **Execution decisions** (TDD, debugging, verification, code review) → autonomous
- **Stuck or uncertain** → ask user via `send_message`

The agent sends designs/plans to the user's chat for approval, then executes autonomously once approved.

---

## 2. PR Watch System

### Data Model

New `watched_prs` table in SQLite (`src/db.ts`):

```sql
CREATE TABLE watched_prs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  group_folder TEXT NOT NULL,
  chat_jid TEXT NOT NULL,               -- group's chat JID (needed for GroupQueue.enqueueTask)
  source TEXT NOT NULL DEFAULT 'manual', -- 'auto' or 'manual'
  status TEXT DEFAULT 'active',          -- 'active', 'merged', 'closed', 'unwatched'
  last_checked_at TEXT,
  last_comment_id INTEGER,              -- GitHub comment ID watermark (numeric)
  created_at TEXT NOT NULL,
  UNIQUE(repo, pr_number)
);
```

Note: `last_comment_id` is `INTEGER` because GitHub comment IDs are numeric. String comparison of numeric IDs produces wrong results for different lengths.

### How PRs Get Added

**Auto-track:** Container agent runs `gh pr create` → writes IPC message:
```json
{ "type": "watch_pr", "repo": "owner/repo", "pr_number": 42 }
```
Host IPC watcher (`src/ipc.ts`) adds to `watched_prs` table with `source: "auto"`. The `group_folder` is derived from the IPC directory namespace (each group's IPC directory is at `data/ipc/{group_folder}/`), matching the existing authorization pattern.

**Manual watch:** User sends PR URL in chat → container agent parses URL → writes same IPC message.

**Unwatch:** Container writes `{ "type": "unwatch_pr", "repo": "owner/repo", "pr_number": 42 }`. Sets status to `"unwatched"`.

### IPC Authorization

Follows the existing pattern in `src/ipc.ts`:
- The `group_folder` is determined by the IPC directory the file was written to (tamper-proof — containers can only write to their own IPC namespace)
- Any group can watch/unwatch PRs — the `group_folder` is always set to the writing group
- Main group can additionally unwatch PRs belonging to other groups

IPC files go in a new `prs/` subdirectory: `data/ipc/{group}/prs/*.json`. The IPC watcher adds a fourth scan block in `processIpcFiles()` following the same pattern as `messages/`, `tasks/`, and `files/` blocks

### Polling (`src/pr-watcher.ts`)

New module, started from `main()` in `src/index.ts`. Runs on a timer (default: 5 minutes, configurable via `PR_POLL_INTERVAL` in `src/config.ts`).

For each active watched PR:

1. `gh api repos/{owner}/{repo}/pulls/{number}` — check state (open/merged/closed)
2. If merged/closed → update status, skip to next PR
3. `gh api repos/{owner}/{repo}/pulls/{number}/comments` — get inline review comments
4. Filter: `id > last_comment_id` AND author is not the bot's git identity
5. If new comments found → spawn container via `GroupQueue.enqueueTask()` (not `runContainerAgent` directly — uses the existing concurrency control)
6. Update `last_checked_at` and `last_comment_id` after each PR

**Rate limiting:** GitHub allows 5000 requests/hour. Each PR poll cycle uses 2 API calls. With a 5-minute interval, the system supports ~200 active watched PRs before hitting limits. If the watched PR count exceeds 100, log a warning.

### Container Spawning

The PR watcher spawns containers through `GroupQueue.enqueueTask()`, the same path used by `task-scheduler.ts`. This ensures:
- Concurrency limits are respected
- Per-group queuing works correctly
- No special container spawning code needed

The prompt is passed directly (not through `formatMessages()` — no channel formatting needed):

```xml
<context timezone="..." />
<pr_feedback>
  <pr repo="owner/repo" number="42" branch="feature-x" url="https://github.com/owner/repo/pull/42" />
  <review_comments>
    <comment id="123" file="src/foo.ts" line="42" author="reviewer">
      Consider using a Map here instead of object lookup for type safety.
    </comment>
  </review_comments>
</pr_feedback>

Instructions:
- The repo should be cloned at /workspace/group/repos/owner/repo. If not, clone it first.
- Check out the PR branch: gh pr checkout 42
- Triage each comment:
  - Simple (typos, naming, formatting, single-file nits): fix, commit, push, reply on GitHub
  - Substantive (design, logic, multi-file): summarize and ask user via send_message before acting
- After fixing simple issues, notify user: "Fixed N nits on PR #42, pushed commit abc123"
```

**Session management:** PR feedback processing uses the group's existing session ID for continuity — the agent can reference prior PR context from the same group.

### Lifecycle

- PRs are polled while `status = 'active'`
- When merged/closed (detected during polling) → status updated, polling stops
- User can unwatch via chat: "stop watching PR #42" → agent writes `unwatch_pr` IPC message

---

## 3. PR Review Capability

### Trigger

User sends a PR URL in chat: "review https://github.com/foo/bar/pull/123"

### Container Skill

Thin glue skill at `container/skills-catalog/local/pr-review/SKILL.md` in the `coding` category (matching existing `github-ops` skill). It tells the agent how to apply the superpowers `requesting-code-review` methodology to a GitHub PR:

1. Clone the repo (or use existing clone in `/workspace/group/repos/`)
2. Fetch the PR: `gh pr checkout {number}`
3. Get the diff: `gh pr diff {number}`
4. Use the superpowers `requesting-code-review` skill methodology — the agent already has this skill loaded via the `coding` category
5. Post review on GitHub, mapping severity to action:
   - Critical or Important issues → `gh pr review --request-changes`
   - Minor issues only → `gh pr review --comment`
   - Clean → `gh pr review --approve`
6. Post inline comments on specific lines via `gh api repos/{owner}/{repo}/pulls/{number}/comments`

**Large diffs:** If `gh pr diff` output exceeds 5000 lines, the skill instructs the agent to review file-by-file rather than the full diff at once.

**Auth scope:** The skill notes that `GH_TOKEN` must have repo access for the target repository. For third-party repos where the bot lacks push/review access, the agent should notify the user and provide the review as a chat message instead.

### Optional Watch

After reviewing, the agent offers to add the PR to the watch list via `watch_pr` IPC message.

---

## 4. CLAUDE.md Context Cleanup

### Problem

`groups/global/CLAUDE.md` contains Discord formatting rules. `groups/main/CLAUDE.md` contains WhatsApp formatting rules. Every container loads these regardless of context — a PR feedback agent gets Discord formatting rules it will never use.

### Solution

Move channel-specific formatting into runtime prompt injection.

### Channel Interface Change

Add optional property to `Channel` interface in `src/types.ts`:

```typescript
interface Channel {
  name: string;
  formattingInstructions?: string;
  // ... existing methods
}
```

Each channel module sets its formatting rules as a string property on the channel instance.

### Prompt Injection

`formatMessages()` in `src/router.ts` gains an optional `channel` parameter (backward compatible — omitting it produces the same output as before). When a channel with `formattingInstructions` is provided, the rules are injected:

```xml
<context timezone="America/New_York" channel="discord" />
<channel_formatting>
Discord formatting rules here...
</channel_formatting>
<messages>
  ...
</messages>
```

**Callers:**
- `src/index.ts` line 184 and 444 — both have access to the channel via `findChannel()`, pass it through
- `formatMessages` is re-exported from `src/index.ts` — the `channel` parameter is optional, so existing external consumers are unaffected
- Task scheduler and PR watcher call `runContainerAgent()` directly with a prompt string, bypassing `formatMessages()` — no formatting injection, which is correct

### Cleanup

- Remove "Message Formatting" section (Discord rules) from `groups/global/CLAUDE.md`
- Remove "WhatsApp Formatting" section from `groups/main/CLAUDE.md`
- Global CLAUDE.md retains: agent identity, capabilities, communication rules, memory, workspace, skills catalog, GitHub instructions
- Add autonomy model section to global CLAUDE.md (from Section 1)

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/types.ts` | Add `formattingInstructions` to Channel interface; change default skills to `["general", "coding"]` |
| `src/db.ts` | Add `watched_prs` table schema, CRUD functions (addWatchedPr, getActiveWatchedPrs, updateWatchedPr, unwatchPr) |
| `src/pr-watcher.ts` | New module: polling loop, GitHub API calls, container spawning via GroupQueue |
| `src/ipc.ts` | Handle `watch_pr` and `unwatch_pr` IPC types in `prs/` subdirectory |
| `src/index.ts` | Start PR watcher on startup; pass channel to `formatMessages()` calls |
| `src/router.ts` | Add optional `channel` parameter to `formatMessages()`; inject `<channel_formatting>` when present |
| `src/config.ts` | Add `PR_POLL_INTERVAL` constant (default: 5 minutes) |
| `groups/global/CLAUDE.md` | Remove Discord formatting section; add autonomy model section |
| `groups/main/CLAUDE.md` | Remove WhatsApp formatting section |
| `container/skills-catalog/local/pr-review/SKILL.md` | New: PR review glue skill (github category) |
| `container/skills-catalog/catalog.json` | Add pr-review entry |

---

## Dependencies & Order

```
1. Enable superpowers for all groups (one-line default change + autonomy model in CLAUDE.md)
2. CLAUDE.md cleanup (independent, can parallel with 1)
3. PR watch system (can parallel with 1 and 2 — just needs db + ipc + watcher)
4. PR review skill (depends on 3 for watch_pr IPC, but the review itself is independent)
```
