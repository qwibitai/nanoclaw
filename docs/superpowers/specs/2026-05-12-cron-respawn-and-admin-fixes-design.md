# NanoClaw v2 — Plan 2.6: Cron Auto-Respawn + Admin Command Fixes

**Status:** spec (pre-plan)
**Author:** Jonas + Claude Opus 4.7
**Date:** 2026-05-12
**Trigger:** 3 pre-existing bugs discovered during Plan 2.5 (`docs/superpowers/plans/2026-05-12-finance-agent-plan-2-5-cron-execution.md`) execution. All 3 are in shared NanoClaw v2 code, affect ANY agent (not just finance), and were silently rotting production:
- Cron jobs were only firing ONCE because auto-respawn was broken
- Admin commands (`/clear`, `/compact`, etc) were always denied
- ISO timestamp format was making `process_after` comparisons fail

---

## 1. Problem statement

### Bug A — Admin commands always denied via every channel

Every admin command (`/clear`, `/compact`, `/context`, `/cost`, `/files`, `/remote-control`) sent to any agent always returns `"Permission denied"` — even when the sender IS in the admin role table. The fix worked through the host (`router.ts` correctly upserts users with `telegram:xxx` / `whatsapp:xxx` prefix) but breaks at the container's admin check.

### Bug B — Cron jobs only fire ONCE (no auto-respawn)

After a cron task completes, `host-sweep.handleRecurrence` should insert the next occurrence into `messages_in`. In practice this NEVER works: `logs/nanoclaw.error.log` accumulates `"Failed to compute next recurrence ... database connection is not open"` errors at ~10/min. Without manual intervention (`respawn-recurrence.ts` script), every cron job dies after its first run.

### Bug C — ISO `process_after` never compares as due

Even if Bug B is fixed, the timestamps stored by `handleRecurrence` are in ISO format (`2026-05-12T13:00:00.000Z`). SQLite's `process_after <= datetime('now')` comparison is a string compare; `'T' > ' '` in ASCII, so an ISO timestamp never satisfies the predicate until well after its intended time. Same class of bug as commit `1c20a71` (Plan 2 fix in `register-cron-jobs.ts`).

---

## 2. Root cause analysis

### Bug A

`container/agent-runner/src/formatter.ts:31` extracts:
```ts
const senderId = content.senderId || content.author?.userId || null;
```

`adminUserIds` in the container (`poll-loop.ts:105`) is populated from env `NANOCLAW_ADMIN_USER_IDS` which the host (`container-runner.ts:259`) builds from `user_roles.user_id`. The host-side `user_id` is always prefixed (`telegram:8557164566`, `whatsapp:17865189131`) because `router.ts:332` constructs it as `${userKind}:${handle}`.

But message-side, no channel adapter populates `content.senderId` consistently:
- **WhatsApp** (`src/channels/whatsapp.ts:586`): writes `content.sender = '<raw phone>'` and `content.senderName`. No `senderId`.
- **Chat SDK bridge** (`src/router.ts:309-318`): handles author info under `content.author.userId = '<raw>'`. No `senderId`.

Result: `categorizeMessage` always extracts the RAW handle (e.g. `'8557164566'`), which never matches the prefixed `adminUserIds` Set.

### Bug B

`src/host-sweep.ts:104`:
```ts
} finally {
  inDb.close();
}
```
preceded by:
```ts
// 4. Handle recurrence for completed messages
handleRecurrence(inDb, session);  // <-- not awaited
```

`handleRecurrence` is declared `async function` because it does `await import('cron-parser')` (line 159). The call on line 104 returns a Promise. JavaScript executes the function synchronously until the first `await`, then yields. `sweepSession` then continues out of the try block, runs the `finally`, and closes `inDb`. When `handleRecurrence` resumes after the dynamic import resolves, it calls `insertRecurrence(inDb, ...)` on the now-closed `inDb` — throws `TypeError: The database connection is not open`. The error is caught by the inner try/catch and logged to `nanoclaw.error.log` (stderr), which is in a separate file from the normal log. Easy to miss.

This silently fails on every sweep tick, for every completed recurring message, for every active session.

### Bug C

`src/host-sweep.ts:161`:
```ts
const nextRun = interval.next().toISOString();
```
Returns `'2026-05-13T08:00:00.000Z'`. Stored verbatim into `messages_in.process_after`.

`countDueMessages` (in `session-db.ts`) runs:
```ts
SELECT COUNT(*) FROM messages_in WHERE ... AND (process_after IS NULL OR process_after <= datetime('now'))
```

`datetime('now')` returns `'2026-05-12 13:00:00'` (note the space). SQLite's `<=` is a lexicographic string compare on TEXT columns. `'T' (0x54) > ' ' (0x20)`, so `'2026-05-13T08:00:00.000Z' <= '2026-05-12 13:00:00'` is FALSE — the row is never seen as due. The cron would never fire even if Bug B were fixed.

Commit `1c20a71` already fixed this in `scripts/finance/register-cron-jobs.ts` by writing `YYYY-MM-DD HH:MM:SS` instead. The same fix needs to land in `host-sweep.ts`.

---

## 3. Goals

Fix the three bugs in a single, minimal, well-tested change. End state:
- Admin commands work from any prefix-aware channel (WhatsApp native, Chat SDK channels, future channels).
- Recurring tasks auto-respawn after completion. Operators never run `respawn-recurrence.ts` manually.
- All `process_after` timestamps anywhere in the codebase use the SQLite-friendly UTC format.
- Test coverage prevents regression.

Stay focused: don't refactor unrelated things. Don't touch the admin role model. Don't migrate the SQLite schema.

---

## 4. Architecture

Three layers of fix, all defensive at the consumer side (no churn across channel adapters):

### Bug A — fix in `formatter.ts:categorizeMessage` (single point of normalization)

Compose `senderId` with the channel prefix when the raw value doesn't already contain `:`. Strip swarm suffixes (`telegram-finance` → `telegram`) the same way `router.ts:331` does. Works for all channels (WhatsApp native + Chat SDK + future) without modifying any adapter.

```ts
const userKind = (msg.channel_type || '').split('-')[0];
const raw = (typeof content.senderId === 'string' && content.senderId)
  || content.author?.userId
  || content.sender;
const senderId = raw
  ? (raw.includes(':') ? raw : `${userKind}:${raw}`)
  : null;
```

(Note: also reads `content.sender` for WhatsApp parity. Existing code only read `senderId || author?.userId`.)

### Bug B — make `handleRecurrence` synchronous

Remove the dynamic `await import('cron-parser')`. Top-level import. Drop `async`. The function becomes a normal sync function, completes before `finally` runs, `inDb` stays open for `insertRecurrence`.

### Bug C — replace `.toISOString()` with `toSqliteUtc()` helper

Extract the helper that already exists inline in `register-cron-jobs.ts:46` into a shared module `src/db/sqlite-utc.ts`. Both call sites import it. Single source of truth for SQLite-friendly UTC formatting.

```ts
// src/db/sqlite-utc.ts
/**
 * Format a Date as 'YYYY-MM-DD HH:MM:SS' in UTC — matches the output of
 * SQLite's datetime('now') so string comparisons like
 *   process_after <= datetime('now')
 * compare correctly. Do NOT use Date.toISOString() for process_after:
 * 'T' > ' ' in ASCII, so an ISO timestamp never satisfies the predicate
 * until well after its intended time. See commit 1c20a71 for context.
 */
export function toSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
```

### Defense-in-depth

Bug A's fix is at the consumer (formatter). If a future channel forgets to populate `senderId`, the formatter still synthesizes a correct prefix from `msg.channel_type`. Bug B+C share `handleRecurrence`: making the function sync eliminates the race; using the shared `toSqliteUtc` eliminates the timestamp drift.

---

## 5. Components

### Files modified

| File | Change |
|---|---|
| `container/agent-runner/src/formatter.ts` | `categorizeMessage`: compose `senderId` with `${userKind}:${raw}` when raw lacks `:`. Strip swarm suffix via `.split('-')[0]`. Also read `content.sender` (WhatsApp fallback). ~7 lines changed. |
| `container/agent-runner/src/formatter.test.ts` | Add `describe('categorizeMessage senderId normalization')` with 5 tests (WhatsApp native, Chat SDK no swarm, Chat SDK swarm-suffix, already-prefixed, empty content). |
| `src/host-sweep.ts` | (a) Top-level `import { CronExpressionParser } from 'cron-parser';` (b) Top-level `import { toSqliteUtc } from './db/sqlite-utc.js';` (c) `handleRecurrence` no longer `async`; remove dynamic import; remove `await`. (d) `nextRun = toSqliteUtc(interval.next().toDate())`. (e) Export `handleRecurrence` for testing. |
| `scripts/finance/register-cron-jobs.ts` | Replace local inline `toSqliteUtc` (lines ~46) with `import { toSqliteUtc } from '../../src/db/sqlite-utc.js';`. Remove ~4 duplicate lines. |
| `scripts/finance/__tests__/register-cron-jobs.test.ts` | No logic change — just confirms 4 existing tests still pass after the import refactor. |

### Files created

| File | Purpose |
|---|---|
| `src/db/sqlite-utc.ts` | Single `toSqliteUtc(d: Date): string` helper. ~10 lines with JSDoc. |
| `src/db/sqlite-utc.test.ts` | 3 vitest tests: basic format, milliseconds stripped, sortable against `datetime('now')` (direct regression for Bug C). |
| `src/host-sweep.test.ts` | 5 vitest tests for `handleRecurrence`: sync execution, respawn schema correctness, multiple completed rows, invalid recurrence string (catch + log + continue), SQLite UTC vs ISO regression guard. |

### Files NOT modified (explicitly out of scope)

- `src/channels/*.ts` — Bug A resolved upstream in formatter, no adapter changes.
- `src/router.ts` — `extractAndUpsertUser` already produces correctly-prefixed `user_id` for the admin role source.
- `container/agent-runner/src/poll-loop.ts` — admin check works correctly once `senderId` is normalized.
- `src/db/session-db.ts` — `insertRecurrence` / `clearRecurrence` are correct; only the caller was broken.
- `dist/` — regenerated by `npm run build` during deployment.

### Live deployment files

- The host service is running `dist/index.js` (PID currently 3062708). Needs restart to load new build.
- The container image (`nanoclaw-agent:latest`) has `formatter.ts` baked in. Operator regenerates via `./container/build.sh`.
- Active containers (e.g., the running finance container) won't reload `formatter.ts` until they exit and respawn. Operator can force this by killing the container; host-sweep will respawn on next cron tick.

---

## 6. Data flow

### Admin command via Chat SDK (Bug A fix)

```
Operator → @LevisBot: "/clear"
chat-sdk webhook → router.ts inserts messages_in row:
  channel_type='telegram-finance'
  content={
    author: { userId: '8557164566', userName: 'jonas_silva_zr' },
    senderId: null,
    text: '/clear'
  }

Container poll-loop pops the row:
  formatter.categorizeMessage:
    raw = content.senderId(null) || content.author.userId('8557164566') || content.sender(undef)
        = '8557164566'
    userKind = 'telegram-finance'.split('-')[0] = 'telegram'
    senderId = '8557164566'.includes(':')
             ? '8557164566'
             : 'telegram:8557164566'
    = 'telegram:8557164566'
  category = 'admin' (because text='/clear' is in ADMIN_COMMANDS)

poll-loop checks:
  adminUserIds = Set{'telegram:8557164566', 'whatsapp:17865189131', ...}
  adminUserIds.has('telegram:8557164566') = TRUE
  → executes /clear, returns "Session cleared."
```

### Cron auto-respawn (Bug B+C fix)

```
12:00:00  task-finance-sweep completes (container marks processing_ack='completed')

12:00:30  host-sweep tick:
  sweepSession(finance):
    syncProcessingAcks → messages_in.task-finance-sweep.status='completed'
    countDueMessages → 0 due (next isn't yet)
    detectStaleContainers → container alive, no action
    handleRecurrence(inDb, session):  ← SYNC now
      getCompletedRecurring → 1 row (the just-completed sweep)
      interval = CronExpressionParser.parse('0 8-22 * * *')
      nextRun = toSqliteUtc(interval.next().toDate())
              = '2026-05-12 13:00:00'   ← SQLite-friendly, sortable
      newId = 'msg-1778587343304-wy4tf5'
      insertRecurrence(inDb, msg, newId, '2026-05-12 13:00:00')
        ← inDb still open (handleRecurrence is sync, finally hasn't run yet)
        → INSERT succeeds
      clearRecurrence(inDb, original.id) → original.recurrence = NULL
      log.info('Inserted next recurrence', { originalId, newId, nextRun: '2026-05-12 13:00:00' })
    finally:
      inDb.close()

13:00:00+  next sweep tick:
  countDueMessages:
    process_after('2026-05-12 13:00:00') <= datetime('now')('2026-05-12 13:00:30')
    → TRUE (string compare works correctly with this format)
    → 1 row due
  wakeContainer → cron runs, completes, respawn loop continues indefinitely
```

### Error handling

| Layer | Scenario | Before | After |
|---|---|---|---|
| L1 — Bug A path | Admin command from un-prefixed sender | Always denied | Works |
| L1 — Bug A path | Adapter already populates `content.senderId='telegram:xyz'` | Works (matches Set) | Still works (already-prefixed branch) |
| L2 — Bug B path | `handleRecurrence` runs after sync conversion | DB-closed throw silently caught | Completes correctly; logs success |
| L2 — Bug B path | `cron-parser.parse` throws on invalid recurrence string | Caught by try/catch, logged, next row processes | Same — try/catch preserved |
| L2 — Bug B path | `insertRecurrence` fails for real (disk full) | Caught, logged | Same |
| L3 — Bug C path | New row inserted with `process_after='2026-05-12 13:00:00'` | Was inserted as ISO, never compared as due | Inserted as SQLite UTC, comparison works |
| L4 — Sweep itself throws | Any uncaught exception in sweepSession | `try/catch` around sweep loop logs `'Host sweep error'`, continues 60s later | Same |

### Observability

- **`logs/nanoclaw.error.log`** stops accumulating "Failed to compute next recurrence ... database connection is not open". Existing accumulated noise stays (we don't rotate logs as part of this), but no new entries.
- **`logs/nanoclaw.log`** gains `Inserted next recurrence` info entries — one per cron-tick respawn per session. Operator can confirm respawn is healthy with `grep "Inserted next" logs/nanoclaw.log`.
- **`messages_in`** invariant: `SELECT COUNT(*) FROM messages_in WHERE status='completed' AND recurrence IS NOT NULL` should be 0 except for a ~60s sweep window. If it stays positive, regression.

### Compatibility

- Sessions with existing `kind='task'` cron rows resume normal respawn behavior after deployment.
- The 5 rows manually inserted by `respawn-recurrence.ts` during Plan 2.5 closeout (today) will complete naturally, and the fixed `handleRecurrence` will respawn next occurrences automatically.
- No DB migration. No schema change.
- No breaking change to any external API.

---

## 7. Testing strategy

### Automated — vitest

**`container/agent-runner/src/formatter.test.ts`** (MODIFY — extend existing file)

Add a new `describe('categorizeMessage senderId normalization')` block with 5 tests:

| Test | Setup | Assertion |
|---|---|---|
| WhatsApp native | `content={sender: '17865189131', text:'/clear'}, msg.channel_type='whatsapp'` | `senderId === 'whatsapp:17865189131'` |
| Chat SDK no swarm | `content={author:{userId:'8557164566'}, text:'/clear'}, msg.channel_type='telegram'` | `senderId === 'telegram:8557164566'` |
| Chat SDK with swarm suffix | `content={author:{userId:'8557164566'}, text:'/clear'}, msg.channel_type='telegram-finance'` | `senderId === 'telegram:8557164566'` (suffix stripped) |
| Already-prefixed senderId | `content={senderId:'telegram:8557164566', text:'/clear'}, msg.channel_type='telegram'` | `senderId === 'telegram:8557164566'` (unchanged) |
| Empty content | `content={}, msg.channel_type='telegram'` | `senderId === null` |

**`src/host-sweep.test.ts`** (NEW)

Requires `handleRecurrence` exported. 5 tests using `:memory:` SQLite:

| Test | Assertion |
|---|---|
| Sync execution | `handleRecurrence(inDb, session)` does NOT return a Promise; inDb remains usable immediately after the call (no async race) |
| Respawn schema | Given 1 row `{kind:'task', recurrence:'0 8 * * *', status:'completed', content:'{"prompt":"hi"}'}`, after `handleRecurrence`: (a) 1 new pending row with same `kind`, `recurrence`, `content`; (b) new `process_after` matches `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$`; (c) original row has `recurrence=NULL`; (d) new row's `seq` is `original.seq + 2`. |
| Multiple rows | 5 completed rows → 5 new pending rows + 5 originals cleared |
| Invalid recurrence string | row with `recurrence='not a cron'` → caught + logged (mock `log.error`), other rows still process, no throw escapes |
| SQLite UTC regression guard | After respawn, run `SELECT 1 FROM messages_in WHERE process_after <= datetime('now') AND id=?` with the new row's id. If `process_after` is in the past relative to `datetime('now')`, returns 1. Confirms the SQLite UTC format compares correctly. (ISO format would fail this test.) |

**`src/db/sqlite-utc.test.ts`** (NEW)

3 tests:

| Test | Assertion |
|---|---|
| Basic format | `toSqliteUtc(new Date('2026-05-12T13:00:00Z'))` === `'2026-05-12 13:00:00'` |
| Strips milliseconds | `toSqliteUtc(new Date('2026-05-12T13:00:00.456Z'))` === `'2026-05-12 13:00:00'` |
| Sortable vs `datetime('now')` | Insert `process_after='2026-01-01 00:00:00'` (past) into temp table; `SELECT WHERE process_after <= datetime('now')` returns the row. ISO format would not. |

**`scripts/finance/__tests__/register-cron-jobs.test.ts`** (verify still green after refactor)

No changes — just runs to confirm `toSqliteUtc` import refactor doesn't break the 4 existing tests.

### Manual smoke (operator-driven after deploy)

| Cenário | Procedure | Pass |
|---|---|---|
| S1 — Cron auto-respawn end-to-end | `tail -f logs/nanoclaw.log \| grep "Inserted next"` for ~2 minutes after restart. Wait for next sweep cron tick. | At least 1 "Inserted next recurrence" entry appears. `logs/nanoclaw.error.log` stops gaining "Failed to compute next recurrence". |
| S2 — Admin /clear via Telegram | Operator sends `/clear` to `@LevisBot` | Bot replies "Session cleared." (was "Permission denied"). |
| S3 — Admin /clear via WhatsApp | Operator sends `/clear` to main WhatsApp agent | Same — "Session cleared." |
| S4 — Bug B regression test (live) | `sqlite3 data/v2-sessions/finance/<id>/inbound.db "SELECT COUNT(*) FROM messages_in WHERE status='completed' AND recurrence IS NOT NULL;"` 90s after any cron completes | Returns 0. (If > 0 for sustained periods, respawn is broken again.) |

S1 + S2 + S4 = minimum acceptance. S3 nice-to-have.

---

## 8. Deploy strategy

1. Merge all commits to `main`.
2. `npm run build` (regenerates `dist/`).
3. `./container/build.sh` (regenerates `nanoclaw-agent:latest` image with new `formatter.ts`).
4. Restart host service. Method depends on platform:
   - Linux systemd: `systemctl --user restart nanoclaw`
   - macOS launchd: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
   - Manual: kill PID, re-launch
5. Force active containers to respawn so they pick up the new `formatter.ts`:
   - Find PIDs: `ps auxf | grep agent-runner | grep -v grep`
   - Either `docker stop <container-name>` for each, OR wait — they'll idle out (~5 min) and the host respawns them on next cron tick automatically.
6. Validate via smoke S1+S2+S4.

---

## 9. Acceptance criteria

- [ ] Vitest green: 5 new tests in `formatter.test.ts`, 5 new in `host-sweep.test.ts`, 3 new in `sqlite-utc.test.ts`, 4 existing in `register-cron-jobs.test.ts` still passing
- [ ] `logs/nanoclaw.error.log` stops accumulating "Failed to compute next recurrence" after restart
- [ ] `logs/nanoclaw.log` shows at least 1 "Inserted next recurrence" within 5 minutes of restart
- [ ] `/clear` via Telegram replies "Session cleared." (not "Permission denied")
- [ ] `/clear` via WhatsApp replies "Session cleared."
- [ ] `messages_in` invariant: no session has rows with `status='completed' AND recurrence IS NOT NULL` for more than ~70s
- [ ] `toSqliteUtc` is imported from `src/db/sqlite-utc.ts` in both `register-cron-jobs.ts` and `host-sweep.ts` (no duplication)

---

## 10. Residual risk + follow-ups

- **Container image rebuild discipline:** if `./container/build.sh` is not run, the formatter fix won't reach the container. Mitigated by Step 3 in the deploy runbook + a comment on Step 9.5 of `.claude/skills/add-finance/SKILL.md` reminding to rebuild when touching `container/agent-runner/src/*`.
- **Error log noise from past failures:** `logs/nanoclaw.error.log` already has hundreds of stack traces from Bug B. Not rotated by this plan. Operator can `> logs/nanoclaw.error.log` to truncate after deploy + acceptance.
- **Active sessions that idle out:** if a container is mid-query when the new image is rebuilt, it keeps the old `formatter.ts` in memory. Mitigated by docker stop or natural idle-respawn.
- **Future channels:** any new channel adapter must either populate `content.senderId` with prefix, OR rely on the formatter normalization. Document in CONTRIBUTING.md? (Out of scope here; opens issue.)

---

## 11. What's NOT in this spec

- Refactor of `chat-sdk-bridge.ts` or any other channel adapter
- Adding `senderId` field to channel-side InboundMessage typings
- Changes to admin role model (`user_roles` schema, `getOwners`/`getGlobalAdmins`/`getAdminsOfAgentGroup`)
- Schema migration for any SQLite table
- Plan 2.5 cron content changes (override block, procedural prompts)
- Log rotation for `nanoclaw.error.log`
- New admin commands beyond what `ADMIN_COMMANDS` already defines
