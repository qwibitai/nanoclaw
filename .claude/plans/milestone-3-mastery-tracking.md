# Milestone 3: Mastery Tracking
**Created**: 29 March 2026 | **Target**: 31 March 2026 | **Project**: LearnClaw

## Objective
Add a minimal but durable mastery loop so quiz outcomes and weekly reports can update learner progress explicitly instead of depending only on conversation history.

## Acceptance Criteria
1. Learner workspaces gain a durable progress artifact that records weak topics, recent quiz outcomes, and next revision targets.
2. Scheduled quiz and weekly report flows can read and update that progress artifact deterministically.
3. The runtime preserves the current file-first operating model without introducing a premature complex learning schema.
4. Tests cover the write path for quiz/report updates and the read path for future lesson or quiz prompts.

## Approach
Keep this milestone boring and controlled. Do not build a full spaced-repetition engine yet. Start with a compact progress record that can live alongside the four existing learner files and be updated by the host or agent in a predictable shape. The goal is to make learner progress explicit enough that the next session and the next scheduled task can act on it honestly.

## Files Affected
- `src/learning-content.ts`
- `src/heartbeat.ts`
- `src/index.ts`
- `groups/global/CLAUDE.md`
- `src/` tests for learning progress update paths
- learner-state or progress document templates as needed

## Tests Required
- Verify quiz-result updates persist weak-topic and revision-target state.
- Verify weekly report generation can summarize stored progress rather than only chat history.
- Verify scheduled prompts can consume the progress state without breaking existing onboarding behavior.
- Run `npm run typecheck` and `npm test`.

## Out of Scope
- Adaptive spaced repetition algorithms.
- Numeric mastery scoring across all topics.
- Rich analytics dashboards.
- Multi-user cohort reporting.

## Dependencies
- Milestone 2 learning workflow merged or at least stable on branch.
- Durable learner files and heartbeat scheduling already in place.

## Fundability / Demo Value
This milestone turns LearnClaw from a scheduler into a coach with memory. It gives a founder-demo answer to the critical question: "Does the system actually learn how the learner is doing over time?"