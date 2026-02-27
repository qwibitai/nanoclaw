---
description: Quality assurance pattern - each AI reviewer has different strengths for comprehensive coverage
topics: [code-review, quality-assurance, ai-models]
created: 2026-02-24
source: https://x.com/elvissun/status/2025920521871716562
---

# Multi-model code review catches different error types

Every PR gets reviewed by three AI models because each catches different issues.

## Three-Reviewer System

**Codex Reviewer** (Most valuable):
- Exceptional at edge cases
- Most thorough review
- Catches: Logic errors, missing error handling, race conditions
- **False positive rate**: Very low
- **Trust level**: High

**Gemini Code Assist Reviewer** (Best value):
- **Free** and incredibly useful
- Catches: Security issues, scalability problems
- Suggests specific fixes
- **Value**: No-brainer to install

**Claude Code Reviewer** (Least useful):
- Tends to be overly cautious
- Lots of "consider adding..." suggestions (often overengineering)
- **Usage**: Skip everything unless marked "critical"
- Rarely finds critical issues alone
- **Value**: Validates what other reviewers flag

## Review Workflow

1. Agent creates PR via `gh pr create --fill`
2. CI runs (lint, types, unit tests, E2E, Playwright)
3. Three AI reviewers post comments on PR
4. All checks must pass before human notification

**Definition of Done**:
- [ ] PR created
- [ ] Branch synced to main (no merge conflicts)
- [ ] CI passing
- [ ] Codex review passed
- [ ] Gemini review passed
- [ ] Claude Code review passed
- [ ] Screenshots included (if UI changes)

## Human Review Optimization

**By the time human sees PR**:
- CI passed
- Three AI reviewers approved
- Screenshots show UI changes
- All edge cases documented in comments

**Result**: Human review takes 5-10 minutes

**Many PRs merged without reading code** - screenshots show everything needed

## UI Change Rule

**New rule (dramatically shortens review)**:
- If PR changes UI, must include screenshot in description
- Otherwise CI fails
- Human can see exactly what changed without clicking through preview

## Why Multiple Models Matter

Each model has different training, biases, and strengths:
- **Codex**: Best reasoning about complex logic
- **Gemini**: Best at security and scalability concerns
- **Claude**: Best at validating consensus (if all three agree, high confidence)

**Coverage through diversity**: What one model misses, another catches

## Cost vs Value

- Gemini: Free
- Codex: ~$100/month
- Claude: Included in existing subscription

**ROI**: Catches bugs before production, reduces human review time from 30min to 5min

## Related Notes
- [[Orchestration layer separates business context from coding context]]

## Source
Elvis - Three-model code review system in agent swarm setup

---
*Topics: [[code-review]] · [[quality-assurance]] · [[ai-models]]*
