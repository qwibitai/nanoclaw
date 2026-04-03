# Architecture Decisions

## ADR-001 — Durable Markdown Learner State

**Date**: 29 March 2026  
**Status**: Accepted  
**Signed by**: Mr Fox

### Decision

Represent learner operating state in four durable markdown files inside the group workspace instead of introducing a new learning-specific database schema in Milestone 2.

### Why

- The product is still in the 0→1 phase.
- The agent already works naturally with files.
- Markdown keeps state auditable in git-shaped workflows and easy to inspect during debugging.
- It avoids premature schema design before mastery tracking and spaced repetition logic are stable.

### Consequence

The first learning loop is easy to ship and reason about, but deeper analytics and structured mastery tracking will require a later milestone.

## ADR-002 — Host-Synchronized Heartbeat Tasks

**Date**: 29 March 2026  
**Status**: Accepted  
**Signed by**: Mr Fox

### Decision

Use the host runtime to parse `HEARTBEAT.md` and reconcile managed scheduled tasks, rather than trusting the agent to schedule recurring tasks ad hoc.

### Why

- Prevent duplicate task creation across sessions.
- Keep scheduling deterministic and reviewable.
- Enforce safety checks such as onboarding completion and timezone alignment before automation starts.

### Consequence

The system is more predictable, but cadence parsing is intentionally narrow for now. More flexible scheduling rules belong in a later milestone once the operating model proves stable.

## ADR-003 — Package Content Before Generated Curriculum

**Date**: 29 March 2026  
**Status**: Accepted  
**Signed by**: Mr Fox

### Decision

Scheduled lesson and quiz prompts should resolve concrete exam-package assets first and only fall back to model-generated teaching when package coverage is thin.

### Why

- Repeatable content is easier to test.
- Quality is easier to review in git than freeform model output.
- This matches the product thesis: personalize delivery, do not reinvent the syllabus every turn.

### Consequence

The next scaling constraint is package breadth. Product quality now depends on expanding lesson and quiz libraries, not only on better prompting.

## ADR-004 — Host-Owned Minimal Mastery Artifact

**Date**: 29 March 2026  
**Status**: Accepted  
**Signed by**: Mr Fox

### Decision

Track learner quiz outcomes in a host-managed `LEARNING_PROGRESS.json` file rather than moving immediately to a database-backed mastery schema.

### Why

- Milestone 3 needs durable progress with low implementation risk.
- Quiz evaluation must be deterministic if weekly reports are going to say something concrete.
- A compact JSON artifact keeps the file-first operating model intact while still giving the host structured data to trust.

### Consequence

The system now has explicit learner progress memory without paying the complexity cost of a full learning engine. The next constraint is not storage; it is deciding how much adaptive behavior to build on top of this artifact before a true spaced-repetition model becomes justified.