# Email Triage v2 — Repo-Aware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the triage classifier which email belongs to which of your local git repos, and — when confident — append extracted facts into that repo's `docs/inbox/` directory as a commit on a branch, pushed upstream.

**Architecture:** Add a repo profile index (auto-scanned from `~/dev/*/`, stored in Weaviate/Qdrant), a 5-signal repo resolver, a "which repo?" Telegram fallback when confidence is low, and a new `docs-inbox-commit` action tier invoked from the triage worker. Ships behind `TRIAGE_V2_REPO_RESOLUTION=false` so v1 users can enable independently.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, Vitest, `simple-git` (or `execFile('git', ...)` — match existing patterns), existing `storeFactWithVector` for profile embeddings.

**Reference spec:** [2026-04-16-email-triage-pipeline-design.md](../specs/2026-04-16-email-triage-pipeline-design.md) §"Repo Resolution (v2)" and §"Action Tiers → Tier 2".

**Depends on v1 being live and stable.** Do not merge this branch until `TRIAGE_V1_ENABLED=1 TRIAGE_SHADOW_MODE=0` has run cleanly for ≥ 14 days with agreement rate ≥ 80%.

---

## Pre-work

- [ ] **Step 0.1:** Verify v1 is in production and stable. Run `sqlite3 data/nanoclaw.db "SELECT COUNT(*) FROM triage_examples;"` — should be > 100 entries. If less, pause and collect more data before investing in v2.
- [ ] **Step 0.2:** Confirm `storeFactWithVector` + corresponding query function exist in `src/memory/knowledge-store.ts`. Read the file to learn the exact query API.
- [ ] **Step 0.3:** Check whether `simple-git` is already a dependency: `grep simple-git package.json`. If yes, use it. If not, use `child_process.execFile` with `git` binary.

---

## Task 1: Repo profile schema + storage

**Files:**
- Create: `src/triage/repo-profile.ts`
- Test: `src/__tests__/triage-repo-profile.test.ts`

Define the `RepoProfile` interface and SQLite storage (separate from Weaviate — SQLite holds the structured profile, Weaviate holds the embedding for fuzzy match).

- [ ] **Step 1.1: Add `triage_repo_profiles` table in `src/db.ts`**

Append to the migration section:

```typescript
db.prepare(
  `CREATE TABLE IF NOT EXISTS triage_repo_profiles (
    repo TEXT PRIMARY KEY,
    absolute_path TEXT NOT NULL,
    description TEXT,
    keywords_json TEXT NOT NULL,
    top_filepaths_json TEXT NOT NULL,
    recent_commits_json TEXT NOT NULL,
    github_url TEXT,
    claude_md TEXT,
    readme_excerpt TEXT,
    last_indexed_at INTEGER NOT NULL,
    auto_fix_allowed INTEGER NOT NULL DEFAULT 0
  )`,
).run();
```

- [ ] **Step 1.2: Write failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';
import { upsertRepoProfile, listRepoProfiles, getRepoProfile } from '../triage/repo-profile.js';

describe('repo profile store', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('upserts and retrieves a profile', () => {
    upsertRepoProfile({
      repo: 'nanoclaw',
      absolutePath: '/Users/x/dev/nanoclaw',
      description: 'personal assistant',
      keywords: ['telegram', 'email'],
      topFilepaths: ['src/index.ts'],
      recentCommits: ['feat: a', 'fix: b'],
      githubUrl: 'https://github.com/x/nanoclaw',
      claudeMd: null,
      readmeExcerpt: null,
      autoFixAllowed: true,
    });
    const p = getRepoProfile('nanoclaw');
    expect(p?.keywords).toEqual(['telegram', 'email']);
    expect(p?.autoFixAllowed).toBe(true);
  });
});
```

- [ ] **Step 1.3: Implement `src/triage/repo-profile.ts`**

```typescript
import { getDb } from '../db.js';

export interface RepoProfile {
  repo: string;
  absolutePath: string;
  description: string | null;
  keywords: string[];
  topFilepaths: string[];
  recentCommits: string[];
  githubUrl: string | null;
  claudeMd: string | null;
  readmeExcerpt: string | null;
  lastIndexedAt: number;
  autoFixAllowed: boolean;
}

export function upsertRepoProfile(
  p: Omit<RepoProfile, 'lastIndexedAt'> & { lastIndexedAt?: number },
): void {
  const now = p.lastIndexedAt ?? Date.now();
  getDb()
    .prepare(
      `INSERT INTO triage_repo_profiles
       (repo, absolute_path, description, keywords_json, top_filepaths_json,
        recent_commits_json, github_url, claude_md, readme_excerpt,
        last_indexed_at, auto_fix_allowed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET
         absolute_path = excluded.absolute_path,
         description = excluded.description,
         keywords_json = excluded.keywords_json,
         top_filepaths_json = excluded.top_filepaths_json,
         recent_commits_json = excluded.recent_commits_json,
         github_url = excluded.github_url,
         claude_md = excluded.claude_md,
         readme_excerpt = excluded.readme_excerpt,
         last_indexed_at = excluded.last_indexed_at,
         auto_fix_allowed = excluded.auto_fix_allowed`,
    )
    .run(
      p.repo,
      p.absolutePath,
      p.description,
      JSON.stringify(p.keywords),
      JSON.stringify(p.topFilepaths),
      JSON.stringify(p.recentCommits),
      p.githubUrl,
      p.claudeMd,
      p.readmeExcerpt,
      now,
      p.autoFixAllowed ? 1 : 0,
    );
}

export function getRepoProfile(repo: string): RepoProfile | null {
  const row = getDb()
    .prepare(`SELECT * FROM triage_repo_profiles WHERE repo = ?`)
    .get(repo) as Record<string, unknown> | undefined;
  if (!row) return null;
  return deserialize(row);
}

export function listRepoProfiles(): RepoProfile[] {
  const rows = getDb()
    .prepare(`SELECT * FROM triage_repo_profiles`)
    .all() as Record<string, unknown>[];
  return rows.map(deserialize);
}

function deserialize(row: Record<string, unknown>): RepoProfile {
  return {
    repo: row.repo as string,
    absolutePath: row.absolute_path as string,
    description: (row.description as string | null) ?? null,
    keywords: JSON.parse((row.keywords_json as string) ?? '[]'),
    topFilepaths: JSON.parse((row.top_filepaths_json as string) ?? '[]'),
    recentCommits: JSON.parse((row.recent_commits_json as string) ?? '[]'),
    githubUrl: (row.github_url as string | null) ?? null,
    claudeMd: (row.claude_md as string | null) ?? null,
    readmeExcerpt: (row.readme_excerpt as string | null) ?? null,
    lastIndexedAt: row.last_indexed_at as number,
    autoFixAllowed: (row.auto_fix_allowed as number) === 1,
  };
}
```

- [ ] **Step 1.4: Run test; commit**

```bash
npm test -- triage-repo-profile
git add src/db.ts src/triage/repo-profile.ts src/__tests__/triage-repo-profile.test.ts
git commit -m "feat(triage-v2): repo profile schema + SQLite store"
```

---

## Task 2: Thread → repo mapping table

**Files:**
- Modify: `src/db.ts` (add `triage_thread_repo_map` table)
- Create: `src/triage/thread-map.ts`
- Test: `src/__tests__/triage-thread-map.test.ts`

Persistent store of confirmed thread → repo associations. Populated by Signal 5 (user answers "which repo?").

- [ ] **Step 2.1: Migration**

```typescript
db.prepare(
  `CREATE TABLE IF NOT EXISTS triage_thread_repo_map (
    thread_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    confidence REAL NOT NULL,
    confirmed_by_user INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
).run();
```

- [ ] **Step 2.2: Write test, implement `src/triage/thread-map.ts` with:**
- `setThreadRepo(threadId, repo, { confidence, confirmedByUser })`
- `getThreadRepo(threadId): { repo, confidence, confirmedByUser } | null`

Test cases:
- Round-trip: set then get returns same values
- Upsert: second set overrides first
- User confirmation upgrades confidence to 1.0

- [ ] **Step 2.3: Commit**

```bash
git add src/db.ts src/triage/thread-map.ts src/__tests__/triage-thread-map.test.ts
git commit -m "feat(triage-v2): thread\u2192repo persistent mapping"
```

---

## Task 3: Repo index scanner — `scripts/build-repo-index.ts`

**Files:**
- Create: `scripts/build-repo-index.ts`
- No test (one-off CLI script)

Scans `~/dev/*/` and populates `triage_repo_profiles` + Weaviate/Qdrant embeddings.

### Steps

- [ ] **Step 3.1:** Script flags: `--dir <root>` (default `$HOME/dev`), `--active-days <n>` (default 90), `--dry-run`, `--force` (re-index even if `last_indexed_at` is recent).

- [ ] **Step 3.2:** For each subdirectory of `--dir`:
  - Skip if not a git repo (`test -d <dir>/.git`)
  - Skip if last commit date is older than `--active-days`
  - Extract:
    - `repo` = basename of dir
    - `description` from `package.json` or `pyproject.toml` if present
    - `keywords` from package metadata + top-level filenames
    - `topFilepaths` = 20 most-common file paths by `find -type f -not -path '*/node_modules/*' -not -path '*/.git/*'`
    - `recentCommits` = `git log -30 --pretty=%s`
    - `githubUrl` from `git remote get-url origin`
    - `claudeMd` = contents of `CLAUDE.md` if exists
    - `readmeExcerpt` = first 500 chars of `README.md` if exists
  - Call `upsertRepoProfile(...)` unless `--dry-run`
  - Call `storeFactWithVector({ text: <summary>, domain: 'repo_profile', groupId: repo, source: 'scan' })` for fuzzy-match

- [ ] **Step 3.3:** `--dry-run` prints what it would index.

- [ ] **Step 3.4:** Add `"triage:index-repos": "tsx scripts/build-repo-index.ts"` to `package.json`.

- [ ] **Step 3.5:** Commit

```bash
git add scripts/build-repo-index.ts package.json
git commit -m "feat(triage-v2): repo index scanner"
```

---

## Task 4: User-confirmation flow for extracted profiles

**Files:**
- Modify: `scripts/build-repo-index.ts` (or create `scripts/triage-confirm-repos.ts`)
- Create: `src/triage/repo-confirm.ts` (interactive Telegram flow — can be skipped if user opts to edit the DB directly)

At first-run, Telegram message with top 12 active repos asking for:
1. Which repos to enable auto-fix for (sets `auto_fix_allowed = 1`)
2. Aliases ("the email thing" → superpilot) — add to the `keywords` array
3. Sender → repo mappings (stored separately in `triage_sender_repo_map`)

### Steps

- [ ] **Step 4.1:** Add `triage_sender_repo_map` table:

```sql
CREATE TABLE IF NOT EXISTS triage_sender_repo_map (
  sender_pattern TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

- [ ] **Step 4.2:** Interactive flow — two options:
  - **A (preferred):** post a Telegram message listing the 12 repos with inline buttons `[Enable auto-fix] [Skip]`. User taps through. Fast.
  - **B (fallback):** print profiles to stdout with edit instructions (`npm run triage:index-repos -- --edit`). User edits a generated YAML file; script re-ingests.

Task 4's test scope is limited — manual flow. Ship the script + minimal structured output; defer test coverage until the UX stabilizes.

- [ ] **Step 4.3:** Commit

```bash
git add src/db.ts src/triage/repo-confirm.ts scripts/build-repo-index.ts
git commit -m "feat(triage-v2): interactive repo profile confirmation"
```

---

## Task 5: Repo resolver — 5-signal scoring

**Files:**
- Create: `src/triage/repo-resolver.ts`
- Test: `src/__tests__/triage-repo-resolver.test.ts`

Implements the scoring logic from the spec:

```
score = 1.0*explicit + 0.8*sender + 0.6*thread + 0.4*keyword
if top.score ≥ 0.8 and gap_to_second ≥ 0.3 → dispatch(top.repo)
else → attention with candidates
```

- [ ] **Step 5.1:** Define types:

```typescript
export interface ResolveInput {
  emailBody: string;
  sender: string;
  subject: string;
  headers: Record<string, string>;
  threadId: string;
}

export interface ResolveCandidate {
  repo: string;
  score: number;
  signals: string[];  // which signals fired, e.g. ['explicit:url', 'sender:github']
}

export interface ResolveResult {
  confident: boolean;
  top: ResolveCandidate | null;
  candidates: ResolveCandidate[];
}
```

- [ ] **Step 5.2: Implement each signal as a pure function**
  - `signalExplicit(input, profiles): Map<repo, score>` — GitHub URL matches, literal keyword matches, stack-trace filepath matches
  - `signalSender(input, senderMap): Map<repo, score>` — check `triage_sender_repo_map` + known patterns (`X-GitHub-Repository` header, Sentry project, Dependabot subject)
  - `signalThread(input, threadMap): Map<repo, score>` — lookup in `triage_thread_repo_map`
  - `signalKeyword(input, profiles): Map<repo, score>` — embed email body via `storeFactWithVector`'s search helper (or equivalent), retrieve top-K closest repo profiles

- [ ] **Step 5.3:** Implement `resolveRepo(input): Promise<ResolveResult>` that combines signals, applies weights, and returns sorted candidates.

- [ ] **Step 5.4:** Tests — at minimum:
  - Single explicit URL → high confidence match
  - Sender pattern match + thread map agreement → high confidence
  - All signals weak → not confident, candidates empty or low-score
  - Two repos tied → not confident (gap < 0.3)

- [ ] **Step 5.5:** Commit

```bash
git add src/triage/repo-resolver.ts src/__tests__/triage-repo-resolver.test.ts
git commit -m "feat(triage-v2): 5-signal repo resolver with confidence gate"
```

---

## Task 6: Wire resolver into triage worker

**Files:**
- Modify: `src/triage/worker.ts`
- Modify: `src/triage/schema.ts` (populate `repo_candidates` from resolver, not LLM)
- Test: extend `src/__tests__/triage-worker.test.ts`

The classifier LLM currently returns `repo_candidates: []` (stubbed in v1). In v2, the worker calls `resolveRepo()` AFTER the classifier returns, and overwrites `repo_candidates` on the decision before persisting.

- [ ] **Step 6.1:** Add `resolveRepo` call in worker after classify, before UPDATE:

```typescript
if (TRIAGE_V2_ENABLED) {
  const resolver = await import('./repo-resolver.js');
  const result = await resolver.resolveRepo({
    emailBody: input.emailBody,
    sender: input.sender,
    subject: input.subject,
    headers: {},                  // v1 doesn't carry headers; extend SSE later
    threadId: input.threadId,
  });
  decision.repo_candidates = result.candidates;
  if (result.confident && result.top) {
    // stamp resolved repo for downstream actions
    decision.repo_resolved = result.top.repo;
  }
}
```

Note: `decision.repo_resolved` is a new optional field — extend `TriageDecision` in `src/triage/schema.ts`.

- [ ] **Step 6.2:** Add `TRIAGE_V2_REPO_RESOLUTION` flag to `src/triage/config.ts`:

```typescript
v2RepoResolution: envBool('TRIAGE_V2_REPO_RESOLUTION', false),
```

Guard the resolver call with this flag.

- [ ] **Step 6.3:** Extend tests: resolver returns confident top → worker persists `repo_resolved`; resolver returns not-confident → `repo_candidates` populated but `repo_resolved` null.

- [ ] **Step 6.4:** Commit

```bash
git add src/triage/worker.ts src/triage/schema.ts src/triage/config.ts src/__tests__/triage-worker.test.ts
git commit -m "feat(triage-v2): wire repo resolver into worker"
```

---

## Task 7: "Which repo?" button UX when confidence below threshold

**Files:**
- Modify: `src/triage/push-attention.ts` (add optional repo-candidate buttons)
- Modify: `src/callback-router.ts` (add `triage:which_repo:<repo>:<itemId>` handler)
- Create: `src/triage/queue-actions.ts` → add `handleWhichRepo(itemId, repo)` which writes to `triage_thread_repo_map` with `confirmed_by_user=1`
- Test: extend `src/__tests__/triage-queue-actions.test.ts`

When the worker classifies `queue=attention` AND the resolver's top candidate exists but confidence was below threshold, the push message includes two extra buttons: `[This is <top.repo>]` and `[Neither]`. Clicking writes to `triage_thread_repo_map`.

- [ ] **Step 7.1: Extend `pushAttentionItem` signature**

Add optional `repoCandidates?: ResolveCandidate[]` parameter. When present and non-empty, append up to 2 buttons before the existing action row.

- [ ] **Step 7.2: Register handler**

```typescript
case 'triage': {
  // ... existing sub-action dispatch
  if (subAction === 'which_repo') {
    handleWhichRepo(itemId, repo);
  }
}
```

Callback format: `triage:which_repo:<repo>:<itemId>`.

- [ ] **Step 7.3: `handleWhichRepo`**

```typescript
export function handleWhichRepo(itemId: string, repo: string): void {
  const item = getItem(itemId);
  if (!item?.thread_id) return;

  setThreadRepo(item.thread_id, repo, { confidence: 1.0, confirmedByUser: true });

  // Also update the item's repo_candidates to reflect confirmation
  getDb()
    .prepare(`UPDATE tracked_items SET repo_candidates_json = ? WHERE id = ?`)
    .run(JSON.stringify([{ repo, score: 1.0, signal: 'user_confirmed' }]), itemId);
}
```

- [ ] **Step 7.4:** Tests: simulate callback; verify `triage_thread_repo_map` row created with `confirmed_by_user=1`.

- [ ] **Step 7.5:** Commit

```bash
git add src/triage/push-attention.ts src/triage/queue-actions.ts src/callback-router.ts src/__tests__/triage-queue-actions.test.ts
git commit -m "feat(triage-v2): 'which repo?' fallback UX"
```

---

## Task 8: Docs-inbox commit action

**Files:**
- Create: `src/triage/docs-inbox.ts`
- Test: `src/__tests__/triage-docs-inbox.test.ts`

When `repo_resolved` is set AND `facts_extracted` is non-empty AND auto-fix is NOT allowed (auto-fix is v3), append extracted facts to the resolved repo's `docs/inbox/YYYY-MM-DD-<slug>.md`, commit on a branch `triage/<date>-<slug>`, and push.

### Steps

- [ ] **Step 8.1:** `appendDocsInbox(input)` signature:

```typescript
export interface DocsInboxInput {
  repo: string;                  // logical repo name
  absolutePath: string;          // worktree path
  subject: string;
  sender: string;
  threadId: string;
  account: string;
  classificationId: string;
  facts: ExtractedFact[];
  pushUpstream: boolean;         // gated on env
}
```

- [ ] **Step 8.2:** Flow:
  1. `git -C <absolutePath> rev-parse HEAD` to confirm it's a git repo
  2. `git -C <absolutePath> checkout -B triage/<date>-<slug>` (slug = subject slugified, date = YYYY-MM-DD)
  3. `mkdir -p <absolutePath>/docs/inbox`
  4. Write `<absolutePath>/docs/inbox/<date>-<slug>.md` with fact table + metadata header
  5. `git -C <absolutePath> add docs/inbox/<file>`
  6. `git -C <absolutePath> commit -m "triage: ingest <subject>"`
  7. If `pushUpstream`: `git -C <absolutePath> push -u origin triage/<date>-<slug>` (CAREFUL — network action; gate on env `TRIAGE_V2_PUSH_UPSTREAM=0` default)
  8. Return `{ branch, commitSha, file }`

- [ ] **Step 8.3:** Guardrails (enforce in code):
  - Never touch `main` / `master` / any branch not matching `^triage/`
  - If the target repo has uncommitted changes, abort and log warning (do not stash — could destroy work)
  - If branch already exists with the same name, append a numeric suffix

- [ ] **Step 8.4:** Tests use a temp git repo fixture:

```typescript
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

function setupTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-repo-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'test');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: dir });
  return dir;
}
```

Cover: branch created; main untouched; file written; commit made; uncommitted-changes abort; branch-already-exists suffix.

- [ ] **Step 8.5:** Commit

```bash
git add src/triage/docs-inbox.ts src/__tests__/triage-docs-inbox.test.ts
git commit -m "feat(triage-v2): docs-inbox append + branch commit + push"
```

---

## Task 9: Wire docs-inbox into worker side-effects

**Files:**
- Modify: `src/triage/worker.ts`
- Modify: `src/__tests__/triage-worker.test.ts`

After the existing facts-append-to-knowledge.md block (Task 16 in v1), add a sibling conditional: if `!shadowMode && TRIAGE_V2_REPO_RESOLUTION && decision.repo_resolved && facts_extracted.length > 0`, call `appendDocsInbox(...)`.

- [ ] **Step 9.1:** Look up the repo profile via `getRepoProfile(decision.repo_resolved)` to get `absolutePath`.
- [ ] **Step 9.2:** Gate push on `TRIAGE_V2_PUSH_UPSTREAM=1` (default false — local branch only, user pushes manually).
- [ ] **Step 9.3:** Post a Telegram message: `📄 Committed to <repo>@<branch>` with link if push succeeded.
- [ ] **Step 9.4:** Tests + commit.

---

## Task 10: Rollout runbook (v2)

**Files:**
- Create: `docs/runbooks/triage-v2-rollout.md`

Document:
1. Pre-reqs (v1 stable ≥ 14 days, agreement ≥ 80%)
2. Run `npm run triage:index-repos` and confirm output
3. Edit Telegram confirmation flow (which repos allow auto-fix, aliases, sender mappings)
4. Set `TRIAGE_V2_REPO_RESOLUTION=1` in `.env`, restart
5. Observe `#attention` for "which repo?" buttons; answer them to seed thread→repo map
6. After ~1 week of seeding, set `TRIAGE_V2_PUSH_UPSTREAM=1` to start auto-pushing docs-inbox branches
7. Monitor: branches created, no `main` modifications, PR quality of the commits themselves

---

## Final verification

- [ ] All triage-v2 tests green
- [ ] `npx tsc --noEmit` clean
- [ ] Dry-run `npm run triage:index-repos -- --dry-run` — sanity check output
- [ ] Manual test: send yourself an email that mentions a specific repo; verify classifier resolves it and posts the `#attention` message with the right repo
- [ ] Manual test: send an email that's ambiguous; verify "which repo?" buttons appear

## Open questions (for brainstorm before execution)

- Should Tier-2 `docs-inbox-commit` open a PR, or just push the branch? (Spec says commit only; PR is v3. Confirm before execution.)
- Should the resolver use the SuperPilot email `body` if SSE payload is extended by then? (v1 doesn't have it; v2 assumes it may.)
- Threshold calibration: 0.8 score + 0.3 gap — is this right for your inbox? Adjust after shadow data.

## Out of scope for v2 (reserved for v3)

- Agent-dispatch containers for auto-fix
- Security-reviewer gate on generated diffs
- Sender-allowlist-driven auto-fix PRs
- Attachment parsing (PDF/image) — if needed, add a small v2.5 task before v3
