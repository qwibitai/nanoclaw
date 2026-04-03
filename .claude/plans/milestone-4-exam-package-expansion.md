# Milestone 4: Exam Package Expansion
**Created**: 29 March 2026 | **Target**: 2 April 2026 | **Project**: LearnClaw

## Objective
Expand package coverage so LearnClaw can deliver more than a single starter UPSC slice and prove that the package-first architecture scales beyond one lesson and one quiz.

## Acceptance Criteria
1. UPSC package breadth expands beyond the starter Ancient India assets with additional lessons and quizzes across at least one more topic cluster.
2. Package structure and conventions are documented clearly enough that new packages can be added without reverse-engineering the first implementation.
3. Scheduled prompts and onboarding continue to resolve the correct packaged assets when package breadth grows.
4. Tests or fixtures cover package resolution behavior so added content does not silently break the runtime.

## Approach
Do not chase many exams at once. First prove content breadth on the UPSC path, then add one more package only if the structure remains clean. Focus on repeatable organization, naming, and selection rules so package growth stays reviewable in git.

## Files Affected
- `exams/upsc/`
- `exams/README.md`
- `src/learning-content.ts`
- `src/onboarding.ts`
- content selection tests under `src/`

## Tests Required
- Verify package resolution still picks valid lesson, quiz, and plan assets as package depth increases.
- Verify onboarding package summaries remain accurate when required files expand.
- Run `npm run typecheck` and `npm test`.

## Out of Scope
- Production-complete coverage for every UPSC topic.
- Simultaneous support for many exams with radically different pedagogies.
- Marketplace, import pipeline, or CMS tooling for package authors.

## Dependencies
- Milestone 2 merged or stable.
- Milestone 3 preferred but not strictly required if package selection remains file-driven.

## Fundability / Demo Value
This milestone proves LearnClaw is not a one-off prompt hack. It demonstrates that the product can accumulate reusable educational assets and improve in a way investors and collaborators can inspect directly.