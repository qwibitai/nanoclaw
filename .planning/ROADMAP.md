# Roadmap — NanoClaw

## Overview

NanoClaw is the container runtime for GorillaHubOS agents. Phases 1–2 delivered concurrent multi-container support. Phase 3 fixes the critical OAuth token expiry problem that causes Holly to go down every ~15 hours.

## Phases

### Phase 1: Multi-Container GroupQueue

**Goal:** Multiple containers run concurrently for the same group, each with independent sessions and lifecycles.

**Dependencies:** None (foundation phase)

**Requirements:** CONC-01, CONC-02, CONC-03, CONC-04, CONC-05, COMPAT-01, COMPAT-02

**Plans:** 3 plans

Plans:
- [x] 01-01-PLAN.md — Refactor GroupQueue data model from single-container to multi-container
- [x] 01-02-PLAN.md — Update index.ts and task-scheduler.ts for multi-container API
- [x] 01-03-PLAN.md — Rewrite and extend GroupQueue test suite

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

**Plans:** 2 plans

Plans:
- [x] 02-01-PLAN.md — Host-side session awareness file writer + lifecycle hooks + tests
- [x] 02-02-PLAN.md — Container-side awareness read + prompt injection

**Success Criteria:**
1. `data/ipc/{group}/active_sessions.json` accurately lists all running containers for a group (name, start time, type, repos)
2. The file updates within 1 second of container start/exit
3. Each new container reads the session awareness file on startup and has the information available for prompt context
4. 2 GSD executions in different repos + 2 ad-hoc sessions run concurrently without git conflicts

### Phase 3: OAuth Auto-Refresh

**Goal:** Claude Max OAuth access token refreshes automatically so Holly never goes down due to token expiry.

**Dependencies:** None (independent of Phases 1–2)

**Requirements:** OAUTH-01, OAUTH-02, OAUTH-03

**Plans:** 2 plans

Plans:
- [x] 03-01-PLAN.md — OAuth module + container-runner integration + tests
- [x] 03-02-PLAN.md — VPS deployment, seed credentials, verify refresh cycle

**Success Criteria:**
1. NanoClaw reads OAuth credentials from `oauth-credentials.json` (not `.env`)
2. When access token is within 5 minutes of expiry, NanoClaw automatically refreshes it before spawning a container
3. Refreshed credentials (including potentially rotated refresh token) are persisted atomically
4. Concurrent container spawns deduplicate refresh requests (single in-flight refresh)
5. Holly stays alive for 48+ hours without manual token intervention
6. If refresh fails, a CRITICAL log entry is written and the stale token is used as fallback

---

## Progress

| Phase | Status | Plans | Completed |
|-------|--------|-------|-----------|
| 1 — Multi-Container GroupQueue | Complete | 3 | 3 |
| 2 — Session Awareness + Deployment | Complete | 2 | 2 |
| 3 — OAuth Auto-Refresh | Complete | 2 | 2 |

## Deployment

- **Deployed:** 2026-03-12T08:46:00Z
- Google Chat channel adapter added to git repo and deployed
- OAuth token (Claude Max 20x) active — API key removed
- Concurrent sessions live — up to 10 containers globally
- Passwordless deploy configured via sudoers
- Google Chat threaded replies — Holly replies in-thread
- Google Chat conversation history — inbound/outbound messages stored, last 20 prepended to prompt
- 416 tests passing
