# NanoClaw v2 Checklist

Status: [x] done, [~] partial, [ ] not started

---

## Core Architecture

- [x] Session DB replaces IPC (messages_in / messages_out as sole IO)
- [x] Two-DB split: inbound.db (host-owned) + outbound.db (container-owned) — zero cross-process write contention
  - **Cross-mount invariants (empirically validated, see `scripts/sanity-live-poll.ts`):** (1) `journal_mode=DELETE` on every session DB — WAL's `-shm` is memory-mapped and VirtioFS does not propagate mmap coherency host→guest, so WAL leaves the container's poll loop frozen on an early snapshot with no error; (2) host opens-writes-closes per operation — the close is what invalidates the container's VirtioFS page cache; (3) one writer per file — DELETE-mode with two writers corrupts because journal-unlink doesn't propagate atomically. Each invariant was individually confirmed by flipping it and observing silent message loss or corruption. Do not "simplify" by unifying the DBs, switching to WAL, or keeping a long-lived host connection.
  - **Seq parity is load-bearing, not cleanup:** host writes even seqs, container writes odd seqs. The seq is the agent-facing message ID returned by `send_message` and consumed by `edit_message` / `add_reaction`, and `getMessageIdBySeq()` looks up by seq across both tables. Removing parity would let a single ID resolve to the wrong row.
- [x] Central DB (agent groups, messaging groups, sessions, routing)
- [x] Host sweep (stale detection via heartbeat file, retry with backoff, recurrence scheduling)
- [x] Active delivery polling (1s for running sessions)
- [x] Sweep delivery polling (60s across all sessions)
- [x] Container runner with session DB mounting
- [x] Per-session container lifecycle and idle timeout
- [x] Session resume (sessionId + resumeAt across queries)
- [x] Graceful shutdown (SIGTERM/SIGINT handlers)
- [x] Orphan container cleanup on startup

## Agent Runner (Container)

- [x] Poll loop (pending messages, status transitions, idle detection)
- [x] Concurrent follow-up polling while agent is thinking
- [x] Message formatter (chat, task, webhook, system kinds)
- [x] Command categorization (admin, filtered, passthrough)
- [x] Transcript archiving (pre-compact hook)
- [x] XML message formatting with sender, timestamp
- [~] Media handling inbound (formatter references attachments, no download-from-URL)

## Agent Providers

- [x] Claude provider (Agent SDK, tool allowlist, message stream, session resume)
- [x] Mock provider (testing)
- [x] Provider factory
- [ ] Codex provider
- [ ] OpenCode provider

## Channel Adapters

- [x] Channel adapter interface (setup, deliver, teardown, typing)
- [x] Chat SDK bridge (generic, works with any Chat SDK adapter)
- [x] Chat SDK SQLite state adapter (KV, subscriptions, locks, lists)
- [x] Discord via Chat SDK
  - [ ] First inbound message requires @mention before Chat SDK subscribes the channel/thread. Subsequent messages flow without @. Fix: pre-subscribe known conversations at bridge startup (iterate `setupConfig.conversations` → `thread.subscribe()`), or upstream a "listen to all messages in known channels" mode in Chat SDK.
  - [ ] @mention in a root Discord channel causes the adapter to materialize a sub-thread as its subscription surface. Either (a) live with it and treat each mention-rooted sub-thread as its own session, or (b) flip Discord to `supportsThreads: false` so replies always land in the root channel, or (c) change the adapter's subscribe behavior so root-channel subscription doesn't spawn a Discord thread.
- [~] Slack via Chat SDK (adapter + skill written, not tested)
- [x] Telegram via Chat SDK (E2E verified: inbound, routing, typing, delivery)
- [~] Microsoft Teams via Chat SDK (adapter + skill written, not tested)
- [~] Google Chat via Chat SDK (adapter + skill written, not tested)
- [~] Linear via Chat SDK (adapter + skill written, not tested)
- [~] GitHub via Chat SDK (adapter + skill written, not tested)
- [~] WhatsApp Cloud API via Chat SDK (adapter + skill written, not tested)
- [~] Resend (email) via Chat SDK (adapter + skill written, not tested)
- [~] Matrix via Chat SDK (adapter + skill written, not tested)
- [~] Webex via Chat SDK (adapter + skill written, not tested)
- [~] iMessage via Chat SDK (adapter + skill written, not tested)
- [x] Backward compatibility with native channels (old adapters still work)
- [x] Channel barrel wired (src/index.ts imports barrel, skills uncomment)
- [x] Setup flow wired to v2 channels (channel skills + /manage-channels for registration + verify.ts checks all tokens)
- [x] Channel Info metadata in each channel skill (type, terminology, how-to-find-id, isolation defaults)
- [x] /manage-channels skill (wire channels to agent groups with three isolation levels)
- [x] Agent-shared session mode (cross-channel shared sessions, e.g. GitHub + Slack)
- [x] Auto-onboarding on channel registration (/welcome skill triggered on first wiring)
- [ ] Setup vs production channel separation

## Chat-First Setup Flow

**Goal:** get the user out of Claude Code and into their messaging app as quickly as possible, then enable every part of customization, configuration, and setup from inside the chat app. Claude Code is the bootstrap, not the home.

- [ ] Minimum-viable bootstrap in Claude Code: install deps, pick one channel, authenticate it, wire it to a default agent group, hand off — nothing else required before the user can leave Claude Code
- [ ] Post-handoff welcome message in the chat app guides the user through remaining setup (channels, skills, integrations, memory, scheduling, etc.)
- [ ] Add more channels from chat (currently requires returning to Claude Code to run `/add-*` skills)
- [ ] Self-register agent into a new chat room from chat: user gives the agent a channel/group name + approval, and the agent joins via the underlying adapter (e.g. Baileys for WhatsApp), wires the room to an agent group, and posts a first "hi, I'm here" message — no manual invite, no `/add-*` skill, no terminal
- [ ] Authenticate channels from chat (OAuth/token entry via cards, no terminal required)
- [ ] Add credentials / secrets to the OneCLI vault from chat via rich card (agent collects API keys, OAuth tokens, and other secrets through a card flow and writes them into the vault — no `.env` editing, no terminal)
- [ ] Wire channels to agent groups from chat (today lives in `/manage-channels` Claude Code skill — port to in-chat flow with isolation-level question cards)
- [ ] Create new agent groups from chat (`create_agent` exists — expose via user-facing flow, not just agent-called tool)
- [ ] Edit agent group CLAUDE.md / instructions from chat
- [ ] Install / uninstall / configure skills from chat (see Skills & Marketplace section)
- [ ] Install / configure MCP servers from chat (see Skills & Marketplace section)
- [ ] Install packages from chat (today agent can request install_packages — expose a direct user-facing "install X" flow)
- [ ] Manage scheduled tasks from chat (list, pause, cancel, edit recurrence)
- [ ] Manage destinations from chat (list, rename, revoke)
- [ ] Manage permissions from chat (admin list, role assignment, approval policies)
- [ ] Trigger /setup, /debug, /customize, /migrate-nanoclaw from chat (today all require Claude Code)
- [ ] View and edit memory from chat
- [ ] Visualize current setup from chat (ties into Container Skills: installation diagram)
- [ ] Export / share setup from chat (ties into Container Skills: end-of-setup diagram + share)
- [ ] Fallback to Claude Code only when a change requires a code edit the agent can't self-apply (and even then, agent should offer to open Claude Code on the user's behalf)

## Product Focus

**North star:** prioritize skills, flows, and custom setups. Platform work (channels, routing, session DBs, approval flows, MCP tools) is plumbing — it should reach a "boring and reliable" state and then stop absorbing attention. The interesting surface area is what users can *build on top* of that plumbing: skills that add capabilities, conversational flows that orchestrate those skills, and custom per-user setups that compose channels/agents/skills/memory into something personal.

- [ ] Every new feature request should be answered first with "is this a skill?" before being answered with "is this a platform change?"
- [ ] Skills should be the primary extension mechanism users and agents reach for — adding, removing, browsing, editing, debugging
- [ ] Flows (multi-step interactive sequences: setup, onboarding, migration, customize, debug) should be authorable as skills rather than hardcoded into the platform
- [ ] Custom setups (diverging from defaults: multiple agents, cross-channel routing, per-group memory, specialist sub-agents) should be composable from existing primitives without touching core platform code
- [ ] Platform-level work gets budgeted against the question: "does this unblock a class of skills/flows/setups that's otherwise impossible?"

## Routing

- [x] Inbound routing (platform ID + thread ID -> agent group -> session)
- [x] Auto-create messaging group on first message
- [x] Session resolution (shared vs per-thread modes)
- [x] Message writing to session DB with seq numbering
- [x] Container waking on new message
- [x] Typing indicator triggered on message route
- [~] Trigger rule matching (router picks highest-priority agent, regex/mention matching TODO)

## Rich Messaging

- [x] Interactive cards with buttons (ask_user_question)
- [x] Native platform rendering (Discord embeds, buttons)
- [x] Message editing
- [x] Emoji reactions
- [x] File sending from agent (outbox -> delivery)
- [x] File upload delivery (buffer-based via adapter)
- [x] Markdown formatting
- [~] Formatted /usage, /context, /cost output (commands pass through, no rich card formatting)
- [ ] Context window visibility: show position in context, approaching compaction, when compaction happens, post-compaction state
- [ ] Threading and replies support

## MCP Tools (Container)

- [x] send_message (routes via named destinations; `to` field resolved against agent's local map)
- [x] send_file (copy to outbox, write messages_out)
- [x] edit_message (routed via destinations)
- [x] add_reaction (routed via destinations)
- [x] send_card
- [x] ask_user_question (blocking poll for response)
- [x] schedule_task (with process_after and recurrence)
- [x] list_tasks
- [x] cancel_task / pause_task / resume_task
- [x] create_agent (admin-only, creates agent group + folder + bidirectional destinations)
- [x] install_packages (apt/npm, admin approval required, strict name validation)
- [x] add_mcp_server (admin approval required)
- [x] request_rebuild (rebuilds per-agent-group Docker image)
- ~~send_to_agent~~ — deleted; agents are just destinations in the unified `send_message`

## Scheduling

- [x] One-shot scheduled messages (process_after / deliver_after)
- [x] Recurring tasks via cron expressions
- [x] Host sweep picks up due messages and advances recurrence
- [x] Scheduled outbound messages (no container wake needed)
- [ ] Pre-agent scripts (formatter references scriptOutput but no execution logic)

## Permissions and Approval Flows

- [x] Admin user ID per group
- [x] Admin-only command filtering in container
- [ ] Admin model refactor — instance-level default admin (user + messaging app) for all approval routing, overridable per agent group; deliver approval cards to admin's DM when the platform supports it
- [ ] Replace the `is_admin`/main vs. non-main distinction on agent groups with an explicit owner/admin model — every agent group has a recorded owner (the platform user who created or installed it) and an admin (who receives approvals and can change wiring); the two default to the same identity but can diverge (e.g. handoff). Drops the "main group = admin group" coupling. Downstream consequence: non-main group registration on Telegram must use the same pairing-code flow as main (`setup --step pair-telegram` with a `wire-to:<folder>` or `new-agent:<folder>` intent), since there's no longer a privileged "main" chat whose identity is trusted transitively — every group binds its own admin at registration time.
- [x] Approval flow (sensitive action -> card to admin -> approve/reject -> execute) — `pending_approvals` table, `requestApproval()` helper, reuses interactive card infra
- [x] Agent requests dependency/package install (install_packages, admin approval, rebuild on approval)
- [x] Self-modification — direct tools:
  - [x] install_packages (apt/npm, admin approval, name validation both sides, max 20 per request)
  - [x] add_mcp_server (admin approval)
  - [x] request_rebuild (builds per-agent-group Docker image with approved packages)
  - [x] Fire-and-forget model (write request, return immediately; chat notification on approval; container killed so next wake picks up new config/image)
- [ ] Role definitions beyond admin (custom roles, per-group permissions)
- [ ] Configurable sensitive action list (hardcoded today)
- [ ] Non-main groups requesting sensitive actions
- [~] OneCLI integration for human-loop approvals on credentialed requests (agent touching a credentialed resource → OneCLI gates → approval card to admin → OneCLI releases credential) — SDK 0.3.1 `configureManualApproval` wired into host, routes to admin via existing `pending_approvals` infra
- [~] Credential collection from chat — `trigger_credential_collection` MCP tool; agent researches API config, card → modal → `onecli secrets create` via internal facade (`src/onecli-secrets.ts`); credential value never enters agent context
  - [ ] Replace `src/onecli-secrets.ts` shell facade with SDK-native secret management when `@onecli-sh/sdk` adds it
  - [ ] Per-agent-group secret scoping via OneCLI `agentId` (facade passes it today; CLI ignores it until upstream supports)
  - [ ] **Attach newly created secrets to the calling agent** — `trigger_credential_collection` today runs `onecli secrets create` but leaves the secret unassigned, so the agent that requested the credential still gets zero injections. Fix options: (a) follow-up `onecli agents set-secrets` call in `src/onecli-secrets.ts` after create, (b) set the agent to `mode=all`, or (c) upstream ask — `onecli secrets create --assign-to-agent-ids <id,...>` so it's a one-shot and orphaned secrets are impossible. Prefer (c); use (a) as the interim.
  - [ ] **Chat SDK input support beyond Slack (upstream ask)** — today only Slack's Modal surface works for secure input. The platforms themselves support it, but Chat SDK doesn't expose it:
    - [ ] **Discord** — native modal (`InteractionResponseType.Modal` with `ActionRow([TextInput])`). Map `event.openModal(Modal(...))` to the Discord REST callback.
    - [ ] **Microsoft Teams** — Adaptive Card with `Input.Text`, delivered as a regular message (inline, no modal-trigger needed).
    - [ ] **Google Chat** — Cards v2 `textInput` widget, inline in the conversation.
    - [ ] **Webex** — Adaptive Card with `Input.Text`, inline.
    - [ ] **WhatsApp Cloud** — WhatsApp Flows with a text field (requires flow registration with Meta — heavier but doable).
    - When these land upstream, `trigger_credential_collection` gets secure input on all major channels for free; no NanoClaw-side code change beyond maybe declaring the capability per adapter.
  - [ ] Tunneled OneCLI dashboard fallback for platforms with no native form input (Telegram Mini Apps aside, iMessage without Apple Business Register, Matrix, email). Signed short-lived URL → browser form served by OneCLI at 10254 → tunnel via ngrok/cloudflared/tailscale-funnel. Value never touches the chat surface.
  - [ ] OneCLI built-in apps (`onecli apps list`) shadow generic secrets on the same host. `trigger_credential_collection` should check for a matching app first; if one exists, route the user through the app's connect URL instead of creating a secret. Upstream ask: `apps configure --api-key` for api_key apps.
- [ ] Sensitive data access flow (agent requests PII / secrets / private files → approval card → scoped, time-limited access)
- [ ] Self-modification via builder-agent delegation:
  - [ ] Agent requests code changes by delegating to a builder agent
  - [ ] Builder agent has write access to the requesting agent's code and Dockerfile
  - [ ] Approval modes: approve per-edit as builder works, or approve full diff at the end
  - [ ] Diff review card sent to admin showing all proposed changes
  - [ ] On approval: apply edits, rebuild container image, restart agent
  - [ ] On rejection: discard changes, notify requesting agent

## Named Destinations + ACL

- [x] `agent_destinations` table (agent_group_id, local_name, target_type, target_id) — migration 004
- [x] Per-agent local-name routing map (channels and peer agents referenced by local names)
- [x] Destinations stored in inbound.db `destinations` table (moved from JSON file in `b591d7c`) — single source of truth, no separate file
- [x] Host writes the destination map into inbound.db before every container wake; container queries it live on every lookup so admin changes take effect mid-session
- [x] Container loads map at startup, appends system-prompt addendum listing destinations + `<message to="name">` syntax
- [x] Agent main output parsed for `<message to="...">` blocks; `<internal>...</internal>` treated as scratchpad
- [x] Host re-validates every outbound route via `hasDestination()` — unauthorized drops logged
- [x] Inbound formatter adds `from="name"` via reverse-lookup (consistent namespace both directions)
- [x] Single-destination shortcut — agents with one destination don't need `<message>` wrapping
- [x] Backfill from existing `messaging_group_agents` on migration
- [x] Removed `NANOCLAW_PLATFORM_ID` / `CHANNEL_TYPE` / `THREAD_ID` env-var routing entirely

## Agent-to-Agent Communication

- [x] Host delivery to target agent's session DB (`channel_type='agent'` routing in `src/delivery.ts`)
- [x] Agent spawning a new sub-agent (`create_agent` MCP tool, admin-only, path-traversal guarded)
- [x] Dynamic agent group creation (folder + optional CLAUDE.md at runtime)
- [x] Internal-only agents (agents created without a channel attached)
- [x] Permission delegation from parent to child (bidirectional destination rows inserted at creation)
- [x] Bidirectional routing via inherited routing context; sender info enriched on the target side
- [ ] Specialist sub-agents (browser agent, dev agent — user's agent delegates with request/approval)
- [ ] Browser agent with per-destination permissions between main agent and browser agent (main requests navigation/interaction; browser agent executes in isolated container)
- [ ] Sanitization of browser agent responses before handing back to main agent (strip scripts, inline images, untrusted HTML; prevent prompt injection from web content)
- [ ] Same permission + sanitization model for any sub-agent that accesses sensitive data sources (files, DBs, third-party APIs)

## In-Chat Agent Management

- [x] /clear (resets session)
- [x] /compact (triggers context compaction)
- [~] /context (passes through, no rich formatting)
- [~] /usage (passes through, no rich formatting)
- [~] /cost (passes through, no rich formatting)
- [ ] Smooth session transitions: load context into new sessions, solve cold start problem
- [ ] MCP/package installation from chat
- [ ] Browse MCP marketplace / skills repository from chat

## Skills & Marketplace

- [ ] Install skills from chat (agent requests, admin approves, skill dropped into container skills dir)
- [ ] Scan skills before install (lint SKILL.md, sandbox-check shell commands, require approval for network/FS-heavy skills)
- [ ] Scan marketplace npm packages before install (supply-chain check, typo-squat detection, known-bad list)
- [ ] MCP server marketplace — discover, preview, install
- [ ] Browse skills / MCP marketplace from chat (cards with search, preview, install)
- [ ] Local voice transcription skill — "just works" install flow: when the user sends a voice message and no transcription backend is installed, the agent asks once ("Install local voice transcription?"), and on approval the skill installs a fully-local speech-to-text model (no cloud calls). Subsequent voice messages transcribe automatically.
- [ ] Fully local NanoClaw — OpenCode + Gemma 4 as the agent provider instead of Claude Code, so an entire install can run with zero cloud inference. Requires wiring OpenCode as an agent provider (see Agent Providers) and a setup path that picks local models, pulls weights, and verifies everything runs offline.

## Container Skills

Container skills live inside agent containers at runtime (`container/skills/`) and are loaded into every agent session. These are distinct from feature/operational skills that ship with the host.

- [ ] Customize container skill — agent-driven customization flow (add channel, integration, behavior change) usable from inside any agent session, not just the main repo
- [ ] Debug container skill — inspect logs, session DB, MCP server state, container env, recent errors from inside the agent
- [ ] Setup container skill — first-time setup flow triggered from inside the agent (ties to host-side /setup)
- [ ] Build-system container skills:
  - [ ] Karpathy LLM Wiki builder (agent scaffolds a persistent wiki knowledge base for a group)
  - [ ] Generic build-system framework for agent-authored sub-systems
- [ ] NanoClaw installation diagram skill — agent generates a visual diagram of the user's current setup (agent groups, channels, wirings, destinations, sub-agents, installed packages/MCP servers)
- [ ] Video replay skill — generate Remotion (or similar) videos that replay chat flows and sessions, referencing good UI patterns to produce shareable clips
- [ ] Excitement trigger skill — detects when the user expresses excitement about the agent's capabilities or their setup, and proactively encourages generating a diagram + sharing it
- [ ] End-of-migration diagram skill — at the end of `/migrate-nanoclaw` (or any migration flow), agent generates a visual diagram of the resulting setup and suggests sharing
- [ ] End-of-setup diagram skill — at the end of first-time `/setup`, agent generates a visual diagram and suggests sharing (merges the old "Generate visual diagram of customized instance at end of setup" line from Channel Adapters)

## Webhook Ingestion

- [ ] Generic webhook endpoint for external events
- [ ] GitHub webhook handling
- [ ] CI/CD notification handling
- [ ] Webhook -> messages_in routing

## System Actions

- [ ] register_group from inside agent
- [ ] reset_session from inside agent
- [ ] Delivery failures should round-trip back to the agent as system messages so it can decide how to recover (retry as plain text, simplify, give up), with a hard retry cap + poison-pill backstop in delivery.ts to keep the queue healthy

## Integrations

- [ ] Vercel CLI integration in setup process
- [ ] Skills for deploying and managing Vercel websites from chat
- [ ] Office 365 integration (create/edit documents with inline suggestions)

## Memory

- [ ] Shared memory with approval flow (write to global memory requires admin approval)
- [ ] Agent memory system skills — skills for building and managing memory systems for an agent: archive/index large collections of files and data, then expose a memory interface the agent can query and update (e.g. QMD-style systems)

## Migration

- [ ] v1 -> v2 migration skill
- [ ] Database migration (v1 SQLite -> v2 central DB + session DBs)
- [ ] Channel credential preservation
- [ ] Custom skill/code porting
- [ ] OneCLI migration check — determine if existing installs need OneCLI re-init (credentials re-scoped to new `agent_group.id` identifier, new SDK version, approval handler registered). If needed, add a migration step to `/update-nanoclaw` or a dedicated skill.

## Testing

- [x] DB layer tests (agent groups, messaging groups, sessions, pending questions)
- [x] Channel registry tests
- [x] Poll loop / formatter tests
- [x] Integration test (container agent-runner)
- [x] Host core tests
- [ ] End-to-end flow tests (message in -> agent -> message out -> delivery)
- [ ] Delivery polling tests
- [ ] Host sweep tests (stale detection, recurrence)
- [ ] Multi-channel integration tests

## Rollout

- [ ] Internal testing across all channels
- [ ] Migration skill built and tested
- [ ] PR factory migrated as validation
- [ ] Blog post / announcement
- [ ] Video demos of key flows
- [ ] Vercel coordination
