# NanoClaw Contribution Opportunities

**Repository:** qwibitai/nanoclaw  
**Fork:** pottertech/nanoclaw  
**Generated:** 2025-02-15

This document identifies concrete contribution opportunities for the NanoClaw project, a lightweight AI assistant that runs in containers.

---

## 🚨 High Priority (Recommended First)

### 1. Fix Unhandled Promise Rejections in Message Loop
- **Priority:** High
- **Difficulty:** Medium
- **Issue:** #221

**Description:**
Unhandled promise rejections in the main message loop can crash the entire application. When agents fail or containers exit unexpectedly, the rejection bubbles up unhandled and terminates the service.

**What needs to be done:**
- Add `process.on('unhandledRejection', ...)` handler in `src/index.ts`
- Ensure all async functions in message processing have try/catch
- Add graceful degradation (log error, continue processing)
- Add retry logic with exponential backoff on container failures

**Files affected:** `src/index.ts`, `src/container-runner.ts`

---

### 2. Implement `/add-slack` Skill (Upstream PR Review)
- **Priority:** High
- **Difficulty:** Medium
- **Upstream PR:** #176
- **Related Issue:** #202

**Description:**
Slack is one of the three most-requested channels in the RFS (Request for Skills). An upstream PR already exists that implements Slack channel support with channel-agnostic orchestrator.

**What needs to be done:**
- Review upstream PR #176 for approach and implementation
- Create skill file `.claude/skills/add-slack/SKILL.md`
- Implement Slack channel following the same pattern as Telegram (see `/add-telegram` skill)
- Include Socket Mode support for receiving messages without public URLs
- Document bot token and app token setup process

**Implementation notes:**
- Use `@slack/bolt` framework for Slack integration
- Follow the `Channel` interface in `src/types.ts`
- Support both DM and channel conversations
- Handle Slack's message threading for context

---

### 3. Implement `/add-discord` Skill (Upstream PR Review)
- **Priority:** High
- **Difficulty:** Medium
- **Upstream PR:** #194
- **Related Issue:** #201

**Description:**
Discord is another highly-requested channel. Upstream PR #194 adds Discord integration using discord.js.

**What needs to be done:**
- Review upstream PR #194 for implementation details
- Create skill file `.claude/skills/add-discord/SKILL.md`
- Implement Discord channel following the `Channel` interface
- Support guild text channels and DMs
- Handle Discord's permission system for bot mentions

**Implementation notes:**
- Use `discord.js` library
- Handle Discord's message length limits (2000 chars vs WhatsApp's 4096)
- Support thread-based conversations
- Consider rate limiting (Discord has stricter limits)

---

## 🔒 Security Priority

### 4. Fix Secret Sanitization Bypass via `/proc` and Read Tool
- **Priority:** High
- **Difficulty:** Medium
- **Issue:** #232
- **Upstream PR:** #216

**Description:**
Currently, agents can read secrets even with sanitization because they can access `/proc/{pid}/environ` to see the full process environment.

**What needs to be done:**
- Mount `/proc` as read-only or hide it from containers
- Use `--security-opt` flags to protect environment
- Consider running agents with empty environment + only whitelisted vars
- Review mount security in `src/mount-security.ts`

**Files affected:** `src/container-runner.ts`, `src/mount-security.ts`

---

### 5. Add Rate Limiting on Outbound Messages
- **Priority:** High
- **Difficulty:** Easy
- **Issue:** #186 / #207

**Description:**
There's currently no rate limiting on outbound messages. A malfunctioning agent or scheduled task could spam messages, potentially triggering WhatsApp rate limits or bans.

**What needs to be done:**
- Implement per-group rate limiting in `src/router.ts`
- Add configurable rate limit (messages per minute/hour) to config
- Include burst allowance for legitimate spikes
- Log rate limit violations

**Files affected:** `src/router.ts`, `src/config.ts`

---

## 🛠️ Medium Priority

### 6. Implement `/setup-windows` Skill (WSL2 + Docker)
- **Priority:** Medium
- **Difficulty:** Medium
- **Upstream PR:** #188
- **Related Issue:** #187

**Description:**
Enable NanoClaw to run on Windows via WSL2 + Docker. This is a major platform expansion.

**What needs to be done:**
- Review upstream PR #188 for implementation approach
- Create `.claude/skills/setup-windows/SKILL.md`
- Support WSL2 detection and setup
- Create Windows-compatible service scripts (Task Scheduler or Windows Service)
- Document Docker Desktop requirement for Windows

**Key challenges:**
- Windows paths vs WSL paths
- Service management (no launchd on Windows)
- File permissions in WSL context

---

### 7. Fix Scheduled Tasks Race Condition
- **Priority:** Medium
- **Difficulty:** Hard
- **Issue:** #211
- **Upstream Issue:** #138

**Description:**
Scheduled tasks can execute twice due to a race condition between the scheduler loop and the task queue. When the scheduler polls and a task is due, it may be picked up twice before the `next_run` is updated.

**What needs to be done:**
- Add database-level locking (`BEGIN IMMEDIATE`) in task scheduling
- Implement task execution status tracking
- Add `is_running` flag to scheduled_tasks table
- Prevent re-enqueue of tasks already in queue

**Files affected:** `src/task-scheduler.ts`, `src/db.ts`

---

### 8. Add CPU and Memory Limits to Agent Containers
- **Priority:** Medium
- **Difficulty:** Easy
- **Upstream PR:** #199
- **Issue:** #199

**Description:**
Currently, agent containers have no resource limits. A runaway agent could consume all system resources.

**What needs to be done:**
- Add `--memory` flag to container spawn in `src/container-runner.ts`
- Add `--cpus` flag for CPU limiting
- Make limits configurable via `.env`/`src/config.ts`
- Set reasonable defaults (e.g., 1GB RAM, 1 CPU)

**Files affected:** `src/container-runner.ts`, `src/config.ts`

---

### 9. Implement `/add-clear` Skill (Session Compaction)
- **Priority:** Medium
- **Difficulty:** Hard
- **RFS from README.md**

**Description:**
Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session). This requires figuring out how to trigger compaction programmatically via the Claude Agent SDK.

**What needs to be done:**
- Research Claude Agent SDK programmatic compaction API
- Create skill file `.claude/skills/add-clear/SKILL.md`
- Add MCP tool for clearing/compacting
- Preserve important facts and context in summary
- Store compaction history

**Key challenge:** The Agent SDK API for session compaction is not well-documented. May require investigation into how Claude Code handles long contexts.

---

## 📈 Lower Priority / Enhancement

### 10. Add Message Type Columns to Database
- **Priority:** Low
- **Difficulty:** Easy
- **Issue:** #173

**Description:**
Add `is_bot_message` and `message_type` columns to the messages table for better queryability.

**What needs to be done:**
- Add migration in `src/db.ts` `createSchema()`
- Update `storeMessage()` to populate new columns
- Update message type detection in `src/channels/whatsapp.ts`
- Consider enum for message types (text, image, video, voice, document, etc.)

**Schema additions:**
```sql
ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN message_type TEXT DEFAULT 'text';
```

---

### 11. Review and Implement Upstream PR: Dropbox Integration
- **Priority:** Low
- **Difficulty:** Medium
- **Upstream PR:** #147
- **Issue:** #205

**Description:**
Review PR #147 for Dropbox integration skill and implement as `/add-dropbox`.

**What needs to be done:**
- Review upstream PR for implementation approach
- Create `.claude/skills/add-dropbox/SKILL.md`
- Implement OAuth flow for Dropbox authentication
- Support file upload/download via tools
- Handle periodic token refresh

---

### 12. Implement WebUI Control Panel (Upstream PR Review)
- **Priority:** Low
- **Difficulty:** Hard
- **Upstream PR:** #212
- **Issue:** #229

**Description:**
A web-based control panel for managing agent settings and viewing logs.

**What needs to be done:**
- Review upstream PR #212
- Create skill `.claude/skills/add-webui/SKILL.md`
- Implement Express.js or similar lightweight web server
- Add secure authentication (token-based)
- Include: group management, task list, log viewer, memory editor

---

### 13. Extract Content from Media (Voice Notes, Documents, Stickers)
- **Priority:** Low
- **Difficulty:** Hard
- **Issue:** #184
- **Upstream Issue:** #208

**Description:**
Currently, media messages are stored as placeholders like `[Photo]` or `[Voice message]`. The agent should be able to extract actual content.

**What needs to be done:**
- Download media files from WhatsApp
- Add speech-to-text for voice messages (OpenAI Whisper integration)
- Add OCR for images containing text
- Add document parsing (PDF, DOCX)
- Add sticker/emoji context extraction
- Add location metadata parsing

**Key challenge:** Requires integration with external AI services or libraries for processing.

---

### 14. Heartbeat Monitoring Skill (Upstream PR)
- **Priority:** Low
- **Difficulty:** Medium
- **Upstream PR:** #220
- **Issue:** #230

**Description:**
Add a health check and monitoring capability that reports system status periodically.

**What needs to be done:**
- Review PR #220
- Create skill `.claude/skills/add-heartbeat/SKILL.md`
- Implement periodic health checks
- Report: container status, memory usage, queue depth, pending tasks
- Optional: Send alerts to main group on issues

---

### 15. TUI (Terminal User Interface) Skill (Upstream PR)
- **Priority:** Low
- **Difficulty:** Hard
- **Upstream PR:** #223
- **Issue:** #228

**Description:**
Add a terminal-based UI for interacting with NanoClaw (similar to `htop` or `clawdbot` TUI).

**What needs to be done:**
- Review PR #223
- Create skill `.claude/skills/add-tui/SKILL.md`
- Implement using `blessed` or `ink` (React-based TUI)
- Features: live log view, group list, task list, quick actions

---

## 📊 Summary Table

| # | Opportunity | Priority | Difficulty | Type | Est. Time |
|---|-------------|----------|------------|------|-----------|
| 1 | Fix Unhandled Promise Rejections | High | Medium | Bug Fix | 2-3 hrs |
| 2 | `/add-slack` Skill | High | Medium | RFS/Skill | 4-6 hrs |
| 3 | `/add-discord` Skill | High | Medium | RFS/Skill | 4-6 hrs |
| 4 | Secret Sanitization Bypass | High | Medium | Security | 3-4 hrs |
| 5 | Rate Limiting | High | Easy | Security | 1-2 hrs |
| 6 | `/setup-windows` Skill | Medium | Medium | RFS/Skill | 4-6 hrs |
| 7 | Fix Task Race Condition | Medium | Hard | Bug Fix | 4-6 hrs |
| 8 | Container Resource Limits | Medium | Easy | Security | 1-2 hrs |
| 9 | `/add-clear` Skill | Medium | Hard | RFS/Skill | 4-8 hrs |
| 10 | Message Type Columns | Low | Easy | Enhancement | 1-2 hrs |
| 11 | `/add-dropbox` Skill | Low | Medium | Skill | 3-4 hrs |
| 12 | WebUI Control Panel | Low | Hard | Skill | 8-12 hrs |
| 13 | Media Content Extraction | Low | Hard | Feature | 8-12 hrs |
| 14 | Heartbeat Monitoring | Low | Medium | Skill | 3-4 hrs |
| 15 | TUI Interface | Low | Hard | Skill | 8-12 hrs |

---

## 🎯 Recommended Starting Point

For a first contribution, consider these in order:

1. **#8 - Container Resource Limits** (easiest, good impact)
2. **#5 - Rate Limiting** (quick security win)
3. **#10 - Message Type Columns** (good introduction to codebase)
4. **#1 - Fix Unhandled Promise Rejections** (critical stability fix)
5. **#2 - `/add-slack` Skill** (popular feature, good skill example)

---

## 🔗 References

- **Skills Documentation:** [Claude Code Skills](https://code.claude.com/docs/en/skills)
- **Existing Skills:** `.claude/skills/` directory
- **Open Issues:** `gh issue list` in the repository
- **Upstream PRs:** Reference qwibitai/nanoclaw
- **Channel Interface:** `src/types.ts` - `Channel` interface
- **Example Implementation:** `.claude/skills/add-telegram/SKILL.md`

---

*This document was auto-generated for contribution planning purposes. Always check the latest state of issues and PRs before starting work.*
