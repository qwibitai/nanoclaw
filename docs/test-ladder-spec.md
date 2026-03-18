# Test Ladder — Specification

*"I want to become stronger."* Total victory — perfect testability, perfect validation — is the impossible ideal. We don't need to achieve it. We need to climb toward it, step by practical step.

## 1. Problem Statement

NanoClaw has 54 test files (~12K lines) covering host logic, and Tier 1-2 E2E tests that verify the container builds and processes an IPC round-trip. But between "components work in isolation" and "the system works in production" lies a large, uncharted gap.

### What fails in that gap

Real production incidents that passed all tests:

- **`gap_type`/`signals` type error** (March 2025): Agent-runner compiled on host but failed inside the container. All unit tests passed. Container didn't start. Users waiting in Telegram got nothing.
- **IPC format mismatches**: Both sides tested with mocks that agreed with each other but not with reality. Runtime failure.
- **Mount path changes**: Unit tests mocked the filesystem. Container couldn't access tools at runtime.

These bugs live at boundaries: host-container, container-API, channel-host. No existing test crosses those boundaries with real components.

### What's missing beyond the E2E harness

The E2E spec (#71) defines 4 tiers focused on the container pipeline. But there are entire dimensions of testability it doesn't address:

1. **Channel verification** — can we send a message through a real channel and verify it arrived? Can we inject a synthetic message that traverses the same code path as a real user message?
2. **Observability** — can a test see what happened *during* processing, not just the final output? Which case was the message routed to? What session ID was passed? What IPC files were created?
3. **Security verification** — are authorization gates actually enforced in the assembled pipeline? Can a blocked sender's message actually reach the agent?
4. **Host pipeline** — does the host orchestrator actually process a message from ingestion to response delivery? No test exercises this path today.

### The cost of the gap

Every bug at a component boundary requires a human to discover, diagnose, and fix. This is the single largest blocker to autonomous development. A dev agent that can't verify its changes work end-to-end must always defer to a human for the final "does it actually work?" check.

## 2. Desired End State

A dev agent makes a code change. It runs the test suite. If tests pass, the agent has justified confidence that the change works in production. Not certainty — certainty is the impossible ideal — but justified confidence proportional to the test coverage level achieved.

The test ladder provides:

1. **A shared vocabulary** — when someone says "this capability is tested at L8," everyone knows exactly what that means: real channel, synthetic messages, deterministic verification.
2. **A climbing strategy** — each rung is a piece of test infrastructure. Building rung N enables that level of testing for all capabilities. Teams can prioritize which rungs to build next.
3. **A capability matrix** — every NanoClaw capability has a current position on the ladder and a target position. We can see gaps and prioritize.
4. **Incremental progress** — no big bang. Each rung is independently valuable. Each capability can climb independently.

### What is explicitly out of scope

- **Designing the observability system.** We define the need and how it would be used for testing. The implementation is a separate initiative (see kaizen #82).
- **Implementing all rungs.** This spec defines the taxonomy and inventory. Implementation is broken into separate PRs via `/plan-work`.
- **WhatsApp and Slack testing.** We design the framework generically. Email and Telegram are the concrete examples. The patterns apply to other channels when needed.

## 3. The Test Ladder

Thirteen rungs, ordered by infrastructure cost, determinism, and what they prove. The ladder has two dimensions: **infrastructure depth** (how much of the real system is exercised) and **security coverage** (a cross-cutting taxonomy that maps onto the ladder).

### Infrastructure Rungs

#### L0: Static Analysis
**Cost:** Free (<10s). **Determinism:** 100%. **Requires:** Source code only.

TypeScript compilation (`tsc --noEmit`), Prettier formatting, contract validation. Catches type errors, missing imports, declaration drift.

**What it proves:** Code is well-formed and type-safe.
**What it misses:** Everything about runtime behavior.
**Status:** Done (CI).

#### L1: Pure Unit
**Cost:** Free (<1ms/test). **Determinism:** 100%. **Requires:** Node.js only.

Isolated function tests. All dependencies mocked. No I/O, no filesystem, no network. Tests individual functions produce correct output for given input.

**What it proves:** Function logic is correct in isolation.
**What it misses:** Whether mocks match reality. Whether components work together.
**Status:** Done (54 files, ~12K lines).

#### L2: Integrated Unit
**Cost:** Free (<100ms/test). **Determinism:** 100%. **Requires:** Node.js, temp dirs, in-memory SQLite.

Multiple real components wired together. Real SQLite (`:memory:`), real file I/O in temp directories. No Docker, no network, no external services.

**What it proves:** Components work together. Schema migrations work. File format contracts hold.
**What it misses:** Container behavior. Runtime mounts. Network I/O.
**Status:** Done (partial — DB, IPC auth, download coalescing).

#### L3: Build Verification
**Cost:** Low (~30s). **Determinism:** 100%. **Requires:** Docker daemon.

Container image builds successfully. TypeScript compiles inside the container. System dependencies (Chromium, git, Python, etc.) are installed and runnable.

**What it proves:** Dockerfile is valid. All system deps resolve. Agent-runner compiles.
**What it misses:** Whether the built image works at runtime.
**Status:** Done (Tier 1 E2E, PR #114).

#### L4: Container Boot + Tool Registration
**Cost:** Low (~30s). **Determinism:** 100%. **Requires:** Docker daemon.

Container starts, MCP server initializes, tools register. Tool list matches `contract.json`.

**What it proves:** Container boots. MCP server starts. Tool surface matches contract.
**What it misses:** Whether tools work when called.
**Status:** Done (Tier 1 E2E, PR #114).

#### L5: IPC Round-Trip (Stub API)
**Cost:** Low (~10s). **Determinism:** 100%. **Requires:** Docker, stub Anthropic server.

Container receives input via stdin, calls stub API, produces output with correct markers. No real LLM. Stub returns canned responses.

**What it proves:** Input contract. Output marker contract. Agent-runner pipeline. Stub API integration.
**What it misses:** Host orchestration. Session management. Real LLM behavior.
**Status:** Done (Tier 2 E2E, PR #114).

#### L6: Host Pipeline Smoke
**Cost:** Medium (~60s). **Determinism:** 100%. **Requires:** Docker, stub API, testable host pipeline.

The critical missing rung. Full host-side pipeline exercised: message arrives (injected) → routing → case assignment → container spawned (stub API) → response parsed → delivery to mock channel.

Tests the orchestration code in `index.ts` that no other test exercises:
- GroupQueue serialization and coalescing
- Container input assembly (mounts, env, session ID)
- Output parsing and response formatting
- Session ID persistence across messages
- Case workspace creation and mount injection

**What it proves:** The host can process a message from ingestion to response delivery.
**What it misses:** Real channel behavior. Real LLM output.

**Prerequisites:** Refactor `processGroupMessages()` in `src/index.ts` for dependency injection. Currently all dependencies are module-level globals — not testable without refactoring.

**Status:** Not done. This is the biggest gap.

#### L7: Observable Pipeline
**Cost:** Medium (~60s). **Determinism:** 100%. **Requires:** L6 infrastructure + structured event emission.

Same as L6, but the pipeline emits structured events at each processing step. Tests can assert not just on the final output but on the *sequence of internal decisions*:

```
message_received { jid, sender, timestamp }
  → sender_checked { allowed: true, rule: "allowlist-match" }
  → route_decided { case_id: "260318-case-1", confidence: 0.95 }
  → container_spawned { session_id: "abc", mounts: [...] }
  → ipc_dispatched { type: "send_message", target_jid: "..." }
  → response_delivered { channel: "telegram", jid: "..." }
```

**Why this matters for testing:**
- L6 tests "message in, response out." If it fails, you don't know WHERE in the pipeline it broke.
- L7 tests "message in, these 6 things happened in this order, response out." Failures are immediately localizable.
- The same event infrastructure enables production observability (kaizen telemetry, #82), debug logging, and cost attribution.

**What it proves:** Internal processing decisions are correct and traceable.
**What it misses:** Real channel behavior. Real LLM output.

**How observability would be used in tests:**
- Assert event sequence: "message was routed to case X, not case Y"
- Assert timing: "coalescing waited 500ms before spawning"
- Assert absence: "no container_spawned event for blocked sender"
- Debug failures: dump full event trace on test failure
- Regression detection: compare event traces across versions

**Status:** Not done. Depends on L6 + event emission infrastructure. The observability system itself is out of scope for this spec — what matters here is defining what tests would assert on.

#### L8: Synthetic Channel Injection
**Cost:** Medium (~60s). **Determinism:** 100%. **Requires:** L6 infrastructure + channel test adapters.

Instead of injecting messages at the DB/queue level (L6), inject them at the *channel adapter level*. A test channel adapter emits events indistinguishable from a real Telegram message or a real Gmail. The message traverses the same code path as a real user message — channel polling, message parsing, JID resolution, trigger checking, and only then enters the host pipeline.

**What this adds over L6:**
- Channel-specific message parsing (Telegram message objects, Gmail MIME parsing)
- Trigger pattern matching (does `@bot` prefix work? does auto-trigger fire?)
- JID resolution (is `tg:-5128317012` correctly mapped to the group?)
- Channel-specific sender extraction (Telegram user ID → name)

**Concrete examples:**

*Telegram test adapter:*
```
TestTelegramAdapter.injectMessage({
  chat: { id: -5128317012, type: "group", title: "Test Group" },
  from: { id: 12345, first_name: "Test", username: "testuser" },
  text: "@bot what's the status of case X?",
  date: Date.now() / 1000
})
// → assert: message processed, response sent via TestTelegramAdapter.sentMessages
```

*Gmail test adapter:*
```
TestGmailAdapter.injectEmail({
  from: "customer@example.com",
  to: "agent@garsson.io",
  subject: "Re: Case update",
  body: "Please check the latest order",
  threadId: "thread-123"
})
// → assert: message processed, reply sent to same thread
```

**What it proves:** Channel-specific message handling works end-to-end. The full path from "channel event" to "response delivered" is correct.
**What it misses:** Real network I/O. Real channel API quirks (rate limits, message size limits, encoding edge cases).

**Status:** Not done. Requires test adapter implementations per channel.

#### L9: Real Channel Loopback
**Cost:** High (~5-30s, requires credentials). **Determinism:** ~95%. **Requires:** Real channel credentials, network access.

Send a real message through a real channel and verify it arrives, is processed, and produces a response visible in the same channel.

**Concrete examples:**

*Telegram loopback:*
1. Test bot sends message to test group via Telegram API
2. NanoClaw's Telegram polling picks it up
3. Message is processed (stub API — no LLM needed)
4. Response appears in the test group
5. Test verifies response via Telegram API (`getUpdates` or webhook)

*Gmail loopback:*
1. Test sends email from `test@garsson.io` to `agent@garsson.io`
2. NanoClaw's Gmail channel picks it up
3. Message is processed (stub API)
4. Reply sent to same thread
5. Test verifies reply appears in the thread via Gmail API

**What this adds over L8:**
- Real network I/O (TLS, DNS, API auth)
- Real channel API behavior (rate limits, message formatting, encoding)
- Real credential/OAuth flow
- Proves the system works with the actual channel, not a simulation

**What it misses:** Real LLM behavior.

**Non-determinism sources:** Network latency, channel API rate limits, message delivery timing. Mitigated with retries and generous timeouts.

**Status:** Not done. Requires dedicated test channel credentials (test Telegram bot, test Gmail account).

#### L10: LLM Smoke (Real API, Controlled Prompts)
**Cost:** ~$0.01-0.05/test, 5-30s. **Determinism:** ~90%. **Requires:** Real API key, Docker.

First real LLM call. Carefully designed prompts with near-deterministic expected outputs. Verify the *structure* of the response, not exact wording.

**Concrete examples:**
- "Reply with exactly the word PONG" → response contains "PONG"
- "What is 2+2?" → response contains "4"
- System prompt says "Always start responses with [OK]" → response starts with "[OK]"

**What it proves:** API credentials work. Agent can make real API calls. Basic prompt → response pipeline works.
**What it misses:** Complex tool use. Multi-turn behavior. Judgment calls.

**Cost control:** Use Haiku (~$0.001/test). Run only on merge to main, not on every PR.

**Status:** Not done.

#### L11: LLM Tool Verification (Real API, Tool Calling)
**Cost:** ~$0.05-0.20/test, 10-60s. **Determinism:** ~85%. **Requires:** Real API key, Docker.

Agent calls specific MCP tools in response to prompts. Verify the tool was called with correct parameters and the IPC file was created.

**Concrete examples:**
- "Send a message saying 'hello'" → `send_message` IPC file created with text "hello"
- "Create a case called test-case for fixing the login bug" → `case_create` IPC file with name containing "test-case"
- "Schedule a daily reminder at 9am" → `schedule_task` IPC file with cron expression

**What it proves:** Agent understands tool definitions. Tool parameters are correct. IPC contract works with real LLM output.
**What it misses:** Complex multi-step workflows. Judgment about *when* to use tools.

**Status:** Not done.

#### L12: Full Behavioral
**Cost:** ~$0.10-1.00/test, 30-120s. **Determinism:** ~70-80%. **Requires:** Real API key, Docker, possibly real channels.

Complex multi-turn scenarios. Agent follows hooks, respects policies, handles ambiguous routing, creates appropriate cases, asks for clarification when needed.

**Concrete examples:**
- Multi-case routing: create 2 cases, send message related to case A → agent responds in case A context
- Escalation: send message that requires human approval → agent creates case with correct priority and notifies admin
- Kaizen reflection: mark case done → agent produces meaningful reflection
- Hook compliance: agent respects worktree restrictions, doesn't write to main checkout

**These are probabilistic.** Run N times, expect >80% pass rate. Track pass rate over time. Flag regressions when rate drops.

**What it proves:** The system works as a product. Agent behavior matches intent.
**What it misses:** Nothing — this is the summit we climb toward.

**Status:** Not done. Requires L6-L11 foundation.

### Summary Table

| Level | Name | Cost | Det. | Requires | Status |
|-------|------|------|------|----------|--------|
| L0 | Static Analysis | <10s | 100% | Source | Done |
| L1 | Pure Unit | <1ms | 100% | Node.js | Done |
| L2 | Integrated Unit | <100ms | 100% | Node + SQLite | Done |
| L3 | Build Verification | ~30s | 100% | Docker | Done |
| L4 | Boot + Tools | ~30s | 100% | Docker | Done |
| L5 | IPC Round-Trip | ~10s | 100% | Docker + stub | Done |
| **L6** | **Host Pipeline** | **~60s** | **100%** | **Docker + stub** | **Gap** |
| L7 | Observable Pipeline | ~60s | 100% | L6 + events | Not done |
| L8 | Synthetic Channel | ~60s | 100% | L6 + adapters | Not done |
| L9 | Real Channel Loopback | ~30s | ~95% | Real credentials | Not done |
| L10 | LLM Smoke | ~$0.02 | ~90% | Real API key | Not done |
| L11 | LLM Tool Verification | ~$0.10 | ~85% | Real API key | Not done |
| L12 | Full Behavioral | ~$0.50 | ~70% | Real API + channels | Not done |

## 4. Security Testing Taxonomy

Security is a cross-cutting concern, not a single rung on the ladder. Each security category has a minimum infrastructure level required to test it meaningfully.

### S1: Input Validation
**Minimum level:** L1 (pure unit). **Determinism:** 100%.

Malformed inputs are rejected before they reach business logic. Covers: invalid JSON, SQL injection, path traversal in strings, malicious cron expressions, oversized payloads.

| Capability | What's tested | Current | Notes |
|-----------|--------------|---------|-------|
| Schedule validation | Invalid cron, negative intervals, timezone-suffixed timestamps | L1 | `validation.test.ts` |
| IPC path resolution | `..` traversal in container paths | L2 | `ipc-dispatch.test.ts` |
| Allowlist config | Malformed JSON, schema mismatches | L1 | `sender-allowlist.test.ts` |
| Case descriptions | Code-detection heuristic for auto-promotion | L1 | `case-auth.test.ts` |
| Group folder paths | `..` traversal in folder names | L2 | `ipc-auth.test.ts` |
| MCP tool inputs | Zod schema validation on all tool params | L1 | `lib.test.ts` |

**Gaps:**
- No fuzzing/property-based tests (kaizen #42)
- No null byte or Unicode edge case tests
- No payload size limit tests

### S2: Authorization Gates
**Minimum level:** L2 (integrated unit). **Target:** L6 (host pipeline).

Unauthorized actions are rejected at the gate. Covers: sender allowlist, case creation auth, IPC cross-group restrictions, main vs non-main privileges.

| Capability | What's tested | Current | Target | Notes |
|-----------|--------------|---------|--------|-------|
| Sender allowlist | Exact match, wildcard, deny-all, per-chat overrides | L2 | L8 | Real files, no pipeline test |
| Case creation auth | Work/dev detection, main vs non-main, auto-promotion | L1 | L6 | Pure mock, no DB verification |
| IPC task auth | Main can manage all; non-main restricted to self | L2 | L6 | Real SQLite |
| IPC message auth | Main sends anywhere; non-main to own chat only | L2 | L6 | Real SQLite |
| Group registration | Only main can register groups | L2 | L6 | Real SQLite |
| Mount security | Allowlist, blocked patterns, symlink resolution | **None** | L6 | **CRITICAL: Zero tests** |

**Critical gap: `mount-security.ts` has zero unit tests** despite being an authoritative security gate (per CLAUDE.md policy #15). It validates all volume mounts before container creation. Untested attack vectors include symlink traversal (e.g., `/tmp/link` → `~/.aws`), blocked pattern bypass (`.dotenv` vs `.env`), and race conditions between validation and mounting.

### S3: Mount & Filesystem Isolation
**Minimum level:** L3 (build verification). **Target:** L6 (host pipeline).

Containers can only access files they're authorized to see. Read-only mounts are actually read-only. Blocked paths (`.ssh`, `.aws`, `.env`, credentials) are inaccessible.

| Capability | What's tested | Current | Target | Notes |
|-----------|--------------|---------|--------|-------|
| Read-only project mount | Non-main groups get read-only | L1 | L6 | Mocked, never tested real mount |
| Blocked path enforcement | `.ssh`, `.aws`, `.env` inaccessible | **None** | L5 | Should verify inside container |
| Vertical mount isolation | Each vertical mounted at correct path | L1 | L5 | Mocked |
| Case workspace mount | Case gets own workspace directory | L1 | L6 | Mocked |

**Gaps:**
- No test verifies that a container *actually cannot* read a blocked path at runtime
- No test for symlink-based mount escapes
- No test that read-only mounts are actually read-only inside the container

### S4: Session & Case Isolation
**Minimum level:** L6 (host pipeline). **Target:** L7 (observable pipeline).

Case A's agent cannot see Case B's data, session, or workspace. Sessions don't leak across groups.

| Capability | What's tested | Current | Target | Notes |
|-----------|--------------|---------|--------|-------|
| Session per group | Different groups get different session IDs | L1 | L7 | Mocked, never tested real |
| Session per case | Different cases get different sessions | L1 | L7 | Mocked |
| Case workspace isolation | Case A can't read case B's workspace | L1 | L7 | Mocked |
| Dev worktree isolation | Dev cases get separate git worktrees | L2 | L7 | File-level test, no container |

**Gaps:**
- No test where two cases run concurrently and verify they can't see each other's data
- No test for session ID collision or reuse
- Cross-case blindness is architectural (separate containers, separate mounts) but never verified in an assembled pipeline

### S5: Instance Isolation
**Minimum level:** L7 (multi-component). **Target:** L9 (real channel loopback).

Staging and production instances cannot interfere. Different `NANOCLAW_INSTANCE` values produce fully separated systems.

| Capability | What's tested | Current | Target | Notes |
|-----------|--------------|---------|--------|-------|
| Directory separation | `-staging` suffix on all paths | L1 | L7 | Mocked fs |
| Port separation | Credential proxy on different ports | L1 | L7 | Mocked |
| Container image tags | `:staging` vs `:latest` | L1 | L7 | Mocked |
| DB isolation | Separate SQLite databases | **None** | L7 | Not tested |

### S6: Channel Security
**Minimum level:** L8 (synthetic channel). **Target:** L9 (real channel loopback).

Messages from unauthorized senders are dropped before reaching the agent. Channel authentication is valid. Responses go to the correct recipient.

| Capability | What's tested | Current | Target | Notes |
|-----------|--------------|---------|--------|-------|
| Blocked sender rejection | Message from blocked sender never reaches agent | L1 | L8 | Unit tested, never pipeline |
| Auto-trigger filtering | Only approved senders trigger without @mention | L1 | L8 | Unit tested |
| Response routing | Reply goes to correct chat/thread | L1 | L8 | Unit tested |
| Channel auth (Telegram bot token) | Bot authenticates to Telegram API | **None** | L9 | Never tested |
| Channel auth (Gmail OAuth) | OAuth flow produces valid token | L1 | L9 | Unit tested proxy |

### S7: Behavioral Compliance
**Minimum level:** L12 (full behavioral). **Determinism:** ~70%.

Agent follows policies even when the LLM "wants" to do something else. Covers: hook compliance, data access policies, escalation behavior.

| Capability | What's tested | Current | Target | Notes |
|-----------|--------------|---------|--------|-------|
| Worktree write restriction | Agent can't write to main checkout | Hook (L3) | L12 | Enforced by hook, not tested in pipeline |
| Case creation policy | Agent creates case when work is complex | **None** | L12 | Requires LLM judgment |
| Escalation behavior | Agent escalates when it can't handle request | **None** | L12 | Requires LLM judgment |
| Cross-case data discipline | Agent doesn't reference case A data in case B | **None** | L12 | Requires LLM + isolation |

## 5. Capability Inventory

Every NanoClaw capability, its current test level, and its target. Organized by domain.

### 5.1 Channels

| ID | Capability | Current | Target | Notes |
|----|-----------|---------|--------|-------|
| C1 | Channel registry (self-registration) | L1 | L6 | Mocked, never tested in host |
| C2 | Telegram receive (poll messages) | L1 | L9 | Mocked Grammy |
| C3 | Telegram send (text) | L1 | L9 | Mocked |
| C4 | Telegram send (image) | L1 | L9 | Mocked |
| C5 | Telegram send (document) | L1 | L9 | Mocked |
| C6 | Telegram send (video) | L1 | L8 | Mocked |
| C7 | Telegram bot pool (swarm identity) | L1 | L8 | Mocked |
| C8 | Gmail receive (email ingestion) | L1 | L9 | Mocked |
| C9 | Gmail send (in-thread reply) | L1 | L9 | Mocked |
| C10 | Sender allowlist enforcement | L2 | L8 | Real files, no pipeline |
| C11 | Auto-trigger (approved senders bypass @) | L1 | L8 | Mocked |

### 5.2 Message Processing

| ID | Capability | Current | Target | Notes |
|----|-----------|---------|--------|-------|
| M1 | Message storage (SQLite) | L2 | L6 | Real in-memory DB |
| M2 | Message history retrieval | L2 | L6 | Real DB |
| M3 | Message formatting (XML for agent) | L1 | L5 | Unit tested |
| M4 | Message coalescing (batch rapid messages) | L2 | L6 | Integration test |
| M5 | Download tracking | L2 | L6 | Real streams |
| M6 | Download-aware coalescing | L2 | L6 | Integration test |

### 5.3 Container Execution

| ID | Capability | Current | Target | Notes |
|----|-----------|---------|--------|-------|
| X1 | Container spawn (Docker run) | L1 | L5 | Mocked; real in Tier 2 |
| X2 | Volume mounts (correct paths) | L1 | L5 | Mocked; Tier 1 validates tools |
| X3 | Mount security (allowlist enforcement) | **None** | L6 | **CRITICAL GAP** |
| X4 | Output parsing (sentinel markers) | L1 | L5 | Tested in Tier 2 |
| X5 | Session resumption (pass session ID) | L1 | L6 | Mocked, never real |
| X6 | Credential proxy (OAuth/API key) | L1 | L5 | Unit tested |
| X7 | Container input contract (JSON format) | L2 | L5 | Validated in Tier 2 |
| X8 | Agent-runner boot (TS compile, MCP start) | L4 | L4 | Tier 1 |
| X9 | Tool registration (match contract.json) | L4 | L4 | Tier 1 |

### 5.4 MCP Tools (Agent-Facing)

| ID | Capability | Current | Target | Notes |
|----|-----------|---------|--------|-------|
| T1 | send_message (text to user) | L1 | L8 | Mocked IPC |
| T2 | send_image (file to user) | L1 | L8 | Mocked IPC |
| T3 | send_document (file to user) | L1 | L8 | Mocked IPC |
| T4 | send_video (video to user) | L1 | L7 | Mocked IPC |
| T5 | case_create | L1 | L8 | Mocked, auth gate tested |
| T6 | case_mark_done (+ kaizen reflection) | L1 | L8 | Mocked |
| T7 | case_get_status | L1 | L6 | Mocked |
| T8 | case_find | L1 | L6 | Mocked |
| T9 | schedule_task | L1 | L7 | Mocked |
| T10 | schedule_list | L1 | L6 | Mocked |
| T11 | schedule_cancel | L1 | L6 | Mocked |
| T12 | download_file (HTTPS fetch) | L2 | L6 | Real stream tests |

### 5.5 Cases

| ID | Capability | Current | Target | Notes |
|----|-----------|---------|--------|-------|
| K1 | Case CRUD | L2 | L6 | Real SQLite |
| K2 | Case lifecycle (status transitions) | L2 | L7 | Real SQLite |
| K3 | Case authorization gate | L1 | L6 | Unit tested |
| K4 | Case workspace (isolated directory) | L1 | L6 | Mocked fs |
| K5 | Dev case worktree (git isolation) | L1 | L7 | Mocked git |
| K6 | Worktree locking | L2 | L6 | Real file I/O |
| K7 | GitHub CRM sync (cases ↔ issues) | L1 | L8 | Mocked fetch |
| K8 | Escalation (priority, admin routing) | L2 | L7 | Real config files |
| K9 | Escalation notifications (Telegram) | L1 | L8 | Mocked channel |

### 5.6 Routing

| ID | Capability | Current | Target | Notes |
|----|-----------|---------|--------|-------|
| R1 | Single-case auto-route | L1 | L6 | Unit tested |
| R2 | Multi-case router (Haiku classification) | L1 | L12 | Requires LLM |
| R3 | Router prompt generation | L1 | L6 | Unit tested |
| R4 | Router container spawn | L1 | L7 | Mocked docker |
| R5 | Force routing (user explicit) | L1 | L8 | Unit tested |
| R6 | Suggest new case | L1 | L12 | Requires LLM judgment |

### 5.7 Scheduling

| ID | Capability | Current | Target | Notes |
|----|-----------|---------|--------|-------|
| S1 | Cron tasks | L2 | L7 | Real timers |
| S2 | Interval tasks | L2 | L7 | Real timers |
| S3 | One-shot tasks | L2 | L7 | Real timers |
| S4 | Task run logging | L2 | L7 | Real SQLite |
| S5 | Stale task reaping | L1 | L6 | Unit tested |

### 5.8 IPC

| ID | Capability | Current | Target | Notes |
|----|-----------|---------|--------|-------|
| I1 | IPC file dispatch (watcher → handler) | L1 | L6 | Mocked watcher |
| I2 | IPC message sending (container → host) | L1 | L5 | Tested in Tier 2 |
| I3 | IPC case lifecycle | L1 | L6 | Mocked |
| I4 | IPC GitHub issue proxy | L1 | L8 | Mocked fetch |
| I5 | IPC authorization | L2 | L6 | Real SQLite |
| I6 | IPC reaper (cleanup stale files) | L1 | L6 | Unit tested |
| I7 | Path resolution (container → host) | L2 | L5 | Real path ops |

### 5.9 Session & State

| ID | Capability | Current | Target | Notes |
|----|-----------|---------|--------|-------|
| SS1 | Session persistence (store/retrieve) | L2 | L6 | Real SQLite |
| SS2 | Session resumption (real SDK resume) | L1 | L10 | Never tested real |
| SS3 | Group memory (CLAUDE.md per group) | L0 | L6 | File exists |
| SS4 | Conversation archive (searchable) | L0 | L6 | Files exist |
| SS5 | Instance isolation (NANOCLAW_INSTANCE) | L2 | L7 | Unit tested |

### 5.10 Build & Deploy

| ID | Capability | Current | Target | Notes |
|----|-----------|---------|--------|-------|
| B1 | Container image build | L3 | L3 | Tier 1 |
| B2 | Contract validation (tool surface) | L4 | L4 | Tier 1 |
| B3 | Contract freshness | L1 | L2 | kaizen #83 |
| B4 | Vertical compatibility check | L1 | L2 | Unit tested |
| B5 | TypeScript compilation (host + agent) | L0 | L0 | CI |

## 6. The Gap Analysis

### Strengths

**L0-L2:** Excellent coverage. 54 test files, good invariant discipline, CI enforcement.

**L3-L5:** Tier 1 and Tier 2 E2E tests cover the container pipeline. Stub server exists and works.

### Critical Gaps

**1. L6 Host Pipeline — nobody tests the orchestrator.**
`processGroupMessages()` in `index.ts` is the heart of the system and has zero test coverage. All dependencies are module-level globals, making it untestable without refactoring to dependency injection. This is the single highest-value improvement.

**2. Mount security — zero tests on an authoritative security gate.**
`mount-security.ts` validates all container volume mounts. It's the only defense against container filesystem escapes. Zero unit tests. Symlink traversal, blocked pattern bypass, and race conditions are all untested attack vectors.

**3. No test crosses the host-container boundary with a real host.**
Tier 2 tests the container in isolation (stdin → stub API → stdout). L6 would test the host orchestrating a container. Nobody tests the seam between them — the code that assembles container input, passes session IDs, parses output markers, and persists state.

**4. Session continuity is assumed, never verified.**
Session ID is stored in SQLite and passed to the next container. Tests mock this. Nobody verifies that a second message actually resumes where the first left off.

**5. Channel behavior is entirely mocked.**
Every channel test mocks the channel library (Grammy for Telegram, Gmail API). No test sends a real message or verifies real receipt. Channel-specific edge cases (encoding, rate limits, large messages) are invisible.

## 7. What Exists vs What Needs Building

### Already Solved

| Component | Implementation | Status |
|-----------|---------------|--------|
| Unit test framework | Vitest 4.0.18, 54 test files | Mature |
| E2E test framework | `vitest.config.e2e.ts`, 3min timeout, sequential | Mature |
| Stub Anthropic server | `tests/e2e/stub-anthropic-server.ts` | Working |
| Container lifecycle helpers | `tests/e2e/helpers.ts` (build, spawn, cleanup) | Working |
| Tier 1 E2E | Container build + boot + tool registration | Working |
| Tier 2 E2E | IPC round-trip with stub agent | Working |
| CI pipeline | Format, typecheck, contract, tests, PR policy | Working |
| Test conventions | Invariant statements, `patch.object`, model factories | Documented |
| In-memory test DB | `_initTestDatabase()` in db.ts | Working |
| Test case factory | `makeCase()` in `test-helpers.test-util.ts` | Working |

### Needs Building

| Component | What | Why | Ladder rung |
|-----------|------|-----|-------------|
| Mount security tests | Unit tests for `mount-security.ts` | Authoritative security gate with zero coverage | L1-L2 |
| Host pipeline DI refactor | Extract `ProcessMessagesDeps` from `index.ts` | Unlock L6 testing | L6 prerequisite |
| Host pipeline smoke tests | Test message → orchestration → response | Biggest coverage gap | L6 |
| Processing event emitter | Structured events at each pipeline step | Enable observable testing + production telemetry | L7 |
| Test channel adapters | Synthetic Telegram/Gmail adapters for test injection | Test channel-specific paths | L8 |
| Test channel credentials | Dedicated test Telegram bot + Gmail account | Real channel loopback | L9 |
| LLM smoke test patterns | Controlled prompts with structural verification | First real API test | L10 |
| LLM tool verification | Prompt → tool call → IPC file assertion | Verify agent uses tools | L11 |
| Behavioral test framework | Probabilistic assertion, N-run, pass-rate tracking | Complex scenario testing | L12 |

## 8. Open Questions & Known Risks

### Open Questions

**Q1: Should L6 refactoring change the production code path?**
Option A: Refactor `processGroupMessages` to accept dependencies — production code changes, cleaner architecture, slight risk of introducing bugs.
Option B: Create a parallel test harness that wires real components differently — no production changes, but divergent code paths.
Lean: **Option A.** Dependency injection improves the code regardless. The risk is manageable with existing test coverage.

**Q2: What granularity of observability events?**
Fine-grained events (every function call) are noisy. Coarse events (just "message processed") are useless for debugging. The right granularity is probably 5-10 events per message processing cycle (received, filtered, routed, spawned, responded, delivered).
Deferred to observability initiative design.

**Q3: How to handle flaky L9-L12 tests in CI?**
Options: (a) Don't run them in CI — only in dedicated test jobs. (b) Run them but allow N% failure rate. (c) Run them as separate CI job that doesn't block merge.
Lean: **(c)** — separate job, advisory not blocking, with trend tracking.

**Q4: Test channel credentials — shared or per-developer?**
Shared test bot is simpler but creates contention. Per-developer bots are isolated but require setup.
Lean: Shared test bot for CI, per-developer optional for local testing.

### Known Risks

**R1: L6 refactoring scope creep.** Extracting dependencies from `index.ts` could snowball into a large refactor. Mitigated by: refactoring only what L6 tests need, not the entire file.

**R2: Observability overhead.** Event emission adds latency to every message. Mitigated by: make it opt-in via environment variable, default off in production until profiled.

**R3: LLM test costs.** At $0.50/test for L12, a full behavioral suite could cost dollars per run. Mitigated by: Haiku for smoke tests, Sonnet only for behavioral, run behavioral only on merge/nightly.

**R4: Channel loopback flakiness.** Real channels have rate limits, transient errors, and delivery delays. Mitigated by: generous timeouts, retries, and treating loopback tests as advisory (not blocking).

## 9. Implementation Sequencing

```
Phase 0: Quick wins (no infrastructure changes)
  └── Mount security unit tests (L1-L2, critical security gap)

Phase 1: L6 Foundation
  ├── Refactor processGroupMessages for dependency injection
  └── Write host pipeline smoke tests (7-10 tests)

Phase 2: Observability & Channels
  ├── Processing event emitter (L7)
  ├── Test Telegram adapter (L8)
  └── Test Gmail adapter (L8)

Phase 3: Real Channels
  ├── Test Telegram bot setup
  ├── Telegram loopback tests (L9)
  └── Gmail loopback tests (L9)

Phase 4: LLM Testing
  ├── LLM smoke patterns (L10)
  ├── LLM tool verification (L11)
  └── Behavioral test framework (L12)
```

Each phase is independently valuable. Phase 0 can start immediately. Phase 1 is the highest-value investment. Phases 2-4 can proceed incrementally.

## 10. Keeping the Ladder Current

### The Problem

The capability inventory (Section 5) and coverage matrix are only valuable if they reflect reality. A stale matrix is worse than no matrix — it creates false confidence. The inventory will rot through four predictable failure modes:

1. **New capability, no row.** Someone adds `send_reaction`. No one updates the inventory. The matrix silently becomes incomplete.
2. **Test added, matrix not updated.** Someone writes L6 tests for `case_create`. The matrix still says L1. The gap analysis overstates risk.
3. **Capability removed, row lingers.** A tool is deprecated. The matrix still tracks it. Noise accumulates.
4. **No enforcement on new work.** A dev case creates a new feature. Nothing prompts the agent to assess where it lands on the ladder.

### The Need

We need the ability to:

1. **Know what capabilities exist** — not just MCP tools (which contract.json covers) but channels, IPC handlers, host pipeline features, case lifecycle operations, scheduling.
2. **Know where each capability stands on the ladder** — its current test level and the gap to its target level.
3. **Prompt action when capabilities change** — when new work adds or modifies capabilities, the workflow should surface the test-level question before the work is considered done.
4. **Detect drift** — when the inventory diverges from the codebase, something should notice.

These are four aspects of one underlying need: **the system should know itself** — what it can do, and how well-tested each capability is.

### Maturity Scale for Inventory Currency

Like the test ladder itself, the ability to keep the inventory current has levels. We should climb this ladder too.

| Level | What | How it works | Failure mode |
|-------|------|-------------|-------------|
| **IC-1** | Instructions | This document says "update the inventory." Agents read it. | Agents forget. Inventory drifts silently. |
| **IC-2** | Prompted | A workflow step (hook, skill prompt, or review checklist) asks "which capabilities did you touch?" before work is marked done. | Agents dismiss the prompt. Inventory drifts slowly. |
| **IC-3** | Linked | Tests declare which capabilities they cover. Coverage can be computed from the test suite. | New capabilities without tests are invisible. |
| **IC-4** | Validated | CI checks that the inventory matches reality — like contract.json but for all capabilities. | Requires defining "reality" precisely enough to check mechanistically. |
| **IC-5** | Self-updating | The inventory is generated from the codebase, not maintained by hand. Drift is impossible by construction. | Requires the codebase to be structured enough to extract capabilities automatically. |

### Where We Are: IC-1

Today we're at IC-1. This document defines the inventory and says "update it." The PR review checklist mentions test coverage, but nothing specifically asks about the ladder. The `contract.json` mechanism is IC-4 for MCP tools specifically, but covers nothing else.

### Next Step: IC-2

The immediate next step is IC-2 — make the workflow *ask the question*. The specific mechanism (hook, skill prompt, PR template, review checklist item) is a design decision for when we implement it. What matters is the forcing function: before a dev case is marked done or a PR is merged, the agent should have answered "which capabilities did I touch, and where are they on the ladder?"

When IC-2 fails repeatedly (agents dismiss the prompt, inventory still drifts), that's the signal to escalate to IC-3.

### Open Questions for Future Levels

- **IC-3:** What format should test-to-capability links take? In-test comments? Separate manifest? Naming convention? Depends on what feels natural when we're actually at IC-2 and can see the friction.
- **IC-4:** What does "matches reality" mean for non-MCP capabilities? MCP tools are easy — they register explicitly. But "the host pipeline can coalesce messages" is implicit in code structure. How do you mechanistically verify that?
- **IC-5:** Is this even achievable? Or is the capability inventory inherently a human-curated artifact? Maybe the answer is IC-4 with good enough heuristics.

These questions are interesting but not actionable today. They'll become concrete when we're climbing from IC-3 to IC-4.
