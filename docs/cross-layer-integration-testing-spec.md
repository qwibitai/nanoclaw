# Cross-Layer Integration Testing — Specification

*Feature-within-horizon: advances the [Test Ladder](test-ladder-spec.md) (kaizen #84) by closing the gap between L2 (integrated unit) and L6 (host pipeline).*

## 1. Problem Statement

Every test in NanoClaw mocks the layer below it. This creates invisible seams where cross-layer interactions break without any test noticing.

### The incident that exposed this

**Kaizen #120:** When a dev case is created linked to a kaizen issue (e.g., `--github-issue 111`), the CRM sync adapter fires via a mutation hook and creates a new issue in the CRM repo (e.g., `prints-demo#10`). It then calls `updateCase(c.id, { github_issue: 10 })`, overwriting the kaizen issue number. The case's link to its kaizen issue is destroyed. Collision detection breaks. Issue tracking breaks. The user had to manually fix the DB.

**Why no test caught it:** The execution chain crosses four layers:

```
ipc-cases.ts → cases.ts → mutation hook → case-backend-github.ts → cases.ts (updateCase)
     L2              L2          not tested          L1 (mocked)           L2
```

- IPC tests mock `cases.ts` → mutation hooks never fire
- Case tests use real SQLite but no hooks are registered
- Sync tests mock the GitHub API → field overwrites never hit a real DB
- The full chain is 0% tested

### The pattern is systemic

This isn't one bad test — it's a structural gap. The mutation hook system is the backbone of NanoClaw's extensibility (sync, escalation, future telemetry), but no test exercises it with real hooks wired to real DB operations.

Recent changes in the last 8 hours introduced dozens of hook and process improvements. Each was tested in isolation. None were tested in combination. The risk of silent regressions compounds with every change.

### Where this sits on the test ladder

The test ladder (kaizen #84) identifies L6 (host pipeline smoke) as the critical gap. But L6 requires refactoring `processGroupMessages()` for dependency injection — a significant prerequisite.

Between L2 (integrated unit) and L6 lies a high-value, low-cost testing layer that doesn't exist yet:

```
L2: Integrated Unit ← we're here (real SQLite, no hooks)
    ???             ← the gap: real SQLite + real hooks + mock only HTTP
L6: Host Pipeline   ← needs DI refactor of index.ts
```

This spec fills that gap with three phases, each independently implementable and independently valuable.

## 2. Desired End State

A dev agent makes a change to the mutation hook chain (cases, sync, escalation, IPC). It runs `npm test`. An integration test verifies that the full chain from case creation through hook firing through sync through DB update produces the correct result. If the sync adapter would overwrite a field it shouldn't, the test fails.

### What "good" looks like

```
Agent changes case-backend-github.ts
  → npm test
  → Phase A: Hook chain integration
    → insertCase with github_issue: 111 ............ PASS
    → sync fires, creates CRM issue ................. PASS
    → github_issue preserved (not overwritten) ...... PASS
    → escalation hook fires with correct data ....... PASS
    → updateCase fires hooks (no infinite loop) ..... PASS
  → Phase B: IPC simulation
    → case_create IPC → DB state correct ............ PASS
    → collision detection blocks duplicate ........... PASS
    → case_mark_done → sync closes issue ............ PASS
  Total: <2s, no Docker, in CI
```

### What is explicitly out of scope

- **Host pipeline refactor (L6).** That's a separate initiative requiring DI refactor of `index.ts`. This spec works with the existing architecture.
- **Real channel testing (L8-L9).** Channel-specific behavior is a separate dimension.
- **LLM testing (L10-L12).** Requires real API calls.
- **Docker-based E2E.** Tiers 1-2 already exist. Tier 3 depends on L6.

## 3. Architecture

### The chain under test

```
Entry point (test or IPC)
    ↓
[cases.ts] insertCase(case)
    ├── INSERT INTO cases (real SQLite)
    └── fireMutationHooks('inserted', case)
        ├── Hook 1: CaseSyncService → adapter.createCase()
        │   ├── [mock] createGitHubIssue() → returns { issueNumber: 10 }
        │   └── updateCase(c.id, { github_issue: 10, github_issue_url: ... })
        │       ├── UPDATE cases SET ... (real SQLite)
        │       └── fireMutationHooks('updated', updated, changes)
        │           └── Hook 1: filtered (meta-field only) → no-op ← PREVENTS LOOP
        └── Hook 2: onCaseEscalationEvent() → logger.info (observability)
```

### What's real vs mocked in each phase

| Component | Phase A | Phase B | Phase C (future) |
|-----------|---------|---------|-------------------|
| SQLite | Real (in-memory) | Real (in-memory) | Real (file) |
| `cases.ts` (insert/update) | Real | Real | Real |
| Mutation hooks | Real (registered) | Real | Real |
| `CaseSyncService` | Real | Real | Real |
| `GitHubCaseSyncAdapter` | Real (adapter logic) | Real | Real |
| `createGitHubIssue` (HTTP) | **Mocked** | **Mocked** | Real (staging) |
| `ipc-cases.ts` handlers | Not exercised | Real | Real |
| IPC file watcher | Not exercised | **Simulated** (direct call) | Real (file write) |
| `case-auth.ts` | Not exercised | Real | Real |
| Container spawn | Not exercised | Not exercised | Stub container |

### Test infrastructure layering

```
Phase A: Hook Chain Integration Tests
┌─────────────────────────────────────────────────┐
│ Real: SQLite + cases.ts + mutation hooks +       │
│       CaseSyncService + GitHubCaseSyncAdapter    │
│ Mock: createGitHubIssue (HTTP boundary only)     │
│ Cost: <100ms/test, zero external deps            │
└─────────────────────────────────────────────────┘

Phase B: IPC Simulation Tests
┌─────────────────────────────────────────────────┐
│ Real: Everything in Phase A +                    │
│       ipc-cases.ts handlers + case-auth.ts       │
│ Mock: createGitHubIssue, workspace creation      │
│ Cost: <200ms/test, zero external deps            │
└─────────────────────────────────────────────────┘

Phase C: E2E Tier 3 (future, separate spec)
┌─────────────────────────────────────────────────┐
│ Real: Everything in Phase B +                    │
│       container spawn + agent execution          │
│ Mock: Anthropic API (stub server)                │
│ Cost: ~60s/test, requires Docker                 │
└─────────────────────────────────────────────────┘
```

## 4. Phase A: Hook Chain Integration Tests

### Goal

Test the mutation hook chain with real hooks registered, real SQLite, and real adapter logic. Mock only the HTTP boundary (`createGitHubIssue`, `updateGitHubIssue`, `addGitHubIssueComment`).

### Test harness setup

Each test needs:

1. Fresh in-memory SQLite via `_initTestDatabase()`
2. Real `CaseSyncService` + `GitHubCaseSyncAdapter` instantiated
3. Mock `createGitHubIssue` / `updateGitHubIssue` / `addGitHubIssueComment` from `github-api.ts`
4. Hooks registered via `registerCaseMutationHook()` — same registration logic as `index.ts` lines 1084-1123
5. A way to clear hooks between tests (currently `mutationHooks` is a module-level array — may need a `_clearMutationHooksForTest()` export)

### Source changes required

The mutation hook system in `cases.ts` uses a module-level `mutationHooks` array with no way to clear it between tests. Two options:

**Option A (preferred):** Export a `_clearMutationHooksForTest()` function (underscore prefix signals test-only). Pattern already established by `_initTestDatabase()` in `db.ts`.

**Option B:** Use `vi.mock` to reset the module between tests. More brittle, less explicit.

### Test cases

These are the invariants that should always hold:

#### 1. Sync creates CRM issue on case insert
```
INVARIANT: When a case is inserted, the sync adapter creates a GitHub issue
           in the configured CRM repo.
SUT: insertCase → fireMutationHooks → CaseSyncService → adapter.createCase
VERIFICATION: Mock createGitHubIssue is called with correct owner/repo/title.
```

#### 2. Pre-existing github_issue is preserved after sync
```
INVARIANT: When a case is inserted with github_issue already set (e.g., linked
           to a kaizen issue), the sync adapter does NOT overwrite github_issue
           with the CRM issue number.
SUT: insertCase(case with github_issue: 111) → sync → updateCase
VERIFICATION: After all hooks fire, getCaseById().github_issue === 111.
```
**This is the test that would have caught kaizen #120.**

#### 3. Sync loop prevention works
```
INVARIANT: When sync calls updateCase with github_issue/github_issue_url,
           the re-fired mutation hook does NOT trigger another sync call.
SUT: updateCase with sync-only fields → fireMutationHooks → hook filter
VERIFICATION: createGitHubIssue called exactly once (not recursively).
```

#### 4. Escalation hook fires on case with priority
```
INVARIANT: When a case is inserted with priority and gap_type set,
           the escalation hook logs the event.
SUT: insertCase(case with priority + gap_type) → fireMutationHooks → escalation hook
VERIFICATION: Logger called with expected case ID, priority, and gap_type.
```

#### 5. Hook failure doesn't break case creation
```
INVARIANT: If a mutation hook throws, the case is still inserted and other
           hooks still fire.
SUT: insertCase → fireMutationHooks with a failing hook + a working hook
VERIFICATION: Case exists in DB. Working hook was called. Error was logged.
```

#### 6. Status transition triggers correct sync events
```
INVARIANT: When a case status changes to 'done', the sync adapter closes the
           CRM issue. Other status changes trigger 'status_changed'.
SUT: updateCase(id, { status: 'done' }) → fireMutationHooks → sync
VERIFICATION: adapter.closeCase called (not adapter.updateCase).
```

#### 7. Benign field updates don't trigger sync
```
INVARIANT: Updates to last_message, last_activity_at, costs, and time_spent
           do NOT trigger a sync call.
SUT: updateCase(id, { last_message: '...' }) → fireMutationHooks → hook filter
VERIFICATION: No adapter method called.
```

#### 8. Multiple hooks fire in registration order
```
INVARIANT: All registered mutation hooks fire in registration order,
           regardless of individual hook behavior.
SUT: registerCaseMutationHook(hook1), registerCaseMutationHook(hook2) → insertCase
VERIFICATION: hook1 called before hook2, both called.
```

### File location

```
src/cases-integration.test.ts
```

Naming: `*-integration.test.ts` follows the existing pattern (`download-coalesce.integration.test.ts`).

### Estimated effort

Small. The test harness setup is ~30 lines. Each test case is ~15-20 lines. Total: ~200 lines for 8 tests. The only source change is exporting a hook-clear function from `cases.ts`.

## 5. Phase B: IPC Simulation Tests

### Goal

Test the full IPC → case lifecycle → hook → sync chain by calling IPC handler functions directly (no file watcher). Exercises `ipc-cases.ts` handlers with real authorization gates, real case operations, and real hooks.

### Test harness setup

Everything from Phase A, plus:

1. Import `processCaseIpc` or `handleCaseCreate` from `ipc-cases.ts`
2. Real `authorizeCaseCreation` from `case-auth.ts` (with test-appropriate config)
3. Mock workspace creation (`createCaseWorkspace`) — git worktrees are expensive and not the SUT
4. Mock notification dispatch — no real Telegram messages
5. A helper to construct IPC data objects matching the expected schema

### Source changes required

`ipc-cases.ts` may need its internal handler functions exported for direct testing. Currently `processCaseIpc` is exported but delegates to internal functions like `handleCaseCreate`. Two options:

**Option A:** Test via `processCaseIpc` — more realistic, exercises the dispatch logic.

**Option B:** Export and test individual handlers — more granular, easier to set up.

Lean: **Option A** — test the same entry point the real IPC dispatcher uses.

### Test cases

#### 1. case_create IPC → full chain → correct DB state
```
INVARIANT: A case_create IPC request with all required fields creates a case
           in the DB, fires hooks, and produces a success result.
SUT: processCaseIpc(case_create data) → handleCaseCreate → insertCase → hooks
VERIFICATION: Case exists in DB with correct fields. Mock GitHub API called.
              Result object has case ID and name.
```

#### 2. case_create with githubIssue preserves link through sync
```
INVARIANT: A case_create IPC with githubIssue: 111 preserves that value
           through the entire chain including CRM sync.
SUT: processCaseIpc({ type: 'case_create', githubIssue: 111, ... })
VERIFICATION: DB shows github_issue: 111 (not CRM issue number).
```
**This tests #120 at the IPC boundary — even more realistic than Phase A.**

#### 3. Collision detection blocks duplicate github_issue
```
INVARIANT: If an active case already exists for github_issue: 111,
           a second case_create with the same github_issue is rejected.
SUT: processCaseIpc(case_create, githubIssue: 111) twice
VERIFICATION: Second call returns error result. Only one case in DB.
```

#### 4. case_mark_done triggers sync close + escalation
```
INVARIANT: Marking a case done triggers the sync adapter to close the CRM
           issue and fires the escalation hook with the status change.
SUT: Insert case → processCaseIpc({ type: 'case_mark_done', caseId })
VERIFICATION: adapter.closeCase called. Escalation hook sees status='done'.
```

#### 5. Authorization gate blocks unauthorized case creation
```
INVARIANT: A case_create from a non-main group for a dev case is rejected
           by the authorization gate before any DB write.
SUT: processCaseIpc(case_create, caseType: 'dev') from non-main group
VERIFICATION: No case in DB. Result indicates authorization failure.
```

#### 6. IPC field mapping preserves all fields through chain
```
INVARIANT: All IPC fields (description, context, shortName, caseType,
           githubIssue, gapType, signals) are correctly mapped to the
           Case object stored in the DB.
SUT: processCaseIpc with all optional fields set
VERIFICATION: getCaseById returns case with all fields matching input.
```

#### 7. case_suggest_dev creates case with correct type
```
INVARIANT: A case_suggest_dev IPC creates a case with type='dev' and
           status appropriate for the authorization decision.
SUT: processCaseIpc({ type: 'case_suggest_dev', ... })
VERIFICATION: Case type is 'dev'. Status reflects auth decision.
```

### File location

```
src/ipc-cases-integration.test.ts
```

### Estimated effort

Medium. The IPC handler setup is more complex — needs mock deps for workspace creation, notification dispatch, and group config. Each test is ~25-30 lines. Total: ~300 lines for 7 tests plus ~80 lines of setup.

### Dependencies

Phase A should be completed first — the hook chain setup from Phase A becomes a shared test utility.

## 6. Phase C: Docker-Based E2E Tier 3

### Goal

Test the full path from container-written IPC file through host processing through case creation through sync and back. This is the existing Tier 3 from the E2E spec (kaizen #71).

### Why it's Phase C (not first)

Tier 3 requires:
1. A running host process (or the L6 DI refactor to test the host pipeline in-process)
2. Docker for the container
3. Stub Anthropic API
4. IPC file watching

Phases A and B are 10-100x faster to run, need no Docker, and catch the same class of bugs at the DB/hook layer. Phase C catches bugs at the file-system and container-host boundary — a different (and rarer) class.

### Sketch (not fully specified — design when Phases A/B are done)

```
1. Start stub Anthropic API server
2. Start host IPC watcher (or DI-injected pipeline)
3. Spawn agent container with case_create prompt
4. Agent calls case_create MCP tool → writes IPC file
5. Host processes IPC → creates case → hooks fire → sync creates issue
6. Verify: case in DB, CRM issue created (mock), collision detection works
7. Teardown
```

**Decision:** Defer detailed design until Phases A/B are implemented and the L6 DI refactor status is clearer. The test infrastructure from Phases A/B will inform the right architecture for Tier 3.

## 7. Shared Test Infrastructure

### Test utilities to build

These utilities are used by both Phase A and Phase B tests.

#### `setupHookChainTestHarness()`

A factory function that wires up the full hook chain and returns handles for assertions:

```typescript
function setupHookChainTestHarness(options?: {
  mockGitHubResponses?: Partial<SyncResult>;
}) {
  // 1. Init test DB
  // 2. Create adapter + sync service
  // 3. Mock GitHub API functions
  // 4. Register mutation hooks (same logic as index.ts)
  // 5. Start sync service
  // Return: { adapter, syncService, mocks, cleanup }
}
```

#### `makeIpcData(overrides)`

A factory for IPC request objects with sensible defaults:

```typescript
function makeIpcData(overrides?: Partial<CaseCreateIpcData>): CaseCreateIpcData {
  return {
    type: 'case_create',
    description: 'Test case description',
    caseType: 'work',
    ...overrides,
  };
}
```

### File location

```
src/integration-test-harness.test-util.ts
```

The `.test-util.ts` extension excludes it from coverage checks (existing convention).

## 8. What Exists vs What Needs Building

### Already Solved

| Component | Implementation | Status |
|-----------|---------------|--------|
| In-memory test DB | `_initTestDatabase()` in `db.ts` | Working |
| Test case factory | `makeCase()` in `test-helpers.test-util.ts` | Working |
| Mutation hook system | `registerCaseMutationHook()` in `cases.ts` | Working |
| Sync adapter | `GitHubCaseSyncAdapter` in `case-backend-github.ts` | Working |
| Sync service | `CaseSyncService` in `case-backend.ts` | Working |
| GitHub API mock pattern | `vi.mock` on `github-api.ts` (used in existing tests) | Working |
| Tier 1-2 E2E | Container build + boot + IPC round-trip | Working |
| Test ladder taxonomy | 13 rungs defined in `test-ladder-spec.md` | Documented |

### Needs Building

| Component | What | Phase | Effort |
|-----------|------|-------|--------|
| Hook cleanup function | `_clearMutationHooksForTest()` in `cases.ts` | A | Trivial (~5 lines) |
| Hook chain test harness | `setupHookChainTestHarness()` utility | A | Small (~50 lines) |
| Hook chain integration tests | 8 tests in `cases-integration.test.ts` | A | Small (~200 lines) |
| IPC simulation helpers | `makeIpcData()` + mock deps | B | Small (~80 lines) |
| IPC integration tests | 7 tests in `ipc-cases-integration.test.ts` | B | Medium (~300 lines) |
| Tier 3 E2E | Container → IPC → host → DB verification | C | Large (separate spec) |

## 9. Open Questions

**Q1: Should the sync adapter guard against overwriting `github_issue`, or should the hook chain test just verify current behavior?**

The test should verify the *invariant* (github_issue is preserved). The fix for #120 should be implemented separately. The test is written first (TDD), fails (proving the bug), then the fix makes it pass. This is the standard kaizen workflow.

Lean: Write the test as part of Phase A. File or reference the fix as a separate task.

**Q2: Should Phase A tests go in the existing `cases.test.ts` or a new file?**

New file (`cases-integration.test.ts`). The existing file tests `cases.ts` functions in isolation. The integration tests wire up real hooks and test cross-layer behavior. Different purpose, different setup, separate file.

Lean: New file, `*-integration.test.ts` naming convention.

**Q3: Does `CaseSyncService.start()` need to be called for tests, or can we test synchronously?**

`CaseSyncService` has a queue + polling loop. For tests, we may need either:
- A `flush()` or `processQueue()` method to synchronously drain the queue
- Or to await the queue processing with a short timeout

This needs investigation during implementation. If the service processes events asynchronously, tests must wait for processing to complete.

**Q4: Can `processCaseIpc` be called directly, or does it depend on module-level state from `ipc.ts`?**

`processCaseIpc` takes a `deps` parameter. The deps structure needs to be understood and either constructed directly or partially mocked. Investigation required.

## 10. Implementation Sequencing

```
Phase A: Hook Chain Integration Tests
  ├── PR 1: Export _clearMutationHooksForTest + test harness utility
  └── PR 2: 8 integration tests (includes TDD test for #120 fix)

Phase B: IPC Simulation Tests
  ├── PR 3: IPC test harness + mock deps
  └── PR 4: 7 integration tests

Phase C: E2E Tier 3 (separate spec when A+B done)
  └── PR 5+: Requires L6 DI refactor or running host process
```

Each PR is independently mergeable. Phase A unblocks Phase B. Phase C is independent but benefits from the shared infrastructure.

### Impact on the test ladder

After Phase A: Cases domain moves from L2 to L2+ (integrated with hooks).
After Phase B: IPC + Cases domain moves to L2+ (integrated with auth + hooks + sync).
After Phase C: Full pipeline reaches L6.

### CI integration

Phase A and B tests run in the existing `ci` job (no Docker needed). They add <2s to the test suite. No changes to `ci.yml` required.

## 11. Relation to Other Specs

| Spec | Relationship |
|------|-------------|
| [Test Ladder](test-ladder-spec.md) (kaizen #84) | Horizon this feature advances. Fills the L2-to-L6 gap. |
| [E2E Test Harness](e2e-test-harness-spec.md) (kaizen #71) | Phase C extends Tier 2 into Tier 3. Phases A/B are complementary (host-side, not container-side). |
| Kaizen #120 | The incident that motivated this spec. Phase A test case #2 is the regression test. |
| Kaizen #19 (Enforce TDD) | Phase A demonstrates TDD: write failing test for #120, then fix. |
