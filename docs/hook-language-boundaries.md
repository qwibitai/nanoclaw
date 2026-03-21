# Hook Language Boundaries — Decision Framework

> **Living document.** Updated as hooks are migrated and new patterns emerge.
> Epic: [Garsson-io/kaizen#223](https://github.com/Garsson-io/kaizen/issues/223)

## The Decision Rule

**If a script needs arithmetic on command output, error recovery from multi-step pipelines, or its own test file with assertions — it has crossed the boundary.** Move it to TypeScript.

**The strongest signal:** If you find yourself hand-rolling error handling or assertions in bash, you've reimplemented `try/catch` + `expect()` badly. That's TypeScript's job.

## Complexity Taxonomy

| Level                       | Characteristic                                                         | Language       | Examples                                                        |
| --------------------------- | ---------------------------------------------------------------------- | -------------- | --------------------------------------------------------------- |
| **L1: Guards**              | Check condition, pass/block. No data transformation.                   | Bash           | File exists? Branch has case? Working dir clean?                |
| **L2: Pattern matching**    | grep/sed on command output, simple conditionals                        | Bash           | Check if branch is merged, find files matching pattern          |
| **L3: Data transformation** | Arithmetic, counting, aggregation, multi-step pipelines with fallbacks | **TypeScript** | Branch statistics, disk usage calculation, error classification |
| **L4: Testable logic**      | Needs assertions, mocking, shared utilities, error recovery            | **TypeScript** | Test runners, complex validation, anything with >1 test file    |

## Why TypeScript (not other languages)

| Language         | Startup | Type safety | Test framework       | Already in stack | Verdict           |
| ---------------- | ------- | ----------- | -------------------- | ---------------- | ----------------- |
| Bash             | 0ms     | None        | None (hand-roll)     | Yes              | Keep for L1-L2    |
| TypeScript (tsx) | ~200ms  | Full        | vitest (1100+ tests) | Yes              | Use for L3-L4     |
| Python           | ~50ms   | Optional    | pytest               | No               | Adds a dependency |
| Deno             | ~100ms  | TypeScript  | Built-in             | No               | Another runtime   |

TypeScript wins: already the primary language, established test framework, ~200ms startup is irrelevant for hooks that run a few times per session.

## Current Hook Inventory

### Bash — Appropriate (L1-L2)

| Hook                         | Lines | Level | Notes                                |
| ---------------------------- | ----- | ----- | ------------------------------------ |
| `enforce-case-worktree.sh`   | 30    | L1    | Simple guard                         |
| `check-cleanup-on-stop.sh`   | 40    | L1    | Advisory                             |
| `enforce-post-merge-stop.sh` | 42    | L1    | State check                          |
| `enforce-pr-review-stop.sh`  | 48    | L1    | State check                          |
| `enforce-pr-review-tools.sh` | 59    | L1    | Guard                                |
| `verify-before-stop.sh`      | 65    | L2    | Pattern match on compile/test output |
| `enforce-worktree-writes.sh` | 78    | L2    | Path matching                        |
| `check-verification.sh`      | 87    | L2    | Pattern match on PR body             |
| `enforce-pr-review.sh`       | 90    | L2    | State + pattern                      |
| `post-merge-clear.sh`        | 91    | L2    | State management                     |
| `check-practices.sh`         | 116   | L2    | Category matching                    |
| `check-test-coverage.sh`     | 119   | L2    | File pair matching                   |
| `check-dirty-files.sh`       | 120   | L2    | Status parsing                       |
| `enforce-pr-kaizen.sh`       | 121   | L2    | State + pattern                      |
| `warn-code-quality.sh`       | 121   | L2    | Pattern warnings                     |
| `check-wip.sh`               | 126   | L2    | Multi-source check                   |
| `enforce-case-exists.sh`     | 138   | L2    | DB query + guard                     |

### TypeScript — Migrated (L3-L4)

| Hook                       | Lines (TS) | Level | Migration                                                  |
| -------------------------- | ---------- | ----- | ---------------------------------------------------------- |
| `kaizen-reflect.ts`        | ~250       | L3    | Migrated in kaizen #320. Wrapper: `kaizen-reflect-ts.sh`   |

### Bash — Candidates for TypeScript Migration (L3-L4)

| Hook/Script                | Lines | Level | Migration Signal                                           |
| -------------------------- | ----- | ----- | ---------------------------------------------------------- |
| `pr-kaizen-clear.sh`       | 290   | L3    | State machine, multi-line parsing, validation              |
| `pr-review-loop.sh`        | 452   | L4    | Complex state machine, round tracking, multi-format output |
| `scripts/worktree-du.sh`   | ~300  | L3    | Arithmetic, data aggregation, caused the incident          |
| `scripts/run-all-tests.sh` | ~200  | L4    | Test runner, error classification, hand-rolled try/catch   |

### Shared Libraries

| Library                              | Lines | Status                                     |
| ------------------------------------ | ----- | ------------------------------------------ |
| `hooks/lib/parse-command.sh`         | 167   | L2 — regex matching, appropriate for bash  |
| `hooks/lib/state-utils.sh`           | 171   | L2 — file I/O + key derivation, borderline |
| `hooks/lib/allowlist.sh`             | 73    | L2 — pattern matching, appropriate         |
| `hooks/lib/send-telegram-ipc.sh`     | 45    | L1 — simple file write                     |
| `hooks/lib/resolve-main-checkout.sh` | 10    | L1 — one-liner                             |

### TypeScript Shared Libraries (new)

| Library                   | Lines | Purpose                                         |
| ------------------------- | ----- | ----------------------------------------------- |
| `src/hooks/hook-io.ts`    | ~35   | Read stdin JSON, write stdout — hook I/O layer  |
| `src/hooks/parse-command.ts` | ~100 | TS port of parse-command.sh — proper string ops |
| `src/hooks/state-utils.ts`  | ~130 | TS port of state-utils.sh — typed state files  |

## Migration Strategy

### Phase 1: Consolidate test infrastructure (DONE)

- [x] Extract shared test utils into `scripts/tests/lib/test-utils.sh`
- [x] DRY up duplicated assertions in `test-worktree-du.sh` and `test-resolve-cli-kaizen.sh`

### Phase 2: Document decision framework (DONE)

- [x] This document (`docs/hook-language-boundaries.md`)
- [x] CLAUDE.md policy section

### Phase 3: Migrate highest-value targets (IN PROGRESS — kaizen #320)

Priority order based on complexity, incident history, and test burden:

1. **`pr-review-loop.sh` (452 lines)** — **MIGRATED** → `src/hooks/pr-review-loop.ts` + 115 vitest tests
2. **`pr-kaizen-clear.sh` (290 lines)** — **MIGRATED** → `src/hooks/pr-kaizen-clear.ts` + typed JSON validation
3. **`kaizen-reflect.sh` (197 lines)** — **MIGRATED** → `src/hooks/kaizen-reflect.ts` + Telegram IPC
4. **`worktree-du.sh` (~300 lines)** — Not yet migrated. Lower priority because bugs were fixed.

Shared infrastructure created:
- `src/hooks/hook-utils.ts` — Stdin JSON parsing, git helpers, shell execution
- `src/hooks/parse-command.ts` — Command parsing (port of lib/parse-command.sh)
- `src/hooks/state-utils.ts` — State file management with atomic writes (port of lib/state-utils.sh)
- `src/hooks/telegram-ipc.ts` — Telegram notification via IPC files

Migration approach per script:

- Create TypeScript module in `src/hooks/`
- Port logic with proper types and error handling
- Add vitest tests (replacing hand-rolled bash tests)
- Thin bash wrapper calls `npx tsx` for Claude Code hook interface compatibility
- Old bash scripts deactivated with migration comments (kept for reference)

### Phase 4: Evaluate escalation to L2

- Track incidents per language after migrations
- If agents still create complex bash scripts despite this doc, add a hook that checks script complexity

### Phase 5: Consider native TypeScript hooks

- When Claude Code supports TypeScript hooks natively (no bash wrapper needed)
- Eliminates the ~200ms tsx startup overhead
- Until then, bash wrappers are the interface layer

## Evidence That Motivated This

| Evidence                                                | What it proves                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `grep -cv \|\| echo "0"` produced `"0\n0"`              | Bash error handlers can corrupt data silently — no type system catches it                   |
| `run_capturing()` needed in tests                       | Bash has no native way to capture stdout, stderr, and exit code separately                  |
| `assert_eq`/`assert_contains` duplicated in 3 locations | No shared test utilities — each file rebuilt from scratch                                   |
| `SCRIPT_ERROR_PATTERN` regex scanning stderr            | Error detection is heuristic ("does stderr contain 'syntax error'?") not mechanistic        |
| `pr-review-loop.sh` at 452 lines                        | State machines in bash require manual round-tracking, file-based state, hand-rolled parsing |

## Design Decisions

**Q: Should TypeScript hooks use `tsx` (dev) or compiled JS (prod)?**
A: `tsx` — hooks aren't latency-sensitive, and it avoids build step complexity. If startup becomes a problem, compile as an optimization later.

**Q: Should we migrate `claude-wt.sh`?**
A: Not yet. It's L2-L3 boundary — orchestration but mostly delegating. Migrate when it breaks or grows.

**Q: Shared bash test utils: single file or library dir?**
A: Single file (`scripts/tests/lib/test-utils.sh`). Not enough variety for a directory yet.

**Q: Should the decision framework be enforced (L2 hook) or documented (L1)?**
A: Start L1 (this doc). Escalate to L2 if agents repeatedly create complex bash scripts.
