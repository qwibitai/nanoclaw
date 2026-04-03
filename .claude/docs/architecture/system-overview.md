# Learning Workflow System Overview

## Purpose

LearnClaw now has a working self-hosted learning loop on top of the original NanoClaw runtime. The system combines host-managed orchestration with agent-authored learner state so a study conversation can become repeatable delivery instead of a one-off chat.

## Core Flow

1. A learner sends a message in a non-main group.
2. The host runtime formats the conversation and injects onboarding instructions when learner state is missing or still pending.
3. The agent updates or creates four durable files in the learner workspace:
   - `WHO_I_AM.md`
   - `STUDY_PLAN.md`
   - `RESOURCE_LIST.md`
   - `HEARTBEAT.md`
4. After a successful learner turn, the host runtime parses `HEARTBEAT.md` and synchronizes managed recurring tasks.
5. Structured learner quiz replies can now update a host-managed `LEARNING_PROGRESS.json` artifact.
6. Scheduled tasks wake the agent later with prompts grounded in learner state, stored progress, and packaged exam content.

## Host Components

### Message Runtime

- [src/index.ts](/Users/Shared/Scripts/LearnClaw/src/index.ts) runs the main message loop.
- It now injects onboarding instructions for learner groups before sending work to the container agent.
- It also triggers heartbeat synchronization after successful learner updates and during startup recovery.

### Onboarding Layer

- [src/onboarding.ts](/Users/Shared/Scripts/LearnClaw/src/onboarding.ts) is the host-side bridge between freeform learner conversation and durable study state.
- It detects available exam packages, infers the best package from learner messages, and scaffolds the four state files without overwriting existing learner data.
- It does not schedule tasks directly. It makes the agent produce state that later drives scheduling.

### Heartbeat Scheduler Bridge

- [src/heartbeat.ts](/Users/Shared/Scripts/LearnClaw/src/heartbeat.ts) treats `HEARTBEAT.md` as the authoritative cadence source for managed learning tasks.
- It parses the proposed cadence, checks onboarding status, validates timezone alignment, and creates deterministic recurring tasks in SQLite.
- Managed task IDs follow `heartbeat-{group}-{kind}` so the runtime updates or removes them cleanly instead of accumulating duplicates.

### Learning Content Resolver

- [src/learning-content.ts](/Users/Shared/Scripts/LearnClaw/src/learning-content.ts) resolves the current exam identity, active study focus, starter phase, starter lesson, and starter quiz from learner files plus exam package structure.
- It also surfaces host-managed progress context so scheduled prompts can see weak topics and revision targets.

### Learning Progress Tracker

- [src/learning-progress.ts](/Users/Shared/Scripts/LearnClaw/src/learning-progress.ts) owns the minimal Milestone 3 mastery loop.
- It maintains `LEARNING_PROGRESS.json`, evaluates structured quiz replies against the current packaged quiz asset, and updates weak topics plus next revision targets deterministically.
- The design is intentionally narrow: one compact progress artifact, no spaced-repetition engine yet.

## Content Layer

### Exam Packages

- The first live package is [exams/upsc/meta.json](/Users/Shared/Scripts/LearnClaw/exams/upsc/meta.json).
- Supporting assets now include syllabus, resources, a 6-month prelims plan, a starter Ancient India lesson, and a starter Ancient India quiz.
- The design intent is unchanged: package structure supplies curriculum shape, while the model personalizes delivery.

## Operating Constraint

This system deliberately blocks managed scheduling unless two conditions are true:

1. `WHO_I_AM.md` says onboarding is active.
2. The `Timezone:` line in `HEARTBEAT.md` matches the runtime timezone.

That keeps the first automation pass safe, deterministic, and easy to reason about.