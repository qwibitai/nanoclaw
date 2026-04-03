# Changelog
<!-- Auto-generated at milestone completion. Grouped by version. -->
<!-- Format: ## [v{X}] — {date} — Milestone {N}: {name} -->
<!-- Categories: Added / Changed / Fixed / Removed -->

## [v0.5.0] — 29 March 2026 — Milestone 3: Mastery Tracking Progress
### Added
- Host-managed `LEARNING_PROGRESS.json` learner artifact for recent quiz outcomes, weak topics, and next revision targets
- Deterministic quiz-reply evaluation in the runtime for structured learner submissions like `QUIZ: 1A 2B 3C`
- Mastery-tracking unit coverage for progress writes and progress-aware weekly report prompt reads

### Changed
- Scheduled quiz prompts now instruct a fixed learner reply format so the host can evaluate results predictably
- Scheduled lesson, quiz, and weekly report prompts now include progress-artifact context alongside learner files and exam-package assets
- Global LearnClaw instructions now mention the host-owned learner progress artifact when it is present

## [v0.4.0] — 29 March 2026 — Milestone 2: First Working Learning Loop
### Added
- Host-side learner onboarding that scaffolds `WHO_I_AM.md`, `STUDY_PLAN.md`, `RESOURCE_LIST.md`, and `HEARTBEAT.md`
- Heartbeat synchronization that creates deterministic recurring tasks for scheduled lessons, quizzes, and weekly reports
- Learning task context resolution so scheduled prompts can pull packaged plan, lesson, and quiz assets from exam packages
- Starter UPSC content assets: syllabus, resources, 6-month plan, Ancient India lesson, and Ancient India quiz
- Architecture documentation for learner state, scheduling, and learning content flow

### Changed
- The non-main group runtime now injects onboarding guidance automatically until learner state becomes active
- The global LearnClaw operating instructions now treat `HEARTBEAT.md` as the source of truth for managed learning cadence
- The UPSC package meta scaffold now declares real required assets instead of only metadata placeholders

### Fixed
- Prevented duplicate heartbeat tasks by making managed task IDs deterministic per group and cadence type
- Blocked managed scheduling when onboarding is still pending or heartbeat timezone does not match runtime timezone

## [v0.1.0] — 28 March 2026 — Initial Setup
### Added
- Mr Fox CTO operating system infrastructure
- Session continuity and milestone tracking system
- Audit trail framework with four-agent review process
