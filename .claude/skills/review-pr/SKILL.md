# Review PR — Self-Review Checklist

Structured self-review for every PR before it can merge. The `pr-review-loop.sh` hook enforces that this review happens — this skill defines what to check.

**When to use:**
- Automatically triggered by `pr-review-loop.sh` after `gh pr create`
- Can also be invoked manually: `/review-pr <pr-url>`

## The Review Process

1. Run `gh pr diff <pr-url>` to see the full diff
2. If a linked ticket/issue exists (check PR body, branch name, commits for `#N` or `kaizen#N`), run `gh issue view` to read it
3. Walk through EVERY section below — don't skip sections even if they seem irrelevant
4. If issues found: fix, commit, push, log what you fixed
5. Re-review from step 1 (next round)
6. If clean: state "REVIEW PASSED" and proceed

## Checklist

### Requirements Verification

- Identify the linked ticket/issue
- If found: `gh issue view <number> --repo <repo>` — read it
- Produce a requirements checklist — list every requirement, mark each as DONE, PARTIAL, or MISSING
- If requirements are MISSING: implement them now, or explicitly note "deferred to follow-up: [reason]"
- If NO linked ticket: note "No linked ticket — code-only review" and proceed

### Clarity & Conventions

- Is it clear and understandable?
- Does it follow guidelines and conventions (CLAUDE.md, kaizen policies)?
- Are naming conventions consistent with the codebase?

### Testability & Correctness

- Is it designed for testability? What would make it more testable and correct?
- Do tests need harness, simulator, hypothesis, fixtures?
- Does the feature have a powerful testing harness that lets it test itself thoroughly?
- Reuse and extend existing test harnesses rather than building from scratch
- Does it have clear INVARIANTS and SUT?
- Did you smoke test it (actually ran it)?
- **Policy #18: Smoke tests ship WITH the feature.** If this PR introduces a new execution path (hook wrapper, script, CLI command, IPC handler), does it include smoke tests that exercise the real deployment path? "Tests later" = no tests. Check `.claude/kaizen/policies.md` #18.

### Code Quality & Refactoring

- Does it need DRYing up? More reuse? Refactoring?
- Does this feature touch ugly, convoluted code? Giant files with sprawling functions?
- Take time to refactor and leave the code in a better place than you found it

### Purpose & Impact

- Is the PR achieving its intended purpose? Is the intended purpose clear?
- Is it correct?
- Does it improve the codebase overall? Does it degrade anything? Create noise?

### Security & QoL

- Review security — any injection, path traversal, or trust boundary issues?
- Review QoL — is it improving the maintainability and understandability of the codebase?

### Documentation & System Docs

This section catches a common miss: shipping enforcement changes without updating the system documentation that agents rely on.

- **If hooks, CI checks, or branch protection changed:**
  - Update the enforcement inventory in `.claude/skills/kaizen/SKILL.md`
  - Update the system inventory in `.claude/kaizen/README.md`
- **If workflows, policies, or architecture changed:**
  - Update `CLAUDE.md` (the section that describes the changed system)
- **If test coverage for a capability was added or improved:**
  - Update the test ladder / capability inventory if one exists (`docs/test-ladder-spec.md`)
- **If the Dockerfile or CI pipeline changed:**
  - Update cache strategy docs in the Dockerfile header
  - Update the CI status checks list in `CLAUDE.md` (Merging PRs section)
- **If a new skill was added:**
  - Ensure it appears in the skills table in `CLAUDE.md` if it's a core workflow skill

### Kaizen

- Is this PR kaizen (improving processes)?
- Is it recursive kaizen (improving how we improve)?
- Should any fix be at a higher enforcement level (L1 → L2 → L3)?

## Escalation

After the maximum review rounds with remaining issues:

1. Comment on the PR summarizing unresolved issues:
   `gh pr comment <url> --body "@aviadr1 Self-review hit N rounds. Remaining issues: [list]. Need human eyes."`

2. Notify on Telegram with the PR URL and a problem summary
