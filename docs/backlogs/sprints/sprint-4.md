# Sprint 4: Web Chat Interface

**Package:** cambot-agent
**Duration:** ~2-3 weeks
**Sprint Goal:** Add session isolation for web chat sessions.

---

## Stories

### 1.4 — Web chat session isolation
- [ ] Create per-session isolated context (mirroring WhatsApp per-group folders)
- [ ] Session folders scoped under authenticated user
- [ ] Session state persists across page refreshes within a configurable window
- [ ] Session ID tied to authenticated user via JWT
- [ ] No cross-session data leakage
- [ ] Add tests for session isolation

---

## Coordinated with:
- cambot-channels Sprint 4 (web chat channel adapter)
- cambot-core-ui Sprint 4 (chat page, API route, widget)
- cambot-core Sprint 4 (audit logging, PII detection)

## Definition of Done
- Web chat sessions are isolated with no cross-session data leakage
- Session persistence works across page refreshes
- The web chat channel adapter (cambot-channels) was added without any changes to cambot-agent
