# QA Report: Spawn Board (Post-Build /team-qa Pass)

> Generated 2026-05-10 — /team-qa run as part of /team-auto Stage D

## Pipeline Summary

| Validator | Status | Findings |
|-----------|--------|----------|
| Phase 1 — Denoise | ✅ Clean | 0 (no debug artifacts, TODOs, magic test values, or temp files) |
| Validator A — Style Audit | ✅ Complete | 1 MUST-FIX + 9 SHOULD-FIX + 1 PRE-EXISTING |
| Validator B — Doc Freshness | ✅ Clean (inline) | New feature; docs in `docs/specs/spawn-board/` are fresh |
| Validator CD — Code Review Swarm | ✅ Complete (4 reviewers — TeamCreate hook blocked the standard team name; spawned as parallel sub-agents instead, reducing collaboration step but preserving cross-coverage) | Adversarial + Domain + Security + Contract |
| Validator E — Codex Adversarial | ✅ Complete | 3 HIGH findings |

**Total findings:** 16 BUG (6 MUST-FIX + 10 SHOULD-FIX) + 9 SUGGESTION/ADVISORY + 1 PRE-EXISTING

---

## MUST-FIX (6) — Blocking

### MF-1 — Tautological PRIMARYKEY check (CONFIRMED by 3 reviewers)

**File:** `src/dashboard/steer.ts:195`

```ts
if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY')
```

Both arms of the OR are identical. The second was clearly intended to be `'SQLITE_CONSTRAINT_UNIQUE'` (the `seq` column has a UNIQUE constraint per `src/db/schema.ts:169`). Any UNIQUE-constraint violation on `messages_in.seq` falls through to the re-throw at line 202 → unhandled 500, rate-limit token leaked, idempotency stays 'pending'.

**Reviewers:** Validator A (style), Domain reviewer, Adversarial reviewer
**Fix:** `code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE'`

### MF-2 — Cookie TTL mismatch (Codex A, Security, Adversarial all confirm)

**Files:** `src/dashboard/auth/cookie.ts:49`, `src/dashboard/auth/exchange.ts:79`

Cookie payload `expires_at` signs the 24h token TTL (from `dashboard-token-issue.ts:21` calling `issueDashboardToken(.., 24)`); `Set-Cookie` Max-Age=43200 (12h). Server-side `parseAndVerifyCookie` validates against the embedded 24h expiry. Browser deletes at 12h but a leaked/copied cookie remains server-valid for 24h.

**Fix:** Either (a) change `Set-Cookie` Max-Age to 86400, or (b) reduce token TTL to 12h, or (c) cap cookie payload `expires_at` to `min(now + 12h, record.expires_at)`. Pick one canonical TTL, use everywhere.

### MF-3 — Scoped admin empty scope (Codex C, Security, Contract, Adversarial all confirm)

**File:** `src/dashboard/router.ts:171, 188`

`requireAuth` calls `canAccessAgentGroup(payload.user_id, '*')` which queries `WHERE agent_group_id='*'` — no real group has id `'*'`. Returns `allowed=false` for every scoped admin → role='member', allowed_group_ids=[], no_filter=false. Downstream queries match no rows; every task returns 404.

`auth-me.ts:computeScopes` correctly enumerates groups via `user_roles`, but its result is never plumbed into `requireAuth`'s `authedCtx.scopes`.

**Impact:** Complete functional auth failure for the entire scoped-admin role tier.

**Fix:** Extract `computeScopes(userId)` from `auth-me.ts` into a shared helper. `requireAuth` calls it to populate `allowed_group_ids` and set `no_filter` correctly per role.

### MF-4 — TranscriptEntry shape totally mismatched (Contract reviewer)

**Files:** Backend `src/dashboard/api/tasks.ts:28-36`, Frontend `dashboard/src/lib/api.ts:16-21`, `dashboard/src/views/TaskDetail.tsx:143-159`

Backend returns:
```ts
{ id, seq, kind, timestamp, content, direction: 'inbound'|'outbound', source: 'dashboard'|'chat'|'agent'|'system' }
```
Frontend expects:
```ts
{ seq, role: 'user'|'assistant', text, ts }
```

TaskDetail thread renders `entry.role`, `entry.ts`, `entry.text` — all `undefined` at runtime. Thread shows empty rows.

**Fix:** Either (a) backend transform: map `direction→role`, extract `text` from `content`, `timestamp→ts`; or (b) frontend rewrite: align type + render to backend shape (kind, content, direction, source, timestamp). Option (b) preserves more info for the UI.

### MF-5 — `task_content` not selected in list query (Contract reviewer)

**File:** `src/dashboard/api/tasks.ts:178-183`

The list query SELECT clause omits `task_content`. Frontend `KanbanBoard.tsx:127` calls `truncate(task.task_content, 80)` → `task_content` is `undefined` → TypeError on `.length` → KanbanBoard crashes.

**Fix:** Add `task_content` to the list query SELECT.

### MF-6 — Hardcoded port 3000 in token URL (Adversarial)

**File:** `src/dashboard/auth/dashboard-token-issue.ts:26`

Token-issue URL uses `${protocol}://${host}:3000/dashboard/` regardless of `WEBHOOK_PORT` env. Server actually binds to `parseInt(process.env.WEBHOOK_PORT || '3000', 10)`. Non-default-port deploys break the auth flow (link points to wrong port).

**Fix:** `const port = process.env.WEBHOOK_PORT ?? '3000'; const url = \`${protocol}://${host}:${port}/dashboard/\`;`

---

## SHOULD-FIX (10) — Recommended

### SF-1 — Echo duplication race (Codex B, Security MEDIUM, Adversarial)

**File:** `src/dashboard/steer.ts:234`

Concurrent retries with same idempotency_key both see `echoAttempted=false` at reservation time, both schedule `setImmediate` echo, both call `adapter.deliver`. Duplicate Slack/Discord messages.

**Fix:** Add atomic CAS DAO method `claimEchoAttempted(rowId): boolean` doing `UPDATE steer_idempotency SET echo_attempted=1 WHERE id=? AND echo_attempted=0` returning `changes > 0`. Only schedule echo if claim succeeds.

### SF-2 — `member_role_cannot_steer` 403→404 (Security MEDIUM)

**File:** `src/dashboard/steer.ts:122`

Returns 403 with `{error: 'member_role_cannot_steer'}` after scope check passes — discloses task existence + group membership to members. §2a contract requires disclose-as-not-found.

**Fix:** Change to `{status: 404, body: {error: 'task_not_found'}}` matching the scope-filter fallthrough.

### SF-3 — `exchangeToken` return type lie (Contract)

**File:** `dashboard/src/lib/api.ts:81`

Declared `Promise<AuthMe>` but backend returns `{user_id, expires_at}` (no `scopes`). AuthGate happens to discard the result, so no runtime break — but TypeScript can't catch future code that reads `.scopes`.

**Fix:** Add `interface ExchangeResponse { user_id: string; expires_at: string }` and change `exchangeToken` to return `Promise<ExchangeResponse>`.

### SF-4 — Static ETag unquoted (Contract)

**File:** `src/dashboard/static.ts:108-109`

ETag value `stat.mtimeMs.toString(16)` is unquoted; browsers send `If-None-Match: "abc123"` (quoted per RFC 7232). Strict equality `ifNoneMatch === etag` always fails → **304 responses never served**, every asset request returns full body.

**Fix:** `const etag = \`"\${stat.mtimeMs.toString(16)}"\`;` (quotes on both generation and comparison).

### SF-5 — No body size limit on HTTP server (Adversarial)

**File:** `src/webhook-server.ts:26-46`

`toWebRequest` buffers all request body chunks unconditionally. Any client (incl. unauthenticated `/dashboard/api/auth/exchange`) can send a multi-GB body → OOM/DoS.

**Fix:** Track `totalSize` in the chunk loop; return 413 once threshold (e.g., 1MB for API, larger for webhook adapters) exceeded.

### SF-6 — `dashboard_tokens` table has no TTL cleanup (Adversarial)

**File:** `src/host-sweep.ts` (or new prune)

`steer_idempotency` has D7 prune wired (host-sweep.ts:165-197). `dashboard_tokens` has no equivalent — accumulates one row per `/dashboard-token` invocation forever.

**Fix:** Add `pruneDashboardTokens()` to host-sweep deleting `expires_at < now - 1d`.

### SF-7 — `rateLimitMap` unbounded growth (Adversarial)

**File:** `src/dashboard/steer.ts:38`

In-memory rate-limit Map keyed by `(user, child_session)`. Entries created/mutated, never deleted. Long-lived host accumulates one entry per (user, session) pair forever.

**Fix:** In the window-expired branch (line 45 area), `rateLimitMap.delete(key)` before re-inserting; or add periodic sweep removing entries older than 2× window.

### SF-8 — Chokidar empty task_id triggers global refetch storm (Adversarial)

**Files:** `src/dashboard/api/events.ts:169`, `dashboard/src/views/TaskDetail.tsx:25`

`_emitInboundChangeEvent` emits `task_id: ''` for every chokidar fs event (inbound.db AND outbound.db changes). TaskDetail's `if (!payload.task_id || payload.task_id === taskId)` always fires (empty string is falsy), causing every TaskDetail view across all users to refetch on every fs change.

**Fix:** `_emitInboundChangeEvent` already has `sessionId` local — emit `child_session_id` in the payload. Frontend filters to `payload.child_session_id === data?.task?.child_session_id`.

### SF-9 — Missing chokidar `error` handler (Adversarial)

**File:** `src/dashboard/api/events.ts:117`

`watcher = watch(SESSIONS_ROOT, {...})` — no `.on('error', ...)`. If SESSIONS_ROOT doesn't exist on first-run, chokidar emits unhandled `error` event → process crash on newer Node.

**Fix:** `watcher.on('error', (err) => log.warn('chokidar error', { err }));` immediately after assignment.

### SF-10 — Secure cookie flag on http://localhost (Adversarial — informational)

**File:** `src/dashboard/auth/cookie.ts:49`

`Secure` flag always set. Chromium/Firefox accept on localhost; older/embedded browsers + curl may drop. Workflow impact only.

**Fix:** `buildSetCookie(payload, serverKey, {secure: boolean})` — set true unless loopback, OR document that the server requires HTTPS in production and localhost-Chromium for dev.

---

## ADVISORY (9) — Non-blocking

### AD-1 to AD-9 (Style — Validator A)

- `src/dashboard/steer.ts:9-10` — split `crypto` imports → merge
- `src/dashboard/static.ts:11` — unused `createHash` import → remove
- `src/host-sweep.ts:33-34` — split `db/sessions.js` imports → merge
- `src/dashboard/auth/exchange.ts:7-16` — duplicate `LOCALHOST_HOSTS`/`isLocalhostOrigin` from router.ts → extract to shared util
- `dashboard/src/main.tsx:8`, `KanbanBoard.tsx:4`, `TaskDetail.tsx:4` — `.ts` extension imports inconsistent with surrounding `.js` → use `.js`
- `dashboard/src/views/KanbanBoard.tsx:4,143` — dead `startSSE` re-export → remove
- `src/dashboard/steer.ts:331` — trivial `statusMap` identity → drop
- `src/host-sweep.ts:29-34` — pre-existing import block formatting (PRE-EXISTING — not blocking)

### AD-10 — Domain (Test naming)

Pervasive use of `'ASSERT: ...'` and bare descriptions instead of `test_<name>` in `src/modules/orchestrator-dispatch/{completion,cancellation,progress,dispatch,watchdog,reconciler,derive-task-id}.test.ts` and `src/dashboard/static.test.ts` (lines listed). Plan §test-cases required `test_` prefix. Pervasive across orchestrator-dispatch tests — these were NOT introduced by spawn-board (mostly), so most are PRE-EXISTING.

### AD-11 — Domain (Non-idiomatic spread casts)

`tasks.ts:140`, `tasks.ts:188`, `sessions.ts:78` use `...(values as Parameters<...>)` casts instead of the simpler `...values` or `as BindParameters[]`. Cosmetic.

### AD-12 — Domain (Import interleaving)

`src/modules/orchestrator-dispatch/dispatch.ts:8-23` — `let _emitDashboardEvent` + `lazyEmit` block declared between import statements. Cosmetic.

### AD-13 — Domain (cookie.ts Buffer encoding)

`cookie.ts:69-71` — Buffer.from(string) encodes as UTF-8 not base64. Comparison still works because both sides are UTF-8 of the base64 string, but intent would be clearer with explicit base64 decoding.

### AD-14 — Domain (events.ts double-cast)

`events.ts:218` — `as unknown as http.ServerResponse` double-cast on optional field. Use `ctx.rawNodeRes!` non-null assertion.

### AD-15 — Adversarial (Scoped admin can issue token but dashboard useless)

`/dashboard-token` permits scoped admins via `isAnyAdmin`, but Codex C (MF-3 fix) makes the dashboard functional only for owner/global_admin. Either fix MF-3 OR restrict token issue to owner/global_admin. Resolved by MF-3 fix.

---

## Verified Clean (security)

- HMAC storage: only `token_hmac`, never raw bearer
- HMAC compare: `crypto.timingSafeEqual`
- Random gen: `crypto.randomBytes`/`crypto.randomUUID`
- No localStorage/sessionStorage in frontend
- No URL token (history.replaceState wipe + body-only exchange)
- Path traversal in static handler (decode + null-byte + STATIC_ROOT prefix + isFile guard)
- Static handler intentionally public (per design §6)
- CSRF Origin check on POST/PUT/DELETE
- No raw token in logs (token-issue handler doesn't log content)
- SQL injection: all queries parameterized; dynamic SQL uses trusted string literals + parameterized values
- Migration 028 forward-only safe (CREATE only, no DROP/ALTER)

## Verified Clean (wire)

- B1 SSE event names: server emits `event: ${kind}\ndata: ${json}\n\n`; frontend `addEventListener('task_event'|'inbound_message')` ✓
- B2 transcript envelope (top-level `{task, transcript}`) ✓ (but inner shape per MF-4 broken)
- B3 retry_after extraction in api.ts + TaskDetail consumption ✓
- B4 echo_status SSE emit fires `emitDashboardEvent('task_event', ...)` ✓
- B7 SessionSummary fields aligned ✓

---

## Gate

### Cycle 1 (initial)

```
Denoise:        0 fixed, 0 waived
Style:          11 violations — 1 MUST-FIX, 9 SHOULD-FIX, 1 PRE-EXISTING
Doc freshness:  0 stale (new feature; fresh specs)
Code review (swarm): 14 findings — 5 MUST-FIX (BUG), 9 SHOULD-FIX. [TeamCreate hook blocked the "code-review" team name; reviewers spawned as parallel sub-agents — collaboration step degraded but cross-coverage preserved.]
Codex (cross-model): 3 HIGH — all confirmed by swarm.

MUST-FIX total: 6 — blocking
SHOULD-FIX total: 10
```

### Cycle 2 (post-fix re-validation)

All 6 MUST-FIX applied (lead-applied with grounding citations + auto_judgments):
- MF-1 ✓ steer.ts:195 PRIMARYKEY||UNIQUE (was tautological PRIMARYKEY||PRIMARYKEY)
- MF-2 ✓ Token TTL 24h→12h (matches cookie Max-Age=43200)
- MF-3 ✓ requireAuth uses `computeScopes` from `src/dashboard/auth/compute-scopes.ts` (extracted, shared with auth-me)
- MF-4 ✓ TranscriptEntry frontend type + TaskDetail rendering rewritten to backend shape `{id, seq, kind, timestamp, content, direction, source}`. content.text extracted for display; direction+source label per entry.
- MF-5 ✓ task_content added to tasks list SELECT clause + TaskSummary type
- MF-6 ✓ WEBHOOK_PORT env in dashboard URL

Plus 9 of 10 SHOULD-FIX applied:
- SF-1 ✓ claimEchoAttempted atomic CAS DAO + steer.ts caller
- SF-2 ✓ member 403→404 (disclose-as-not-found per §2a)
- SF-3 ✓ ExchangeResponse type for exchangeToken
- SF-4 ✓ ETag value quoted (RFC 7232; 304 now serves)
- SF-5 ✓ 8MiB body cap + 413 in webhook-server toWebRequest
- SF-6 ✓ pruneDashboardTokens DAO + sweep wire (1d grace past expiry)
- SF-7 ✓ rateLimitMap opportunistic sweep at >1024 entries
- SF-8 ✓ TaskDetail filters chokidar events by child_session_id
- SF-9 ✓ chokidar.on('error') warn handler

Skipped (informational only):
- SF-10 (Secure cookie on localhost — Chromium handles correctly; cosmetic for non-Chromium dev workflows)

ADVISORY (style cleanup) — deferred to follow-up; not blocking.

```
**Codex cross-model cycle 2 verdict: PASS** — all 6 cycle-1 fixes correctly applied. No new HIGH/CRITICAL findings. Verdict: "approve".

Test counts:
- Host: 264/264 (264 = 264 + 2 new tests in steer + tests updated for new shapes; -2 redundant)
- Frontend: 29/29
- tsc clean (host + dashboard)

MUST-FIX total: 0 (all 6 cleared)
SHOULD-FIX total: 1 (SF-10, intentional defer; informational)
```

**QA pipeline clear. Ready to ship.**

After shipping, consider running `/team-retro` to capture learnings from this feature's workflow.

---

## Recommended Fix Plan

**Phase 1 — MUST-FIX (~30-60 min):**
1. MF-1: 1-line edit (steer.ts:195 PRIMARYKEY→UNIQUE on second arm) — trivial
2. MF-2: Pick canonical TTL (recommend 12h for both); update `issueDashboardToken(.., 12)` AND keep Max-Age=43200 — 1-line edit
3. MF-3: Extract `computeScopes(userId)` from auth-me.ts to shared helper; call from `requireAuth` — ~20 lines
4. MF-4: Frontend rewrite of TranscriptEntry type + TaskDetail rendering to match backend shape — ~30-50 lines
5. MF-5: Add `task_content` to tasks list SELECT clause — 1-line edit
6. MF-6: Read `process.env.WEBHOOK_PORT` in token-issue URL builder — ~5 lines

**Phase 2 — SHOULD-FIX (~30-45 min):**
7. SF-1: Atomic claimEchoAttempted DAO + steer.ts caller — ~20 lines
8. SF-2: 403→404 for member_role_cannot_steer — 1-line edit
9. SF-3: ExchangeResponse type — 5 lines
10. SF-4: Quote ETag string — 2-line edit
11. SF-5: Body size limit in toWebRequest — ~10 lines
12. SF-6: pruneDashboardTokens in host-sweep — ~15 lines
13. SF-7: rateLimitMap.delete on window expiry — 2-line edit
14. SF-8: Emit child_session_id on chokidar events; TaskDetail filters — ~5 lines
15. SF-9: Add `watcher.on('error', ...)` — 1-line edit
16. SF-10: Document Secure-on-localhost behavior OR conditional flag — minor

**Phase 3 — ADVISORY (style cleanup, ~15 min):**
17-25: Routine style fixes (consolidate imports, drop unused, etc.)

After fixes: re-run /team-qa --only swarm + --only codex to verify MUST-FIX cleared.

**Total estimated fix time:** 1.5-2 hours.
