# Verification Discipline

Learned from kaizen #11, #15, #17. These are mandatory practices for all dev work.

## Pre-Implementation Check — MANDATORY before writing utility code

Before writing ANY code that parses, transforms, or wraps a format/protocol/API, check if the problem is already solved:

```
1. CHECK package.json — is there already a dep for this? (`yaml`, `zod`, `ajv`, etc.)
2. GREP the codebase — does similar code exist? (`grep -r "YAML\|parse\|serialize" src/`)
3. SEARCH npm — is this a well-tested package with widespread adoption?
4. ASK: "What would a senior engineer reach for?" — not "what can I bang out fastest?"
```

**If a library exists in deps or on npm: use it.** Writing a hand-rolled parser, validator, or formatter when a tested library exists is not "keeping deps minimal" — it's creating MORE failure points. Policy #10 ("prefer simpler dependency stacks") means fewer ways to break, not fewer `package.json` entries.

**The anti-pattern:** You need to parse YAML. You think "it's a simple format, I'll use regex." You write 80 lines of fragile parsing. Self-review catches it. You rationalize "keeping deps minimal." You file it as a kaizen impediment instead of fixing it. The hand-rolled parser silently corrupts edge cases. *(This actually happened — kaizen #334.)*

**The fix:** Pause for 30 seconds before writing any utility code. Check what exists. Use it.

## Path Tracing — MANDATORY before any fix

Before writing ANY fix, map the full execution path from trigger to user-visible outcome:

```
1. MAP the chain: input → layer 1 → layer 2 → ... → user-visible outcome
2. For each link: how to verify it works, what artifact/log/query proves it
3. After the fix: verify EVERY link, not just the one you changed
4. Self-review must trace the path — "I changed layer N, what happens at N+1...?"
```

**Never fix a single layer and declare done.** The fix isn't complete until the final outcome is verified end-to-end.

## Invariant Statement — MANDATORY before writing tests

Before writing ANY test, state explicitly:

```
INVARIANT: [what must be true]
SUT: [exact system/function/artifact under test]
VERIFICATION: [how the test proves the invariant holds]
```

**Anti-patterns to avoid:**

- Testing mocks instead of real code (you're proving your mocks work, not your code)
- Testing the wrong artifact (e.g., `/app/dist/` when runtime uses `/tmp/dist/`)
- "All 275 tests pass" when none cover the actual change
- Verifying implementation details (`cpSync was called`) instead of outcomes (`agent has the tool`)
- Hardcoding values that the SUT computes (e.g., `PROJECT_ROOT="$REPO_ROOT"` bypasses testing path resolution)

**Meta tests — MANDATORY for infrastructure scripts:**
Scripts that resolve paths, detect environments, or set up state used by all subsequent logic MUST have tests that verify the resolution/detection itself — not tests that hardcode the resolved value and only test downstream logic. If a test bypasses the setup that the real script performs, it can't catch bugs in that setup. Examples:

- Path resolution: test that the output is absolute, points to the right directory, works from subdirectories and worktrees
- Environment detection: test that detection works in the actual environments it will run in (main checkout, worktree, background process)
- State initialization: test that initialization produces valid state, not just that functions work given pre-initialized state

## Runtime Artifact Verification

Always test the **actual deployed artifact**, not just source presence:

- If code is compiled, test the compiled output
- If code runs in a container, verify inside the container
- If a mount provides a file, verify the mount exists AND the consumer reads it
- "The file exists in the repo" is not verification — "the agent receives it at runtime" is

## Smoke Tests — MANDATORY when review identifies them

When a PR review says a smoke test is needed, **you must perform it before declaring the PR ready**. "Pending manual smoke test" is not an acceptable review outcome — it means the review is incomplete.

Smoke test checklist:

1. **Identify what to smoke test** — the review will name the untested path (e.g., "never hit real GitHub API", "never ran in container")
2. **Run it** — execute the actual end-to-end path. If it requires credentials or infrastructure you don't have, ask the user to provide them or run the test together.
3. **Record the result** — include the smoke test output (success or failure) in the PR or review comment.
4. **If you can't smoke test** — explicitly state what's blocking and ask the user. Don't hand-wave it as "recommended before deploy."

The point of review is to catch gaps. A gap identified but not closed is not a review — it's a TODO list.
