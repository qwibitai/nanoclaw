# Roadmap — NanoClaw Concurrent Sessions

## Overview

Transform NanoClaw's GroupQueue from a single-container-per-group model to a multi-container model. Phase 1 delivers the core concurrency change with full test coverage. Phase 2 adds session awareness so concurrent containers can coordinate behaviourally.

## Phases

### Phase 1: Multi-Container GroupQueue

**Goal:** Multiple containers run concurrently for the same group, each with independent sessions and lifecycles.

**Dependencies:** None (foundation phase)

**Requirements:** CONC-01, CONC-02, CONC-03, CONC-04, CONC-05, COMPAT-01, COMPAT-02

**Plans:** 3 plans

Plans:
- [ ] 01-01-PLAN.md — Refactor GroupQueue data model from single-container to multi-container
- [ ] 01-02-PLAN.md — Update index.ts and task-scheduler.ts for multi-container API
- [ ] 01-03-PLAN.md — Rewrite and extend GroupQueue test suite

**Success Criteria:**
1. A second message to the same group spawns a new container while the first container is still running
2. Each concurrent container gets a fresh Claude session (no shared sessionId)
3. An idle-waiting container receives piped messages instead of spawning a new container
4. The global MAX_CONCURRENT_CONTAINERS cap (5) prevents more than 5 containers total across all groups
5. When only one message is active, behaviour is identical to the current single-container model — existing tests pass or are updated to reflect multi-container semantics

### Phase 2: Session Awareness + Deployment

**Goal:** Concurrent containers know about each other and can avoid conflicts through prompt context.

**Dependencies:** Phase 1

**Requirements:** OBS-01, OBS-02

**Success Criteria:**
1. `data/ipc/{group}/active_sessions.json` accurately lists all running containers for a group (name, start time, type, repos)
2. The file updates within 1 second of container start/exit
3. Each new container reads the session awareness file on startup and has the information available for prompt context
4. 2 GSD executions in different repos + 2 ad-hoc sessions run concurrently without git conflicts

## Progress

| Phase | Status | Plans | Completed |
|-------|--------|-------|-----------|
| 1 — Multi-Container GroupQueue | Planning Complete | 3 | 0 |
| 2 — Session Awareness + Deployment | Not Started | 0 | 0 |
