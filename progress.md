# Implementation Progress — Constituency Complaint Chatbot

## Current Status: Phase 1 Complete

Phase 1 (Core Complaint Bot) fully implemented. 270 tests passing, build clean. Ready for Phase 2.

Post-review fixes applied: SQL injection in shell scripts, transaction wrapping, XML escaping, error fallback, code simplifications (wrapToolHandler, nowISO, ON CONFLICT upserts, consolidated imports, phoneFromJid helper).

---

## Phase Progress

| Phase | Status | Stories | Completed | Notes |
|-------|--------|---------|-----------|-------|
| Phase 1: Core Complaint Bot | ✅ Complete | 8 | 8/8 | All stories done, 270 tests |
| Phase 2: Rate Limiting, Safety & Admin | ⬜ Not Started | 6 | 0/6 | Unblocked — depends on Phase 1 |
| Phase 3: Voice Notes & Website | ⬜ Not Started | 6 | 0/6 | Unblocked — depends on Phase 1 |
| Phase 4: Web Admin Dashboard | ⬜ Not Started | 4 | 0/4 | Depends on Phase 2 |
| Phase 5: Analytics & Reporting | ⬜ Not Started | 4 | 0/4 | Depends on Phase 2, 4 |
| Phase 6: Production Deployment | ⬜ Not Started | 5 | 0/5 | Depends on Phase 4 |
| Phase 7: Multi-Tenant | ⬜ Not Started | 4 | 0/4 | Depends on Phase 6 |
| Phase 8: WhatsApp CMS | ⬜ Not Started | 4 | 0/4 | Depends on Phase 3, 5 |
| Phase 9: Advanced Features | ⬜ Not Started | 4 | 0/4 | Depends on Phase 7 |
| Phase 10: Polish & Scale | ⬜ Not Started | 5 | 0/5 | Depends on Phase 9 |
| **Total** | | **50** | **8/50** | |

---

## Story Completion Log

| Date | Story ID | Title | Notes |
|------|----------|-------|-------|
| 2026-02-11 | P1-S1 | Fork nanoclaw and set up project structure | team-lead: forked to riyazsarah/constituency-bot, 106 tests |
| 2026-02-11 | P1-S2 | Extend WhatsApp channel for 1:1 chats | whatsapp-dev: isIndividualChat, extractPhoneNumber, VIRTUAL_COMPLAINT_GROUP_JID |
| 2026-02-11 | P1-S3 | Create database schema and shell script tools | db-dev: 8 tables, 10 indexes, 4 shell tools, complaints_view |
| 2026-02-11 | P1-S4 | Write CLAUDE.md — the bot's brain | prompt-dev: full bot brain with language rules, guardrails, tool usage |
| 2026-02-11 | P1-S5 | Configure container agent for complaint handling | prompt-dev: Dockerfile + agent-runner Sonnet 4.5 + container mounts |
| 2026-02-11 | P1-S6 | Implement message routing in orchestrator | whatsapp-dev: resolveRouteJid, formatMessagesWithUserContext |
| 2026-02-11 | P1-S7 | Create tenant configuration system | config-dev: YAML loader, validator, DB cache, template injection |
| 2026-02-11 | P1-S8 | Local development setup and end-to-end testing | config-dev: docker-compose, .env, startup integration, complaint group registration |

---

## Current Sprint

**Active stories**: None — Phase 1 complete
**Next up**: Phase 2 stories (P2-S1 rate limiter, P2-S2 content safety, P2-S3 admin notifications)

### Unblocked Stories (Ready to Start)

- P2-S1: Implement rate limiter (depends on P1-S8 ✅)
- P2-S2: Harden content safety in system prompts (depends on P1-S4 ✅)
- P2-S3: Build admin group notification system (depends on P1-S8 ✅)

### Blocked Stories (Waiting on Dependencies)

- P2-S4: User notification on status updates (blocked by P2-S3)
- P2-S5: Daily summary scheduled task (blocked by P2-S3)
- P2-S6: Usage volume monitoring (blocked by P2-S5)
- All Phase 3+ stories

---

## Key Decisions & Notes

- **Architecture**: Hybrid runtime: 1:1 complaint chats use in-process Agent SDK + MCP (`src/complaint-handler.ts`), while group chats keep the container-based runtime
- **LLM Strategy**: Sonnet 4.5 default (all tasks), Opus 4.6 for deep analysis (weekly reports, trends)
- **Auth**: Claude Code subscription via CLAUDE_CODE_OAUTH_TOKEN (no per-token billing)
- **Database**: SQLite from Day 1, PostgreSQL migration documented for Phase 10
- **Deployment**: Phases 1-5 run locally (`npm run dev`), Phase 6 deploys to existing k3d cluster
- **Multi-tenant**: Config-driven, per-tenant namespace isolation, shared container images
- **Tooling path**: Shell scripts in `tools/*.sh` remain for container workflows; the active 1:1 complaint path uses TypeScript MCP tools in `src/complaint-mcp-server.ts`

---

## Blockers & Issues

| Date | Issue | Status | Resolution |
|------|-------|--------|-----------|
| — | — | — | No issues yet |
