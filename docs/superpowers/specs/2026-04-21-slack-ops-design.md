# Slack Ops Design — Almanda can post to Slack DMs + channels

**Date:** 2026-04-21  
**Status:** Approved  
**Implemented by:** `skill/add-slack-ops/main`

## Problem

Almanda can read Slack (via `add-slack-intel`) but cannot proactively write — no DMs,
no channel posts, no reactions. A company assistant that can't reach people where they
work is severely limited.

## Solution

Enable the container agent to post to Slack channels and DMs, and add reactions, via the
`korotovsky/slack-mcp-server` already wired in the container — with all writes gated by
the existing "ask-before-writes" operating rule in `groups/global/CLAUDE.md:20-23`.

## Architecture decisions

| Decision | Choice | Reason |
|---|---|---|
| Write architecture | Flip `SLACK_MCP_ADD_MESSAGE_TOOL=true` on existing `slack-intel` MCP | Smallest diff; matches add-linear-ops pattern; reuses SLACK_BOT_TOKEN already forwarded |
| Write scope | Full: chat:write.public + im:write + mpim:write + reactions:write + groups:write | Mission requires reaching people across all channel types |
| No xoxp user token | Deferred | Canvases/scheduled-as-user are YAGNI for MVP |
| Policy gates | Not implemented | LLM-side approval rule sufficient for MVP; Phase 2.5 add-write-policy-gates is separate |

## What changes

### Code (one-line anchor)

`container/agent-runner/src/index.ts:530` — flip `SLACK_MCP_ADD_MESSAGE_TOOL: 'false'` → `'true'`.
This enables tools: `conversations_add_message`, `reactions_add`, `reactions_remove`.

### New files

- `container/skills/slack-ops/SKILL.md` — on-demand write playbook (tool names, approval phrasing, hard limits)
- `.claude/skills/add-slack-ops/SKILL.md` — host installer skill

### Fixed files

- `container/skills/slack-intel/SKILL.md:20-24` — remove stale `mcp__nanoclaw__send_message` / `target_group_jid` misdirection (that parameter doesn't exist on `send_message`); point to `/slack-ops` playbook instead

### Updated files

- `groups/global/CLAUDE.md` — capability index: Slack Intel row → combined Slack row (read+write)
- `CLAUDE.md` — skills table: add `/add-slack-ops`
- `docs/UPSTREAM-PRS.md` — note that `SLACK_MCP_ADD_MESSAGE_TOOL` flag is now set

## Slack app / OAuth changes required (human step)

At api.slack.com/apps → Almanda app → OAuth & Permissions, add bot scopes then **Reinstall to Workspace**:

- `chat:write.public` — post to public channels without /invite
- `im:write` — DM any user
- `mpim:write` — group DMs
- `reactions:write` — add emoji reactions
- `groups:write` — post to private channels bot is invited to

Note: Slack may rotate the `xoxb-` token on reinstall. Update `SLACK_BOT_TOKEN` in `.env` if so.

## Verification

1. Rebuild container + restart service
2. "What Slack tools do you have?" → agent enumerates write tools (confirms flag flip)
3. "DM andrey.o@almalabs.ai: ping" → approval prompt → DM in Andrey's Slack inbox
4. "Post to #proj-almanda: smoke test" → approval → message in channel (public, no pre-invite)
5. "React 👍 to the last message in #proj-almanda" → approval → reaction visible
6. "List my Slack DMs" → read works (regression)
7. "Post to #general: test" → approve → "no" → clean abort

## Out of scope

- xoxp user token (canvases, scheduled-as-user): future skill
- policy.json hard gates: deferred to Phase 2.5 `add-write-policy-gates`
- Message editing / deletion: different semantics, future if requested
- MCP server key rename: would break existing `mcp__slack-intel__*` allowlist and playbooks
