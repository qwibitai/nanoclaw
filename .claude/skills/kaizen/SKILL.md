---
name: kaizen
description: Recursive process improvement framework. Escalates fixes from instructions to hooks to mechanistic code. Triggers on "kaizen", "process improvement", "improve processes", "recursive kaizen".
---

# Recursive Kaizen — Process Improvement Framework

Kaizen means continuous improvement. **Recursive kaizen** means improving how we improve — escalating enforcement when a level fails.

## The Three Levels

When something goes wrong, the fix must match the severity and recurrence risk:

### Level 1: Instructions (CLAUDE.md)

**What:** Text policies, guidelines, documentation in CLAUDE.md or docs/.
**Enforcement:** None — relies on agent reading and following instructions.
**Cost:** Low (just write text).
**Strength:** Sets direction, covers novel situations, easy to change.
**Weakness:** Agents can and do ignore instructions. Humans forget.

**Use when:**
- First occurrence of an issue
- Direction-setting for new patterns
- Issues that require judgment (can't be mechanized)

**Examples:**
- "Always test before committing"
- "Ask Aviad before architecture decisions"
- "Close the loop with humans"

### Level 2: Hooks & Automated Checks

**What:** Pre-commit hooks, CI checks, Claude Code hooks, linting rules, automated validators that run automatically and can BLOCK actions.
**Enforcement:** Blocks the action (commit, merge, deploy, tool call) until check passes.
**Cost:** Medium (write a script, configure a hook).
**Strength:** Deterministic — can't be bypassed by agent forgetting.
**Weakness:** Can be circumvented with `--no-verify` or by disabling hooks.

**Use when:**
- Level 1 instructions were ignored or forgotten (same mistake twice)
- The check can be automated (test pass/fail, format check, file existence)
- The cost of failure is moderate (broken build, wasted time)

**Available mechanisms:**
- **Git pre-commit hooks** (`.husky/pre-commit`) — run before every commit
- **CI pipeline** (`.github/workflows/ci.yml`) — run on push/PR, block merge
- **Claude Code hooks** (`.claude/settings.json`) — run on tool calls, can block:
  - `PreToolUse` — block dangerous bash commands, protect files
  - `PostToolUse` — auto-format, validate after edits
  - `Stop` — verify tests pass before agent finishes
  - `UserPromptSubmit` — validate prompts
- **Linting rules** — eslint, prettier (already configured)

**Example escalation:**
```
Level 1: CLAUDE.md says "test before committing" → agent ignores it
Level 2: Pre-commit hook runs `npm test` → commit blocked if tests fail
```

### Level 3: Mechanistic / Architectural

**What:** The system design makes the wrong thing impossible or the right thing automatic. Built into the code path — no agent decision-making needed.
**Enforcement:** Structural — the code literally cannot proceed without the check.
**Cost:** High (design change, new code, new systems).
**Strength:** Can't be bypassed. Works without any agent awareness.
**Weakness:** Rigid, harder to change, may not cover edge cases.

**Use when:**
- Level 2 checks were bypassed or insufficient (same mistake three times)
- The cost of failure is high (production outage, human time wasted, data loss)
- The fix can be fully automated (no judgment needed)

**Examples:**
- Cookie auto-handler: harness detects cookie JSON in messages, auto-saves, tests, confirms — no agent involvement
- Timeout-based progress messages: harness sends "still working..." after 30s silence — agent can't forget
- Permission system: work agents can't write to `tools/` — architecturally impossible
- IPC type validation: harness rejects malformed IPC messages at parse time

**Example escalation:**
```
Level 1: CLAUDE.md says "close the loop with humans" → agent ignores Liraz for 2 hours
Level 2: Hook that alerts after 10min of no response to human request → still depends on agent
Level 3: Harness auto-detects human response patterns (cookie JSON) and processes them mechanistically
```

## The Kaizen Reflection

After EVERY fix-PR, ask:

1. **What level is this fix?** (1 = instructions, 2 = hook/check, 3 = mechanistic)
2. **Has this type of failure happened before?** If yes, the previous level wasn't enough — escalate.
3. **Could this failure recur despite the fix?** If yes, escalate.
4. **Is the enforcement proportional to the cost of failure?**
   - Low cost (formatting) → Level 1-2 is fine
   - Medium cost (broken build, wasted dev time) → Level 2 minimum
   - High cost (human time wasted, production impact, trust broken) → Level 3

## Escalation Decision Tree

```
Failure occurs
  ├─ First time? → Level 1 (instructions)
  ├─ Second time (same type)? → Level 2 (hooks/checks)
  ├─ Third time or high-cost failure? → Level 3 (mechanistic)
  └─ Affects humans directly? → Level 3 (humans should never wait on agent mistakes)
```

## Recursive Kaizen Checklist (for PR reviews)

When reviewing or creating a PR that fixes a problem:

- [ ] **Root cause identified** — not just the symptom
- [ ] **Fix level assessed** — which level is this fix?
- [ ] **Recurrence check** — has this type of failure happened before?
- [ ] **Escalation considered** — if Level 1, should it be Level 2? If Level 2, should it be Level 3?
- [ ] **Tested** — the fix is verified, not just written
- [ ] **Documented** — the lesson is in CLAUDE.md, not just memory
- [ ] **Process improved** — not just the one-time fix, but the process that allowed the failure

## Current Enforcement Stack

| Mechanism | Level | Where | What it enforces |
|-----------|-------|-------|-----------------|
| CLAUDE.md policies | 1 | Both repos | Direction, guidelines |
| Prettier pre-commit | 2 | `.husky/pre-commit` | Code formatting |
| CI pipeline (typecheck + tests) | 2 | `.github/workflows/ci.yml` | Build, types, tests |
| Git LFS tracking | 3 | `.gitattributes` | Binary files tracked correctly |
| Container read-only mounts | 3 | `container-runner.ts` | Work agents can't modify tools |
| Credential proxy | 3 | `credential-proxy.ts` | Secrets never in containers |

## Adding New Enforcement

When escalating to Level 2 (Claude Code hooks), add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "./.claude/hooks/guard-name.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

When escalating to Level 3 (mechanistic), the fix goes in `src/` as actual harness code — IPC handlers, container runner logic, or message processing middleware.
