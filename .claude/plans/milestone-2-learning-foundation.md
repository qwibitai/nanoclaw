# Milestone 2: Learning Foundation
**Created**: 28 March 2026 | **Target**: 29 March 2026 | **Project**: LearnClaw

## Objective
Turn the fork into a learning-first self-hosted base by rebranding the default assistant identity, adding learning-specific workspace scaffolding, and defining the first exam package structure.

## Acceptance Criteria
1. The fork presents itself as LearnClaw in the primary user-facing entry points for self-hosted usage.
2. New installs default to a LearnClaw identity without breaking custom assistant naming.
3. The default group templates guide the agent toward study planning, revision, quizzes, and learner memory files.
4. The repository contains an initial exam-package scaffold for future learning content work.

## Approach
Keep the execution slice narrow. Do not attempt the full Telegram multi-tenant product yet. Instead, establish a stable self-hosted foundation on top of the existing NanoClaw architecture: rebrand the fork, preserve runtime compatibility where possible, and add content/package scaffolding that later milestones can consume.

## Files Affected
- `README.md`
- `package.json`
- `package-lock.json`
- `src/config.ts`
- `src/index.ts`
- `setup/register.ts`
- `groups/global/CLAUDE.md`
- `groups/main/CLAUDE.md`
- `exams/README.md`
- `exams/upsc/meta.json`

## Tests Required
- Type-check the updated code.
- Run targeted tests around registration/setup behavior if defaults change.
- Manually verify the README and template files reflect the LearnClaw learning direction.

## Out of Scope
- Multi-tenant Telegram bot architecture.
- Full spaced repetition engine and learning-specific database schema.
- Production-grade exam packages beyond the first scaffold.
- Rebranding every internal runtime and service identifier.

## Dependencies
- Existing LearnClaw fork and milestone branch.
- No Qodo repo rules available locally; apply conservative changes.

## Fundability / Demo Value
This milestone converts the fork from a generic agent shell into a recognizable learning product base, which is enough to demo the direction, onboard collaborators, and start building real education workflows in small increments.