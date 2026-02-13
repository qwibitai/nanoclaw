# Constituency Bot

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp. Group chats use containerized agents (Apple Container), while 1:1 complaint chats use the in-process Agent SDK path in `src/complaint-handler.ts`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/complaint-handler.ts` | In-process Agent SDK path for 1:1 complaint chats |
| `src/complaint-mcp-server.ts` | MCP server exposing complaint tools to the agent |
| `src/admin-handler.ts` | Admin group notifications, #commands, NL replies, @ComplaintBot instructions |
| `src/admin-commands.ts` | Karyakarta/area management command execution |
| `src/admin-reply.ts` | AI reply interpreter for complaint notification replies |
| `src/admin-instruction.ts` | AI instruction interpreter for @ComplaintBot NL management |
| `src/admin-query-agent.ts` | AI-powered admin query agent for IT automation |
| `src/karyakarta-handler.ts` | Karyakarta DM commands, validation flow, notifications |
| `src/area-db.ts` | CRUD for areas, karyakartas, assignments, validations |
| `src/area-matcher.ts` | Fuzzy area matching (Levenshtein) for complaint routing |
| `src/voice.ts` | Voice note validation + Sarvam AI transcription |
| `src/event-bus.ts` | Event emitter for complaint lifecycle notifications |
| `src/roles.ts` | Role hierarchy (user/karyakarta/admin/superadmin) |
| `src/rate-limiter.ts` | Per-user daily message + burst rate limiting |
| `src/mla-escalation.ts` | MLA escalation flow (DM forwarding) |
| `src/daily-summary.ts` | Daily complaint summary generation |
| `src/validation-scheduler.ts` | Auto-escalation for unvalidated complaints |
| `src/complaint-utils.ts` | Status transitions, note adding, complaint queries |
| `src/user-notifications.ts` | Status change notifications to complainants |
| `src/tenant-config.ts` | Tenant YAML loader + template variable injection |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/error-fallback.ts` | Graceful error responses when agent fails |
| `src/group-queue.ts` | Per-group message queuing and concurrency |
| `src/logger.ts` | Structured logging (pino) |
| `src/types.ts` | Shared TypeScript types (Message, Complaint, etc.) |
| `src/usage-monitor.ts` | Claude Code token/usage monitoring |
| `config/tenant.yaml` | Tenant config (MLA name, constituency, limits) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `groups/complaint/CLAUDE.md` | Complaint agent system prompt (template with {variables}) |
| `src/api/index.ts` | Hono app factory, API key auth middleware, route registration |
| `src/api/complaints.ts` | Complaint CRUD endpoints (list/detail/update) |
| `src/api/stats.ts` | Aggregate statistics endpoint |
| `src/api/usage.ts` | Usage volume tracking endpoint |
| `src/api/categories.ts` | Complaint categories endpoint |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Architecture

### Message Flow
- **Admin group**: `#commands` → `handleCommand()`, reply-to-notification → `handleReply()` (AI), `@ComplaintBot` text → `handleInstruction()` (AI), standalone audio → transcribe → `handleInstruction()`
- **1:1 chats**: complaint intake via Agent SDK, karyakarta validation replies, MLA DM forwarding
- **Event bus**: `complaint:created` and `complaint:status-changed` trigger admin group notifications, karyakarta notifications, and user notifications

### Environment Variables

Required at runtime (via `.env` or `--env-file`):
- `CLAUDE_CODE_OAUTH_TOKEN` — Claude Code subscription token
- `SARVAM_API_KEY` — Sarvam AI speech-to-text (voice notes)
- `TENANT_CONFIG_PATH` — Path to tenant YAML (default: `config/tenant.yaml`)
- `DASHBOARD_API_KEY` — API key for dashboard REST API authentication
- `API_PORT` — Dashboard API port (default: `3000`)

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run tests (vitest)
npm run typecheck    # Type-check without emitting
npm run format       # Format with prettier
npm run auth         # WhatsApp QR code authentication
./container/build.sh # Rebuild agent container
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Container Build Cache

Apple Container's buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Always verify after rebuild: `container run -i --rm --entrypoint wc constituency-bot-agent:latest -l /app/src/index.ts`

## Gotchas

- **Don't edit `data/runtime/complaint/CLAUDE.md`** — it's auto-generated from the template at `groups/complaint/CLAUDE.md` via tenant config variable substitution. Edit the template instead.
- **Template variables** in `groups/complaint/CLAUDE.md` use `{variable_name}` syntax (e.g., `{mla_name}`, `{constituency}`). These are replaced at runtime by `src/tenant-config.ts`.

## Testing

Tests are colocated: `src/foo.test.ts` next to `src/foo.ts`. Uses vitest.

```bash
npm test                       # Run all tests
npx vitest run src/db.test.ts  # Run a single test file
```
