# Contract.json Freshness — Specification

## 1. Problem Statement

`contract.json` is a machine-readable manifest of the surfaces NanoClaw exposes to verticals. It's tracked in git and verified by CI (`contract:check`). The problem: **it keeps going stale in the working tree, blocking agent workflows.**

### How it happens today

1. Agent runs `npm test` (or `npm run build` which triggers tests)
2. `generate-contract.test.ts` calls `execSync('tsx scripts/generate-contract.ts')` — this **overwrites contract.json** with a fresh `generatedAt` timestamp
3. Working tree is now dirty (contract.json modified)
4. Agent tries to `git push` or `gh pr create`
5. `check-dirty-files.sh` hook blocks the push
6. Agent must manually commit or restore contract.json
7. Every time, the kaizen reflection fires asking "why were these files left uncommitted?"

This is a recurring friction point. It's happened across multiple PRs and agents. The kaizen reflection correctly identifies the root cause each time, but nothing prevents it from recurring.

### Two distinct sub-problems

**Sub-problem A: Test side effect.** The test suite overwrites the real `contract.json` file as a side effect of running. This is the immediate cause of dirty-tree blocks during dev workflows.

**Sub-problem B: Keeping contract.json fresh.** When source files change (new MCP tool, new IPC type, new mount path), contract.json must be regenerated and committed. Today this is manual — the developer must remember to run `contract:generate`. CI catches staleness, but only after the push.

These are related but require different solutions.

## 2. Desired End State

- Running `npm test` never leaves the working tree dirty
- Contract.json stays in sync with source code without manual intervention
- CI still validates that contract.json matches source (safety net)
- The `generatedAt` timestamp doesn't cause spurious diffs
- Agents never get blocked by contract.json dirty-file violations

## 3. Sub-Problem A: Test Side Effect

### Option A1: Export `generateContract()` and test in-memory

**How:** Refactor `generate-contract.ts` to export the `generateContract()` function. Tests import it directly and assert against the returned object — never writing to disk.

```typescript
// Test calls generateContract() in-memory
const contract = generateContract();
expect(contract.surfaces.mcpTools).toContain('send_message');
```

The `contract:check` mode test could write to a temp file or use string comparison.

**Pros:**
- Clean separation — tests have zero side effects
- Faster — no subprocess spawn per test
- The test file already has the pattern (`getGeneratedContract()` helper), easy refactor

**Cons:**
- The "check mode" test still needs to exercise the CLI path (can use a temp dir)
- Two code paths: in-memory for tests, CLI for actual generation

**Complexity:** Low. ~30 min change.

### Option A2: Test writes to a temp file, restores original

**How:** Before tests run, snapshot contract.json. Tests write to the real path. Afterall hook restores the snapshot.

**Pros:** Minimal code change — just add before/after hooks

**Cons:**
- Still has a side effect (just cleaned up after)
- If tests crash, snapshot may not restore
- Race condition if multiple test suites run in parallel

**Complexity:** Low, but fragile.

### Option A3: Generate-contract accepts an output path

**How:** `generate-contract.ts --output /tmp/contract-test.json`. Tests pass a temp path.

**Pros:** Clean, no side effects, CLI behavior still tested

**Cons:** Slightly more change (argument parsing), but trivial

**Complexity:** Low.

### Recommendation for Sub-Problem A

**A1 + A3 combined.** Export the function for unit tests (fast, no I/O). Add `--output` flag for CLI integration tests (exercises the real path with a temp file). This is the most robust and fastest approach.

## 4. Sub-Problem B: Keeping contract.json Fresh

This is the more interesting design question. Several timing strategies exist, each with different tradeoffs.

### Option B1: Pre-commit hook (auto-regen on every commit)

**How:** `.husky/pre-commit` runs `contract:generate` and stages contract.json if changed.

```bash
# In .husky/pre-commit
npm run contract:generate --silent
git add contract.json
```

**Pros:**
- Contract always matches the code being committed
- Zero manual intervention
- Catches changes immediately

**Cons:**
- Adds ~1-2s to every commit (script parses 5+ source files)
- `generatedAt` timestamp changes on every commit → noisy diffs
- Commits that don't touch contract surfaces still regenerate

**Variant B1a: Conditional regen.** Only run if source files changed:
```bash
if git diff --cached --name-only | grep -qE '(ipc-mcp-stdio|ipc\.ts|container-runner|case-backend|Dockerfile)'; then
  npm run contract:generate --silent
  git add contract.json
fi
```

This eliminates the cost for unrelated commits.

### Option B2: CI auto-commit (regen in CI, push back)

**How:** CI runs `contract:generate`. If contract.json changed, CI commits and pushes.

**Pros:**
- Developers never think about it
- Single source of truth (CI environment)
- No local hook overhead

**Cons:**
- CI pushes trigger another CI run (need loop detection)
- Branch protection may block CI pushes
- Merge timing issues — CI's commit may conflict with developer's next push
- More complex CI config
- Moves the authority from "developer verified" to "CI auto-generated"

### Option B3: Scheduled regeneration (cron / daily)

**How:** A cron job (or GitHub Actions schedule) regenerates contract.json on main daily/hourly.

**Pros:**
- Completely decoupled from dev workflow
- No commit overhead

**Cons:**
- Contract can be stale for hours/days between runs
- Creates orphan "chore: regen contract" commits unrelated to feature work
- Doesn't solve the branch problem — feature branches still need manual regen
- CI `contract:check` would still fail on PRs during the stale window

**Verdict:** Poor fit. The staleness window defeats the purpose.

### Option B4: On-idle regeneration (dev agent runs it between tasks)

**How:** A background agent or daemon watches for source file changes and auto-regens.

**Pros:**
- Near-instant freshness
- No commit-time overhead

**Cons:**
- Requires a watcher process (complexity, resource cost)
- Still creates dirty working tree (just earlier)
- Doesn't exist as infrastructure today — new system to build and maintain
- The watcher itself needs to know which files to watch (duplicates the contract generator's knowledge)

**Verdict:** Over-engineered for this problem.

### Option B5: Remove `generatedAt` from tracked content

**How:** The `generatedAt` field is the cause of ~90% of spurious diffs. Options:
- Remove it entirely from contract.json
- Move it to a `.contract-meta.json` file (gitignored)
- Only set it in CI-generated copies, use a fixed sentinel locally (e.g., `"generatedAt": "local"`)

**Pros:**
- Eliminates the most common cause of dirty-tree violations
- contract.json only changes when surfaces actually change
- Works with any of the other options

**Cons:**
- Loses the "when was this generated" metadata (minor — git log shows when it was last committed)
- Breaks consumers that rely on `generatedAt` (check: does anything read it?)

**This is not a timing strategy — it's a force multiplier for any strategy.** With timestamp removed, the dirty-tree problem mostly disappears regardless of when regeneration happens.

### Option B6: Pre-push hook (regen before push)

**How:** `.husky/pre-push` runs `contract:check`. If stale, auto-regens and amends the last commit (or creates a fixup commit).

**Pros:**
- Catches staleness right before it would hit CI
- Only runs on push (not every commit)

**Cons:**
- Amending is forbidden by CLAUDE.md policy
- A fixup commit changes the push content after review
- Adds latency to push

**Variant B6a:** Instead of auto-fixing, just warn:
```
⚠️ contract.json is stale. Run: npm run contract:generate && git add contract.json && git commit -m "chore: regen contract"
```

### Option B7: `contract:check` as pre-commit with fail-fast

**How:** Pre-commit hook runs `contract:check` (read-only). If stale, block the commit with an actionable message.

**Pros:**
- No auto-magic — developer sees the issue and commits intentionally
- No dirty-tree surprises (you're already committing)
- Fast — check mode doesn't write anything

**Cons:**
- Still requires manual `contract:generate` + re-commit
- Agent sees it as a pre-commit failure → kaizen reflection loop

**This is the current CI behavior, just moved earlier.** Faster feedback but same manual resolution.

## 5. Interaction Between Sub-Problems

| A fix \ B fix | No B fix | B1 (pre-commit) | B5 (no timestamp) | B1+B5 |
|--------------|----------|-----------------|-------------------|-------|
| No A fix | Current pain | Tests still dirty tree | Tests still dirty tree (less often) | Tests still dirty tree (rare) |
| A1 (in-memory tests) | Manual regen | Auto-regen on commit | No spurious diffs, manual regen | Best: no test side effects, no spurious diffs, auto-regen |
| A3 (temp file) | Manual regen | Auto-regen on commit | No spurious diffs, manual regen | Same as A1+B1+B5 |

**Key insight:** Sub-problem A must be fixed regardless. Sub-problem B solutions are optional but reduce friction. B5 (remove timestamp) is a force multiplier that makes every other option work better.

## 6. Comparison Matrix

| Option | Solves test side-effect | Solves freshness | Complexity | Risk | Autonomous? |
|--------|------------------------|------------------|-----------|------|-------------|
| A1: In-memory tests | Yes | No | Low | None | N/A |
| A3: --output flag | Yes | No | Low | None | N/A |
| B1: Pre-commit hook | No | Yes | Low | Hook fatigue | Yes |
| B1a: Conditional pre-commit | No | Yes | Medium | False negatives on file matching | Yes |
| B2: CI auto-commit | No | Yes | High | Loop detection, branch protection | Yes |
| B3: Cron | No | Partial | Medium | Staleness window | Yes |
| B4: File watcher | No | Yes | High | New infrastructure | Yes |
| B5: Remove timestamp | Mostly | No (but reduces need) | Trivial | Metadata loss | N/A |
| B6a: Pre-push warning | No | No (just warns) | Low | None | No |
| B7: Pre-commit check | No | No (just blocks) | Low | None | No |

## 7. Open Questions

1. **Does anything consume `generatedAt`?** If not, B5 is a free win. If yes, what for?

2. **How often do contract surfaces actually change?** If it's every few PRs, the manual regen is low friction. If it's most PRs, automation pays off faster.

3. **Should contract.json be generated or derived?** An alternative framing: instead of tracking contract.json in git, generate it on-the-fly in CI and publish as an artifact. Verticals would fetch the latest from a release, not from git. This eliminates the staleness problem entirely but changes the consumer model.

4. **Pre-commit hook budget.** The existing pre-commit already runs linting. How much latency is acceptable? If the budget is tight, B1a (conditional) is better than B1 (unconditional).

5. **Should the dirty-file hook learn to ignore contract.json timestamp-only diffs?** This is a band-aid but could be implemented in hours while a proper fix is designed.

## 8. Suggested Starting Point (Not a Decision)

If I were sequencing this, I'd do:

1. **A1 + A3** — Fix the test side effect (hours, zero risk)
2. **B5** — Remove `generatedAt` from tracked content (trivial, eliminates 90% of friction)
3. **B1a** — Conditional pre-commit hook (optional, adds full automation)

Steps 1-2 alone would eliminate the recurring problem. Step 3 is nice-to-have.

## 9. Post-Implementation Critique (added 2026-03-18)

Added after PR #120 (Zod config validation) triggered the same dirty-tree pattern this spec describes.

### What's correct
- The two sub-problems (test side effect vs. freshness) are correctly identified and separated.
- The interaction matrix (Section 5) is useful — it shows A must be fixed regardless of B.
- B5 (remove timestamp) is correctly identified as the highest-leverage minimal change.
- The suggested starting point (A1 + B5) is the right call.

### What's over-engineered
- **10 options for a 15-minute fix.** The problem is: a test writes to a real file, and a timestamp causes noise diffs. The answer is obviously A1 + B5. Nobody needs a comparison matrix with cron jobs and file watchers to arrive there. Options B2 (CI auto-commit), B3 (cron), B4 (file watcher) are clearly bad fits and the spec says so — including them added length without informing the decision.
- **265 lines for a problem solvable in 3 commits.** The spec-to-implementation ratio is way off. A spec should be proportional to the uncertainty in the solution. Here, uncertainty is near zero.

### What's missing
- **No concrete incident data.** The spec says "it's happened across multiple PRs and agents" but doesn't cite which PRs, which agents, or how many times. Without incident counts, we can't tell if this is a 2x/week annoyance or a daily blocker.
- **`coverage/` is missing.** The same dirty-tree pattern applies to vitest coverage artifacts. The spec is narrowly focused on contract.json and misses the broader gitignore hygiene issue.
- **Open Question #3 is the most important and it's buried.** "Should contract.json be generated or derived?" — if the answer is "derived at CI time and published as an artifact," the entire spec collapses. That question should be resolved *before* evaluating the other options, not listed as an afterthought.

### What happened since
- PR #120 (Zod validation, unrelated) triggered the exact same dirty-tree friction with both `contract.json` and `coverage/`. The spec was merged 2026-03-18 but no implementation followed — the same pain continues.
- **Recommendation:** Skip further spec work. Implement A1 + B5 + add `coverage/` to `.gitignore`. Total: ~30 minutes.
