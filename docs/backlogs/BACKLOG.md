# cambot-agent Backlog

**Package:** cambot-agent
**Owns:** Runtime orchestrator — message loop, container isolation, per-group queues, cron scheduler, IPC, mount security, session management
**Does NOT own:** Channels (cambot-channels), integration tools (cambot-integrations), data persistence (cambot-core)
**Source:** PM-DELIVERABLE-2026-02-22.md
**Updated:** 2026-02-23

---

## Design Principle: Open/Closed

cambot-agent is the **orchestrator**. It defines extension points that other packages plug into:

- **Channels** — cambot-agent calls `loadChannels()` from cambot-channels. New channels are added to cambot-channels, never to this package.
- **Integrations** — cambot-agent mounts integration tools from cambot-integrations into containers. New integrations are added to cambot-integrations, never here.
- **Providers** — Model provider abstraction (LATER phase) will define a `Provider` interface. New model providers implement it without touching orchestration.

The orchestrator's job is to **wire things together**, not to know how they work.

---

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete
- `[—]` Blocked (dependency noted)

---

## Phase: NOW (Q1 2026)

### SETUP: Depend on cambot-channels

- [ ] **0.1 — Replace internal channels with cambot-channels dependency**
  Remove src/channels/ from cambot-agent, import from cambot-channels instead.
  - **AC:** cambot-agent has no channel implementation code.
  - **AC:** `loadChannels()` imported from cambot-channels.
  - **AC:** All existing functionality works identically.
  - **AC:** Channel-related types imported from cambot-channels.
  - **Sprint:** 1

### From EPIC 1: Web Chat Interface

- [ ] **1.4 — Web chat session isolation**
  Each web chat session gets its own isolated context (like WhatsApp groups get per-group folders).
  - **AC:** Sessions are isolated — no cross-session data leakage.
  - **AC:** Session state persists across page refreshes (within a reasonable window).
  - **AC:** Session ID tied to authenticated user (JWT).
  - **Sprint:** 4

### From EPIC 3: Multi-Tenant Architecture

- [ ] **3.3 — Tenant-aware container isolation**
  Agent containers scoped to tenant — a tenant's agent cannot access another tenant's mounted data.
  - **AC:** Container mounts filtered by tenant.
  - **AC:** Per-group folders scoped under tenant directory.
  - **AC:** IPC authorization tenant-aware.
  - **Sprint:** 5

- [ ] **3.5 — Per-tenant credential and API key isolation**
  Tenant credentials (API keys, OAuth tokens) isolated per tenant.
  - **AC:** Tenants cannot access other tenants' credentials.
  - **AC:** API keys scoped per tenant.
  - **AC:** Credential filtering enforced per tenant.
  - **Sprint:** 5

### From EPIC 4: PDF/DOCX Document Processing

- [ ] **4.5 — Sandboxed document processing**
  Document parsing runs in container sandbox, not the main process.
  - **AC:** File processing delegated to agent container.
  - **AC:** Mount security enforced on uploaded files.
  - **Sprint:** 2

### From EPIC 9: Workflow Runner

- [ ] **9.3 — Agent integration hook** *(cross-package: agent, workflows)*
  Connect workflow steps to the containerized Claude agent.
  - **AC:** "agent" step type invokes a real Claude agent in a container.
  - **AC:** Agent context (memory, tools) available to workflow steps.
  - **AC:** Container isolation respected.

---

## Phase: LATER (Q4 2026+)

### From EPIC 13: Multi-Model + Air-Gapped Tier

- [ ] **13.1 — Model provider interface**
  Create a `Provider` abstraction that the agent runtime uses instead of direct Claude SDK calls.
  - **AC:** Provider interface defined (send message, stream response, tool use).
  - **AC:** Claude SDK wrapped as one provider implementation.
  - **AC:** New providers added without modifying orchestrator.
  - **AC:** Existing functionality unchanged.

- [ ] **13.2 — OpenAI provider**
  Add OpenAI GPT models as an alternative provider implementation.
  - **AC:** GPT-4o / GPT-4 available as model options.
  - **AC:** Tool use mapped correctly.

- [ ] **13.3 — Ollama local model provider**
  Add local model support via Ollama for air-gapped deployment.
  - **AC:** Ollama models available as provider option.
  - **AC:** Local inference runs inside existing container isolation.
  - **AC:** Zero outbound network calls when using local models.

- [ ] **13.4 — Air-gapped network policy enforcement**
  Ensure air-gapped mode is enforced at the network level.
  - **AC:** Container network policy disables all outbound calls (not just app config).
  - **AC:** Model files validated before loading.

---

## Summary

| Phase | Story Count | Key Themes |
|-------|-------------|------------|
| NOW | 6 | Depend on cambot-channels, session isolation, tenant containers, sandboxed processing |
| NEXT | 1 | Workflow agent hook |
| LATER | 4 | Model provider abstraction, OpenAI, Ollama, air-gap |
| **Total** | **11** | |

**Down from 38 stories to 11.** Channels moved to cambot-channels (19 stories), integrations moved to cambot-integrations (16 stories). What remains is pure orchestration.

### Extension Points
| Extension | How to Add | What Changes |
|-----------|-----------|--------------|
| New channel | Add implementation to cambot-channels | Nothing in cambot-agent |
| New integration | Add implementation to cambot-integrations | Nothing in cambot-agent |
| New model provider | Add Provider implementation | Nothing in orchestrator loop |
