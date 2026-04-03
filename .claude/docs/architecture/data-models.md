# Learning Workflow Data Models

## Durable Learner Files

### WHO_I_AM.md

Purpose: stable learner identity and constraints.

Expected content:
- Goal
- Current state
- Constraints
- Learning preferences
- Strengths and weak spots
- Motivation and accountability notes
- Exam context

Control field:
- `Onboarding status: pending|active`

### STUDY_PLAN.md

Purpose: current execution plan for the learner.

Expected content:
- Goal window
- Recommended track
- Phase list
- Current focus
- Adjustments over time

### RESOURCE_LIST.md

Purpose: ordered learning resources and packaged study sources.

Expected content:
- Foundation, practice, and revision resources
- Structured package source references
- Notes on why each resource matters

### HEARTBEAT.md

Purpose: delivery cadence and managed automation state.

Expected content:
- Timezone
- Proposed cadence lines such as `lesson: 07:00` or `weeklyReport: Sunday 08:00`
- Delivery rules
- Active automation summary written by the host runtime

### LEARNING_PROGRESS.json

Purpose: host-managed mastery snapshot for deterministic quiz/result tracking.

Expected content:
- `recentQuizOutcomes[]` with topic, score, total, submitted answers, correct answers, and incorrect question IDs
- `weakTopics[]` with topic, miss count, and last reviewed timestamp
- `nextRevisionTargets[]` as a compact queue of topics that need review next

Control properties:
- `version`
- `updatedAt`

## Managed Scheduled Tasks

Storage: SQLite `scheduled_tasks` table.

Managed IDs:
- `heartbeat-{group}-lesson`
- `heartbeat-{group}-currentaffairs`
- `heartbeat-{group}-quiz`
- `heartbeat-{group}-weeklyreport`

Important properties:
- `context_mode` is `group`
- `schedule_type` is currently `cron`
- prompts are host-generated from learner state and package context
- tasks are reconciled, not append-only

## Exam Package Shape

Current active package family: `exams/<slug>/`

Observed fields:
- `meta.json` for package identity, phases, cadence, and required assets
- `syllabus.json` for exam scope
- `resources.json` for resource sequencing
- `plans/*.json` for structured study plans
- `lessons/**/*.md` for prewritten lesson assets
- `quizzes/**/*.json` for deterministic quiz assets

## Runtime State Boundaries

Host-owned state:
- message loop
- learner file scaffolding
- heartbeat-to-task synchronization
- task persistence

Agent-owned state:
- learner profile content
- study plan adjustments
- resource prioritization
- lesson delivery and quiz framing

Host-owned mastery state:
- `LEARNING_PROGRESS.json` creation and maintenance
- deterministic quiz answer evaluation for structured learner replies
- weak-topic and revision-target updates

The split is intentional: the host guarantees orchestration integrity, and the agent owns pedagogical adaptation.