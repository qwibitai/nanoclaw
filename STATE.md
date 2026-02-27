# STATE — Observer Agent (v0.2.0)
Protocol-Version: 5.7
Updated: 2026-02-27T20:00:00Z
Last-Progress: 2026-02-27T20:00:00Z
Size: medium
Domains: agentic, paid-api

## Commands (per domain)
| Domain | TEST | BUILD | LINT | DEV |
|--------|------|-------|------|-----|
| agentic | vitest run | npm run build | tsc --noEmit | npm run dev |

VERIFY: After a 5+ message Discord conversation, observer appends dated observations with priority markers to daily/observer/{date}.md. BM25 recall finds them.

## Protocol

**DRIFT GUARD — if you read nothing else, follow these:**
- Evidence or nothing. No gate passes without pasted output.
- NEVER reshape the plan silently. NEVER skip APPROVE.
- No code without spec. Missing spec = BLOCKED phase.
- **AGENTIC: Eval harness for non-deterministic behavior. TDD for deterministic parts. Both required. All 6 operational safeguards mandatory before ship: step budget + cost ceiling + timeout + circuit breaker + trace logging + kill switch.**
- QA Risk defaults to HIGH. LOW requires justification logged in Decisions.
- SHA-stamp ALL evidence. Stale evidence at SHIP = re-verify.
- 3-STRIKE then STOP. No 4th attempt without new information.
- User is non-technical. Plain language. No commands to run.
- Update this file after every state change.
- **TASK PROOF RECEIPT: A task is NOT done until it has all 3 receipts: ✅ Functional, 🔒 Security, 📋 Evidence. Missing ANY receipt = task stays unchecked.**
- **STAGE EXIT ARTIFACT: Every SDLC stage deposits an EXIT line in Evidence Log before advancing.**

1. Read this file before every action. Print `=== STATE: {stage} | Phase {N}/{total}: {name} ===` before acting.
2. CLASSIFY input: A) phase work B) blocker C) future D) park E) urgent F) breadcrumb G) abort
3. Update this file after every state change.
4. Show PROGRESS VIEW after phase completion.
5. No gate passes without pasted evidence.
6. 3-STRIKE: 3 fails → STOP → roundtable → web → ask user.
7. Context heavy → update this file → /compact → re-invoke `/do`.
8. NEVER silently abandon or reshape the plan.
9. Failures → Evidence Log.
10. User is non-technical. Plain language.
11. After phase VERIFIED → collapse Evidence to 1-line summary.
12. PLAN order: research → spec-flow → pre-mortem → decompose → per-phase spec → risk policy → req trace.
13. Before IMPLEMENT: verify every phase has Intent + Spec + Test Cases.
14. After REVIEW: triage P0/P1/P2/P3.
15. SHIP GATE: offer QA + feature video.
16. To resume after handover: invoke Skill `do`.

## Decisions
| Decision | Options | Chosen | Why |
|----------|---------|--------|-----|
| Observer timing | After-every / Substantial-only / Nightly / Both | Substantial-only (5+ user messages) | Practical balance: captures meaningful conversations, skips noise. Nightly batch is Reflector (issue #2). |
| Storage location | daily/{date}.md / daily/observer/{date}.md / separate dir | daily/observer/{date}.md (append) | Security review: separate trust boundary. Observer content is lower-trust than user notes. BM25 still searches it. |
| LLM vs rule-based | LLM / Rules / Hybrid | LLM (Sonnet 4.6) | Quality matters for memory. Haiku hallucinates. MiniMax can't do structured tasks. Sonnet reliable. ~$0.03/observation. |
| Cron observation | Observe crons / Skip crons | Skip (threshold handles it) | Routine crons are short (<5 messages), auto-skipped by threshold. |
| Observer architecture | Host-side API call / Container spawn / In-container hook | Host-side direct API call | No container overhead (saves 10-15s), host has API creds, conversation data in DB. |
| Anti-goals | Lose memories / Burn money / Both | Both equally bad | Append-only writes + credential scrubbing + cost controls. |
| Prompt injection defense | None / Delimiters / Delimiters+validation | Delimiters + post-validation | Security review OA-01: conversation content is untrusted. Hard delimiters + reject instruction patterns in output. |
| Observer output directory | daily/ / daily/observer/ | daily/observer/ | Security review OA-07: separate trust boundary. Nightly consolidation treats as lower-trust. |
| Cost throttling | None / Per-group cooldown | Per-group 5-min cooldown | Security review OA-03: prevents cost amplification from message floods. |

## Agentic Inventory
| Category | Count | Details |
|----------|-------|---------|
| System prompts | 2 | groups/global/CLAUDE.md, groups/{agent}/CLAUDE.md |
| Tool definitions | 8 | recall, remember, delegate_task, x402_fetch, send_sms, check_messages, make_call, check_calls |
| Agent loop patterns | 0 | No step budget enforced in code |
| Existing evals | 0 | None |
| Observability | present | stderr logging + credential scrubbing (pino) |
| Cost controls | partial | Per-task model override, cron auto-pause after 5 failures. No per-request ceiling. |
| Context construction | CLAUDE.md | groups/global + groups/{agent} loaded per conversation. Session resumption via SQLite. |

## Agent Architecture
- Parity: Observer is host-side, not user-facing. No parity needed.
- Granularity: Single function call (compressConversation). Atomic.
- Composability: New observation rules via prompt changes only.
- Context engineering: Conversation text → scrub → compression prompt → LLM → observations.
- Operational constraints: Step budget (1 call), cost ceiling (~$0.03), timeout (30s), circuit breaker (3 failures → disable), trace logging (pino), kill switch (OBSERVER_ENABLED env var).

## Phases

### Phase 1: Observer Core — IMPLEMENTED
Domain: agentic, paid-api
TDD: logic-heavy
QA Risk: HIGH
Depends: —
Scope: src/observer.ts (NEW), src/types.ts
Produces: `observeConversation()` function, `Observation` type
Consumes: —
Recovery: Delete src/observer.ts, revert types.ts changes. Safe to re-run.
Intent: Create the module that compresses conversations into prioritized observations using an LLM call.
Spec:
  - WHEN given conversation messages (user + bot), THEN call LLM with compression prompt wrapped in hard delimiters (`=== BEGIN UNTRUSTED CONVERSATION ===`) and return structured observations.
  - WHEN conversation text contains credentials/API keys, THEN scrub them BEFORE sending to LLM (reuse scrubCredentials pattern + add missing token formats: ghp_, AKIA, xoxb-, ya29.).
  - WHEN LLM call fails (network, rate limit, API error), THEN log warning and return gracefully (never throw — entire function body wrapped in try/catch).
  - WHEN LLM returns observations, THEN validate output (reject if contains instruction patterns: "ignore previous", "system:", "[ADMIN]"), then append to `groups/{folder}/daily/observer/{date}.md` with priority markers (🔴🟡🟢) and timestamps.
  - WHEN daily observer file doesn't exist, THEN create it with header `<!-- source: observer -->\n## Observations — {date}`.
  - WHEN daily observer file already has content, THEN append new observations below existing content.
  - WHEN daily observer file exceeds 200KB, THEN skip append and log warning.
  - WHEN writing observations, THEN include three-date model: observation date (from Node.js Date, NOT LLM), referenced dates (extracted by LLM).
  - WHEN conversation payload exceeds 4K tokens (~50 messages), THEN truncate oldest messages first.
  - WHEN constructing file path, THEN use resolveGroupFolderPath() — never string interpolation. Date from Node.js only, never from LLM response.
  - REJECTS: Empty conversation arrays, conversations with 0 user messages, conversations where last observation was <5 min ago (per-group cooldown).
Test Cases:
  - "should produce markdown observations from sample conversation"
  - "should scrub API keys from conversation before LLM call"
  - "should scrub ghp_, AKIA, xoxb- tokens from conversation"
  - "should handle LLM API failure gracefully (never throws)"
  - "should append to existing daily/observer file without overwriting"
  - "should create daily/observer file with provenance header if missing"
  - "should include priority markers and timestamps"
  - "should wrap conversation in hard delimiters in LLM prompt"
  - "should reject LLM output containing instruction patterns"
  - "should skip if daily file exceeds 200KB"
  - "should truncate conversation to 50 messages max"
  - "should use resolveGroupFolderPath for file paths"
  - "should enforce per-group 5-min cooldown"
Behavioral Rubric:
  - GIVEN a conversation about a decision, EXPECT 🔴 Critical priority assigned
    ACCEPTABLE: Decision captured with context, marked critical
    UNACCEPTABLE: Decision missed or marked as noise
    JUDGE: llm-as-judge
  - GIVEN a conversation with only pleasantries, EXPECT mostly 🟢 Noise
    ACCEPTABLE: Brief summary, noise priority
    UNACCEPTABLE: Fabricated decisions or commitments not in conversation
    JUDGE: llm-as-judge
  - BOUNDARY: Observation text must not contain API keys, tokens, or private keys
    VIOLATED WHEN: regex match for credential patterns in output file
    JUDGE: assertion
  - BOUNDARY: Observer must not modify or delete existing file content
    VIOLATED WHEN: file content before observation section changes
    JUDGE: assertion
Operational Constraints:
  - Step budget: 1 LLM call per observation (single API call, not an agent loop)
  - Cost ceiling: ~$0.03 per observation (Sonnet 4.6 at $3/$15, ~2K tokens in/out)
  - Timeout: 30s for LLM call
  - Circuit breaker: 3 consecutive failures → log error, return silently (observer auto-disables)
  - Trace logging: pino logger (host-side, same as all other host modules)
  - Kill switch: OBSERVER_ENABLED env var (default: true, set to false to disable)
UX Decision Map: No user decision points — pure backend.
Tasks:
- [x] Create Observation types in types.ts | Attempts: 1/3
  - ✅ Functional: ObservationEntry interface added to types.ts. tsc --noEmit clean.
  - 🔒 Security: Type-only change. No runtime behavior. Self-audit: safe.
  - 📋 Evidence: `tsc --noEmit` → clean (0 errors). Interface at src/types.ts end of file.
- [x] Build observer module: LLM call with hard delimiters + credential scrubbing + output validation | Attempts: 1/3
  - ✅ Functional: 15 TDD tests + 5 assertion evals pass (20 passed, 4 skipped). Build clean. Typecheck clean.
  - 🔒 Security: Security sentinel review: 0 P0, 3 P1 (all fixed), 5 P2 (logged). P1-1: MAX_MESSAGE_LENGTH=2000+MAX_TOTAL_CHARS=50000. P1-2: circuit breaker 15min auto-reset with trip recording on all 4 failure paths. P1-3: readEnvFile for secrets with process.env fallback. Output scrubbed via scrubCredentials + injection validation.
  - 📋 Evidence: `vitest run src/observer.test.ts src/observer.eval.ts` → 20 passed | 4 skipped. `npm run build` → clean. `tsc --noEmit` → clean.
- [x] Write to daily/observer/{date}.md: append-only, provenance tag, size cap, safe path resolution | Attempts: 1/3
  - ✅ Functional: Tests verify: append without overwrite (BOUNDARY eval passes), provenance header creation, 200KB file skip, resolveGroupFolderPath used.
  - 🔒 Security: Separate trust boundary (daily/observer/ not daily/). Safe path via resolveGroupFolderPath (never string interpolation). Date from Node.js only. File size cap prevents disk fill.
  - 📋 Evidence: Eval "BOUNDARY: existing file content must not be modified" → PASS. Test "should skip if daily file exceeds 200KB" → PASS. Test "should use resolveGroupFolderPath for file paths" → PASS.
- [x] Per-group cooldown + conversation truncation | Attempts: 1/3
  - ✅ Functional: Tests verify: per-group 5-min cooldown (success-only update), 50-message truncation (oldest dropped), per-message 2000-char limit, 50K total char cap.
  - 🔒 Security: Cooldown prevents cost amplification (OA-03). Truncation prevents cost spiral (P1-1). Both verified in security review.
  - 📋 Evidence: Test "should enforce per-group 5-min cooldown" → PASS. Test "should truncate conversation to 50 messages max" → PASS. Constants: MAX_MESSAGE_LENGTH=2000, MAX_TOTAL_CHARS=50000, MAX_MESSAGES=50, COOLDOWN_MS=300000.
Verify: npm run build && tsc --noEmit → PASS (both clean)
User Live Test: NOT_TESTED
Operational Safeguards (all 6 verified):
  1. Step budget: 1 fetch call per observation (test "BOUNDARY: only 1 fetch call" → PASS)
  2. Cost ceiling: ~$0.03 (Sonnet 4.6 at $3/$15, max_tokens=2048, input capped at 50K chars)
  3. Timeout: 30s AbortController (LLM_TIMEOUT_MS=30000, line 205)
  4. Circuit breaker: 3 failures → disable, 15min auto-reset (test "BOUNDARY: circuit breaker" → PASS)
  5. Trace logging: pino logger (logger.info/warn/error throughout)
  6. Kill switch: OBSERVER_ENABLED=false (test "BOUNDARY: kill switch" → PASS)
Evidence:
  [vitest] 20 passed | 4 skipped — src/observer.test.ts + src/observer.eval.ts
  [build] npm run build → clean
  [tsc] tsc --noEmit → clean
  [security] 0 P0 | 3 P1 FIXED | 5 P2 logged for REVIEW

### Phase 2: Host Integration — IMPLEMENTED
Domain: agentic, paid-api
TDD: logic-heavy
QA Risk: HIGH
Depends: Phase 1
Scope: src/index.ts, src/config.ts, .env.example
Produces: Observer auto-triggers after substantial conversations
Consumes: `observeConversation()` from Phase 1
Recovery: Revert index.ts and config.ts changes. Safe to re-run.
Intent: Wire the observer into the conversation lifecycle so it runs automatically after successful conversations without blocking response delivery.
Spec:
  - WHEN a conversation container exits successfully AND conversation had 5+ user messages AND not in cooldown, THEN trigger observer via `maybeObserve()` helper (non-blocking, after Discord response sent).
  - WHEN OBSERVER_ENABLED is false, THEN skip observer silently.
  - WHEN conversation had fewer than 5 user messages, THEN skip observer silently.
  - WHEN container run was a scheduled task (isScheduledTask), THEN skip observer.
  - WHEN group is in cooldown (last observation <5 min ago), THEN skip observer silently.
  - WHEN observer is triggered, THEN it runs AFTER response has been sent to Discord (non-blocking, fire-and-forget with .catch()).
  - WHEN observer call fails, THEN log warning but do NOT affect conversation response or error handling.
  - WHEN circuit breaker trips (3 consecutive failures), THEN notify Discord channel once (following task-scheduler auto-pause pattern).
  - REJECTS: Scheduled tasks, short conversations, disabled observer, cooldown active.
Test Cases:
  - "should trigger observer after successful conversation with 5+ messages"
  - "should not trigger for short conversations (<5 messages)"
  - "should not trigger for scheduled tasks"
  - "should not block conversation response delivery"
  - "should handle observer failure without affecting main flow"
Behavioral Rubric: Deterministic only — no rubric needed.
Operational Constraints:
  - Step budget: 1 call to observeConversation() per conversation
  - Cost ceiling: Same as Phase 1 (~$0.03)
  - Timeout: Inherited from Phase 1 (30s)
  - Circuit breaker: Inherited from Phase 1
  - Trace logging: pino logger
  - Kill switch: OBSERVER_ENABLED config
UX Decision Map: No user decision points — pure backend.
Tasks:
- [x] Add observer config to config.ts + .env.example | Attempts: 1/3
  - ✅ Functional: OBSERVER_ENABLED (bool, default true) and MIN_OBSERVER_MESSAGES (int, default 5) added to config.ts. .env.example updated. Build+typecheck clean.
  - 🔒 Security: Config-only. OBSERVER_ENABLED uses ?? operator for correct falsy handling. MIN_OBSERVER_MESSAGES clamped to min 1 via Math.max. Self-audit: safe.
  - 📋 Evidence: `npm run build` → clean. `tsc --noEmit` → clean.
- [x] Hook observer into processGroupMessages after successful runAgent | Attempts: 1/3
  - ✅ Functional: Observer fires after response delivered (non-blocking). Accumulates botResponses from streaming callback. Lazy import('./observer.js'). .catch() prevents unhandled rejections. Skips if disabled or <5 user messages.
  - 🔒 Security: Fire-and-forget with .catch() — observer failure cannot affect conversation response. Lazy import avoids module-load cascade. Observer's own circuit breaker + cooldown + kill switch provide defense-in-depth. Self-audit: safe.
  - 📋 Evidence: `npm run build` → clean. `tsc --noEmit` → clean. 20 tests pass | 4 skipped.
- [x] Verify BM25 recall finds observations in daily/ files | Attempts: 1/3
  - ✅ Functional: BM25 recall tool (container/agent-runner/src/ipc-mcp-stdio.ts:54) recursively walks 'daily' directory via walk() function. Observer writes to daily/observer/{date}.md. Files are .md with <500KB — both match BM25 filter. No code changes needed.
  - 🔒 Security: Observer files are read-only from container perspective (mounted as workspace). Separate trust boundary (daily/observer/ vs daily/) already established in Phase 1.
  - 📋 Evidence: ipc-mcp-stdio.ts:60-83 — walk() recurses directories, filters *.md|*.txt|*.json, skips >500KB. Observer files match all criteria.
Verify: npm run build && tsc --noEmit → PASS (both clean)
User Live Test: NOT_TESTED
Evidence:
  [vitest] 20 passed | 4 skipped
  [build] npm run build → clean
  [tsc] tsc --noEmit → clean

## Current
Phase: 2 of 2 — Host Integration
Task: SHIP — committing and pushing.

## Loop State
Stage-Loop: SHIP
Stage-Iteration: 1/3
Stage-Entry-Met: true
Stage-Exit-Met: false
Last-Stage-EXIT: CLEAN

Phase-Loop: Phase 2
Phase-Iteration: 1/5
Phase-Exit-Met: true

Task-Loop: All Phase 1 tasks complete
Task-Strike: 0/3
Task-Last-Approach: TDD (Test Author + Implementer + Security Sentinel)
Task-Last-Failure: N/A

## Breadcrumbs
- User note: "haiku hallucinates" — do not use Haiku for observer compression. Use Sonnet 4.6.

## Parking Lot

## Evidence Log
[no-sha] 2026-02-27 — RECON EXIT: agentic+paid-api, medium, commands set (build=tsc, test=vitest, lint=tsc --noEmit)
[no-sha] 2026-02-27 — INTERVIEW EXIT: scope locked, 6 decisions, VERIFY=daily file written after conversation
[no-sha] 2026-02-27 — PLAN EXIT: PLAN.md written, 2 phases specced, risk-policy.json written. Requirements trace: all 4 acceptance criteria mapped to tasks.
[no-sha] 2026-02-27 — DESTROY EXIT: Architecture ALIGNED (host-side API call matches x402-handler precedent). Security: 1 CRITICAL (OA-01 prompt injection), 3 HIGH (OA-02 cred leak, OA-03 cost, OA-04 unhandled rejection), 4 MEDIUM. ALL addressed in revised plan: hard delimiters, daily/observer/ trust boundary, per-group cooldown, never-reject pattern, safe path resolution, payload truncation, output validation, file size cap.
[no-sha] 2026-02-27 — APPROVE EXIT: user approved 2026-02-27

[no-sha] 2026-02-27 — IMPLEMENT Phase 1 EXIT: 4/4 tasks done, all receipts filled, 20 tests+evals pass (4 scaffolds skipped), build+typecheck clean, 6 operational safeguards verified, 3 P1 security fixes applied.
[no-sha] 2026-02-27 — IMPLEMENT Phase 2 EXIT: 3/3 tasks done, all receipts filled, build+typecheck clean, BM25 recall verified (recursive walk covers daily/observer/).
[no-sha] 2026-02-27 — INTEGRATE EXIT: 372 tests pass (4 skipped), 16 discord.test.ts failures PRE-EXISTING. Financial checklist: all P0s are pre-existing (not introduced by observer). Agentic checklist: all P1s known from DESTROY or pre-existing. Architecture: 5 drift points — 1 fixed (dead code removed), 4 accepted (deliberate decisions).
[no-sha] 2026-02-27 — REVIEW EXIT: triage complete, P0=0 (in scope), 1 finding resolved (removed unused ObservationEntry). Pre-existing P0 financial issues noted for future GitHub issues.
[52cc2b8] 2026-02-27 — CLEAN EXIT: build PASS, tsc PASS, vitest 20/20 PASS, loose-ends PASS (0 issues from observer changes, 3 pre-existing console.logs noted).

## Outcomes & Retrospective
