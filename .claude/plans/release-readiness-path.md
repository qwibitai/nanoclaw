# Release Readiness Path
**Created**: 3 April 2026 | **Project**: LearnClaw

## Goal
Ship LearnClaw on a structured path that balances speed and quality: get to a credible private alpha quickly, then earn public release through content depth, runtime safety, and one real learner-facing channel.

## Current State

What is already real:
- learner onboarding and durable learner state files
- heartbeat-backed lesson, quiz, and weekly report scheduling
- package-backed lesson and quiz resolution
- host-managed learning progress tracking
- topic-aware local content selection with runtime-safe fallback

What is still missing before broad release:
- broader exam content coverage beyond the starter UPSC slice
- host-side validation for group-local content and indexes
- one learner-facing distribution channel ready for real usage
- basic operational confidence under real scheduled usage

## Release Stages

### Stage 1: Private Alpha

Target outcome:
- 5 friendly users can complete onboarding, receive scheduled lessons and quizzes, and continue for at least 7 days without operator babysitting.

Required gates:
- Milestone 4 active and materially complete on UPSC breadth
- lesson and quiz content covers at least 3 topic clusters, not a single starter asset
- host validates group-local plans, lessons, quizzes, and index files before scheduled tasks rely on them
- runtime logs and failure messages are good enough to debug missed scheduling, bad assets, or broken quiz submissions quickly
- setup path is documented well enough that a second operator can run the system

Do not block alpha on:
- a polished public website
- broad multi-exam support
- advanced spaced repetition logic
- full SaaS-style admin tooling

### Stage 2: Closed Beta

Target outcome:
- one learner-facing channel works end to end and can support a small cohort outside the founder's direct supervision.

Required gates:
- Milestone 5 complete on a single distribution path, preferably Telegram
- onboarding, heartbeat sync, and learner progress work on channel-owned chats the same way they work in the self-hosted path
- basic recovery exists for channel auth drift, container failures, and malformed learner content
- package-selection and fallback behavior are covered by tests for realistic multi-topic content banks

### Stage 3: Public Release

Target outcome:
- people outside a hand-held cohort can start, learn, and stay inside the system without founder intervention on normal flows.

Required gates:
- one channel is stable in production-like use
- content bank is deep enough that the product does not feel like a wrapper around one starter lesson
- operational playbooks exist for setup, recovery, and debugging
- at least one week of cohort usage shows the loop holds under normal mistakes and missed schedules

## Immediate Execution Order

### Sprint A: Finish the Alpha Backbone

Primary objective:
- complete the highest-leverage Milestone 4 work that improves real learner relevance without slowing momentum.

Tasks:
- add host-side content validation for group-local plan, lesson, quiz, and index artifacts
- expand UPSC package breadth across at least two additional topic clusters
- add tests covering indexed selection across a larger local and package content bank
- keep changes narrow; do not start Telegram in parallel yet

Definition of done:
- content resolution remains deterministic as package depth grows
- malformed local assets are reported and safely bypassed
- targeted tests and typecheck pass

### Sprint B: Prove One Real Channel

Primary objective:
- finish Milestone 5 on one learner-facing path.

Tasks:
- implement the Telegram learner flow end to end
- verify onboarding injection, heartbeat sync, and quiz progress on Telegram-owned chats
- document auth, setup, and recovery steps tightly enough for repeatable use

Definition of done:
- a learner can be onboarded and coached on Telegram without custom manual routing

### Sprint C: Run the Cohort

Primary objective:
- validate retention and runtime safety with real users before any broad launch.

Tasks:
- run a 5-user closed alpha for 7 days
- collect failures in onboarding, scheduling, content gaps, and task recovery
- fix only blockers to continuity and trust; do not widen scope during the cohort

Definition of done:
- the core loop survives real usage with contained manual support

## Decision

The correct speed-quality balance is:
- go fast on Milestone 4 because it directly improves learner relevance
- do not split focus across Telegram until the content and validation spine is stronger
- treat private alpha as the first real ship target, not public launch