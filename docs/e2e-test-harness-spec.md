# E2E Test Harness — Specification

## 1. Problem Statement

NanoClaw development aims to be fully autonomous — dev agents code, test, merge, deploy, and verify without human intervention. Today, all 48+ tests are hermetic: they mock Docker, channels, IPC, and external APIs. They verify that individual components work in isolation but never verify that **the assembled system works**.

This gap blocks autonomy at every stage:

- **A type error in agent-runner** (`gap_type`/`signals`, March 2025) passed all CI checks and only surfaced when Docker built the image. The container failed to start. Humans waiting in Telegram got nothing.
- **An IPC format mismatch** between host and container would pass all unit tests (both sides are tested with mocks) but fail at runtime when the real JSON files don't match.
- **A mount path change** in `container-runner.ts` would pass unit tests but break the container's access to tools, skills, or data at runtime.

The cost: every bug that lives at a component boundary requires a human to discover, diagnose, and fix. This is the single largest blocker to autonomous development.

### What exists today

| Test tier | What it covers | What it misses |
|-----------|---------------|----------------|
| Unit tests (`*.test.ts`) | Logic in isolation — routing, auth, config, IPC dispatch | Component boundaries, runtime behavior |
| Integration tests (`*.integration.test.ts`) | Multiple internal components wired together | Still mocks all I/O (Docker, channels, filesystem) |
| Contract check (`npm run contract:check`) | MCP tool declarations haven't drifted | Whether the tools actually work at runtime |
| Manual smoke test | Everything — but requires a human | Automation, repeatability, speed |

### What's missing

No test verifies that:
1. The container image builds successfully
2. The container boots and the MCP server registers tools
3. A host→container IPC round-trip produces a response
4. A message flows through routing → case → container → agent → response
5. A staging instance is actually isolated from production

## 2. Desired End State

A dev agent can:

1. Make a code change (harness or agent-runner)
2. Run `npm run test:e2e` — verifies the change works as an assembled system
3. Push, CI runs E2E tests as a merge gate
4. After merge, deploy to staging, run E2E against staging
5. If staging passes, deploy to production, verify health

No human in the loop. The E2E test harness is the safety net that makes this possible.

### What "good" looks like

```
Agent makes a change to ipc-mcp-stdio.ts
  → npm run test:e2e
  → Container builds .................. PASS (20s)
  → Container boots, tools register ... PASS (5s)
  → IPC round-trip .................... PASS (3s)
  → Message flow (canned response) .... PASS (10s)
  → Staging isolation ................. PASS (2s)
  Total: ~40s
```

### Explicitly out of scope

- **Channel-specific testing** (real Telegram/WhatsApp connections) — channels are already well-tested with mocks, and real channel testing requires external accounts
- **Agent quality testing** (does Claude give good answers) — that's a product concern, not infrastructure
- **Production monitoring** (is the live system healthy) — separate initiative
- **Auto-update system** (#50) — this spec provides the testing foundation that #50 depends on

## 3. Roles & Boundaries

| Actor | Role in E2E | What it needs |
|-------|-------------|---------------|
| Dev agent | Runs E2E tests after code changes | `npm run test:e2e` command |
| CI (GitHub Actions) | Runs E2E as merge gate | Docker available (GitHub Actions has it) |
| Staging instance | Isolated NanoClaw for safe testing | `NANOCLAW_INSTANCE=staging` (#66, already merged) |
| Stub agent | Replaces Claude API in tests | Canned responses, no API credentials needed |
| Real small model | Optional: validates real agent path | `claude-haiku-4-5`, conservative token budget |

## 4. Architecture

### Test tiers

```
Tier 1: Container Build + Boot (CI, every PR)
┌─────────────────────────────────────────┐
│ 1. Run container/build.sh              │
│ 2. Start container                      │
│ 3. Verify MCP server starts            │
│ 4. Verify all expected tools register   │
│ 5. Stop container                       │
└─────────────────────────────────────────┘
  ~30s, no API credentials, no .env needed

Tier 2: IPC Round-Trip (CI, every PR)
┌─────────────────────────────────────────┐
│ 1. Start staging instance (host)        │
│ 2. Start container with stub agent      │
│ 3. Write IPC request file               │
│ 4. Wait for IPC response file           │
│ 5. Verify response structure            │
│ 6. Teardown                             │
└─────────────────────────────────────────┘
  ~10s, canned responses, no API credentials

Tier 3: Full Message Flow (pre-deploy, staging)
┌─────────────────────────────────────────┐
│ 1. Boot staging NanoClaw instance       │
│ 2. Simulate inbound message via IPC     │
│ 3. Verify case creation (if applicable) │
│ 4. Verify container spawn               │
│ 5. Verify agent response arrives        │
│ 6. Verify staging DB has the message    │
│ 7. Verify production DB is untouched    │
│ 8. Teardown                             │
└─────────────────────────────────────────┘
  ~30-60s, can use smallest model or canned

Tier 4: Deploy Validation (post-merge, autonomous)
┌─────────────────────────────────────────┐
│ 1. Build (npm run build, container)     │
│ 2. Deploy to staging service            │
│ 3. Run Tier 3 against staging           │
│ 4. If pass → restart production         │
│ 5. Run health check against production  │
│ 6. Report to leads via Telegram         │
└─────────────────────────────────────────┘
  ~2-5 min, orchestration glue on top of Tier 3
```

### Stub agent design

For Tiers 1-2 (and optionally Tier 3), a stub agent replaces the Claude API:

```
Container starts → agent-runner initializes → MCP tools register
  → stub receives "message" → returns canned response
  → response written to IPC → host reads it
```

The stub needs to:
- Satisfy the Claude Agent SDK's interface (or bypass it at the right layer)
- Return deterministic responses for known test inputs
- Exercise the MCP tool registration path (the tools must actually load)

**Option A**: Mock at the SDK level — replace the Anthropic API client with a stub that returns canned messages. Agent-runner code runs unchanged.

**Option B**: Mock at the HTTP level — run a local HTTP server that mimics the Anthropic API. More realistic but more setup.

**Option C**: Environment variable switch — `NANOCLAW_AGENT_MODE=stub` makes the agent-runner skip Claude and echo back the input. Simplest, least realistic.

**Recommendation**: Option A. It tests the most real code while remaining deterministic and free.

### CI integration

```yaml
# New job in ci.yml
e2e:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v6
    - uses: actions/setup-node@v6
    - run: npm ci
    - run: npm run build
    - run: ./container/build.sh
    - run: npm run test:e2e
```

GitHub Actions runners have Docker available. The container build adds ~1-2 min to CI. E2E tests themselves add ~30-60s. Total CI time increase: ~2-3 min.

## 5. Interaction Models

### Scenario 1: Dev agent changes IPC format (happy path)

1. Agent modifies `ipc-mcp-stdio.ts` — adds new field to case_create tool
2. Agent runs `npm run test:e2e`
3. Tier 1: Container builds OK
4. Tier 2: IPC round-trip fails — host sends old format, container expects new field
5. Agent realizes it also needs to update `src/ipc-cases.ts`
6. Agent fixes, re-runs, all tiers pass
7. Agent pushes, CI confirms

### Scenario 2: Container Dockerfile change

1. Agent modifies `container/Dockerfile` — adds new system dependency
2. Agent runs `npm run test:e2e`
3. Tier 1: Container builds OK (or fails if dep doesn't exist — caught!)
4. Tier 2: IPC works, new dep is available in container
5. Agent pushes, CI runs E2E, confirms

### Scenario 3: Post-merge deploy (Tier 4)

1. PR merges to main
2. Deploy agent pulls main, runs `npm run build`
3. Runs `./container/build.sh` — if fails, stops, notifies leads
4. Starts staging: `NANOCLAW_INSTANCE=staging systemctl --user restart nanoclaw-staging`
5. Runs `npm run test:e2e:staging` — Tier 3 tests against live staging
6. If pass: `systemctl --user restart nanoclaw`, runs health check
7. Notifies leads: "Deployed. E2E passed."
8. If fail at any step: keeps production running, notifies leads with error

### Scenario 4: E2E test catches mount path regression

1. Agent refactors `container-runner.ts`, accidentally changes a mount path
2. Unit tests pass (they mock `docker run`)
3. `npm run test:e2e` — Tier 1 boots container, tool tries to read mounted file, fails
4. Agent sees the error, fixes the mount path
5. This class of bug can never reach production

## 6. State Management

| Component | State | Storage | Survives restart? | Test cleanup |
|-----------|-------|---------|-------------------|--------------|
| Staging DB | messages, cases | `store/staging/messages.db` | Yes | Wiped before each E2E run |
| Staging IPC dir | request/response files | `data/ipc/staging/` | Yes (files) | Wiped before each E2E run |
| Container | agent process, MCP server | Memory | No | Container stopped after test |
| Test fixtures | Canned messages, expected responses | `tests/e2e/fixtures/` | N/A (checked into repo) | N/A |

## 7. What Exists vs What Needs Building

### Already Solved

| Capability | Current implementation | Status |
|------------|----------------------|--------|
| Staging instance isolation | `NANOCLAW_INSTANCE` in `config.ts` (#100) | Merged |
| Container build script | `container/build.sh` | Working |
| IPC file-based communication | `src/ipc.ts` + `container/agent-runner/src/ipc-mcp-stdio.ts` | Working |
| Contract manifest | `npm run contract:check` | Merged, in CI |
| Docker in CI | GitHub Actions ubuntu runners | Available |
| Systemd service | `setup/` scripts | Working |
| Unit + integration tests | vitest, 48+ tests | Working |

### Needs Building

| Component | What | Why it doesn't exist yet |
|-----------|------|-------------------------|
| **Stub agent** | Mock Anthropic API client for deterministic test responses | E2E concept is new |
| **E2E test runner** | Orchestrates container lifecycle, IPC, assertions | New |
| **Tier 1 tests** | Container build + boot + tool registration verification | New |
| **Tier 2 tests** | IPC round-trip with stub agent | New |
| **Tier 3 tests** | Full message flow against staging instance | New |
| **Tier 4 script** | Deploy orchestration: build → staging → test → production | New (but mostly glue) |
| **Staging systemd service** | `nanoclaw-staging.service` unit file | Trivial — copy of production with `NANOCLAW_INSTANCE=staging` |
| **CI e2e job** | New job in `ci.yml` with Docker | New |
| **Test fixtures** | Canned messages and expected responses | New |

## 8. Open Questions & Known Risks

### Open Questions

1. **Stub agent layer**: Where exactly to mock — SDK client, HTTP, or agent-runner mode switch? Recommendation is SDK client mock (Option A), but needs investigation into whether the Claude Agent SDK supports dependency injection for the API client.

2. **CI Docker build caching**: Container builds take 1-5 min uncached. GitHub Actions has Docker layer caching — should we set it up to keep CI fast? Probably yes.

3. **Flakiness risk**: E2E tests are inherently flakier than unit tests (timing, port conflicts, Docker state). What's the retry policy? Suggestion: 1 retry with fresh container state, then fail.

4. **Tier 4 service management**: The deploy agent needs permission to restart systemd services. Currently the dev agent runs as the user — `systemctl --user restart nanoclaw` should work. But staging needs its own service unit.

5. **Test isolation between tiers**: Should tiers run sequentially (Tier 1 passes → Tier 2 runs) or all in parallel? Sequential is safer and makes failure diagnosis easier. Parallel is faster.

### Known Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| E2E tests add 2-3 min to CI | Slower PR feedback | Docker layer caching, parallel jobs, only run on relevant file changes |
| Stub agent diverges from real agent behavior | False confidence | Tier 3 with real small model catches this; stub tests structural plumbing, not agent behavior |
| Container build flakiness in CI | Spurious CI failures | Retry policy, Docker cache, pinned base image |
| Port conflicts between staging and production | Staging tests affect production | Already solved by `NANOCLAW_INSTANCE` isolation (#100) |

## 9. Implementation Sequencing

### Dependency graph

```
Stub agent ─────────┬── Tier 1 tests ──┬── CI e2e job
                    │                  │
                    ├── Tier 2 tests ──┤
                    │                  │
Staging service ────┴── Tier 3 tests ──┴── Tier 4 deploy script
```

### Suggested PR sequence

| Order | PR | Depends on | Size | Risk |
|-------|-----|-----------|------|------|
| 1 | Stub agent + test fixtures | Nothing | M | Medium — SDK integration unknowns |
| 2 | Tier 1: container build + boot tests | #1 | S | Low |
| 3 | Tier 2: IPC round-trip tests | #1 | M | Medium — real container orchestration |
| 4 | CI e2e job | #2, #3 | S | Low — CI config only |
| 5 | Staging systemd service | Nothing (parallelizable) | S | Low |
| 6 | Tier 3: full message flow tests | #3, #5 | M | Medium |
| 7 | Tier 4: deploy orchestration script | #5, #6 | M | Medium — systemd + health checks |

### MVP (unblocks the most autonomy)

PRs 1-4: stub agent + Tier 1 + Tier 2 + CI job. This catches the entire class of "compiles but doesn't work at runtime" bugs that currently require human discovery. ~4 PRs, each independently mergeable.

### Full vision

PRs 1-7: complete autonomous deploy loop. Agent codes → tests → merges → deploys to staging → validates → promotes to production → verifies. No human required.
