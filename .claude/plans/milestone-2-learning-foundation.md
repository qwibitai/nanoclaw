# Milestone 2: Learning Foundation
**Created**: 28 March 2026 | **Target**: 29 March 2026 | **Project**: LearnClaw
**Re-baselined**: 29 March 2026

## Objective
Turn the fork into a learning-first self-hosted base with the first working study workflow: onboarding, durable learner state, packaged study content, and heartbeat-backed scheduled delivery.

## Acceptance Criteria
1. The fork presents itself as LearnClaw in the primary user-facing entry points for self-hosted usage.
2. New installs default to a LearnClaw identity without breaking custom assistant naming.
3. The default group templates and runtime guide the agent toward study planning, revision, quizzes, and learner memory files.
4. Non-main learner groups automatically scaffold `WHO_I_AM.md`, `STUDY_PLAN.md`, `RESOURCE_LIST.md`, and `HEARTBEAT.md` when onboarding begins.
5. `HEARTBEAT.md` cadence can be reconciled into deterministic managed recurring tasks for the self-hosted path.
6. The repository contains a starter UPSC package with plan, syllabus, resources, lesson, and quiz assets that scheduled prompts can use directly.
7. Automated tests cover onboarding and heartbeat synchronization behavior, and the branch passes typecheck plus the repo test suite.

## Approach
Keep the execution slice narrow and self-hosted. Do not attempt the full Telegram multi-tenant product yet. Instead, establish a stable learning workflow on top of the existing NanoClaw architecture: preserve runtime compatibility where possible, use files for learner state instead of inventing a new schema, and rely on package content for repeatable delivery rather than fully generated curriculum.

## Files Affected
- `README.md`
- `package.json`
- `package-lock.json`
- `src/config.ts`
- `src/index.ts`
- `src/onboarding.ts`
- `src/heartbeat.ts`
- `src/learning-content.ts`
- `setup/register.ts`
- `groups/global/CLAUDE.md`
- `groups/main/CLAUDE.md`
- `exams/README.md`
- `exams/upsc/meta.json`
- `exams/upsc/syllabus.json`
- `exams/upsc/resources.json`
- `exams/upsc/plans/6-month-prelims.json`
- `exams/upsc/lessons/foundation/ancient-india.md`
- `exams/upsc/quizzes/foundation/ancient-india.json`
- `src/onboarding.test.ts`
- `src/heartbeat.test.ts`
- `.claude/docs/architecture/system-overview.md`
- `.claude/docs/architecture/data-models.md`
- `.claude/docs/architecture/decisions.md`

## Tests Required
- Type-check the updated code.
- Run the repo test suite.
- Verify onboarding scaffolds learner state files without overwriting active learner files.
- Verify heartbeat reconciliation creates deterministic managed tasks and blocks scheduling when onboarding or timezone prerequisites are not satisfied.

## Out of Scope
- Multi-tenant Telegram bot architecture.
- Full spaced repetition engine and learning-specific mastery database schema.
- Production-grade exam packages beyond the first starter UPSC slice.
- Rebranding every internal runtime and service identifier.
- Auto-healing heartbeat timezone mismatches.
- Rich learner analytics beyond the durable markdown operating files.

## Dependencies
- Existing LearnClaw fork and milestone branch.
- No Qodo repo rules available locally; apply conservative changes.

## Fundability / Demo Value
This milestone converts the fork from a generic agent shell into a working self-hosted learning product slice. It is now credible to demo end-to-end: a learner can be onboarded, get a structured plan, receive scheduled study prompts, and run against packaged exam content instead of pure ad hoc prompting.