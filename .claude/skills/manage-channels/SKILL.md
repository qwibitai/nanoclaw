---
name: manage-channels
description: Wire channels to agent groups, manage isolation levels, add new channel groups. Use after adding a channel, during setup, or standalone to reconfigure.
---

# Manage Channels

Wire messaging channels to agent groups. See `docs/isolation-model.md` for the full isolation model.

Privilege is a **user-level** concept, not a channel-level one (see `src/db/user-roles.ts`, `src/access.ts`). There is no "main channel" / "main group" — any user can be granted `owner` or `admin` (global or scoped to an agent group) via `grantRole()`, and messages from unknown senders are gated per-messaging-group by `unknown_sender_policy` (`strict` | `request_approval` | `public`).

## Assess Current State

Read the central DB (`data/v2.db`) — query `agent_groups`, `messaging_groups`, `messaging_group_agents`, `users`, and `user_roles` tables. Also check `.env` for channel tokens and `src/channels/index.ts` for uncommented imports.

Categorize channels as: **wired** (has DB entities + messaging_group_agents row), **configured but unwired** (has credentials + barrel import, no DB entities), or **not configured**.

If the instance has no owner yet (`SELECT COUNT(*) FROM user_roles WHERE role='owner' AND agent_group_id IS NULL` returns 0), tell the user they should run `/init-first-agent` first — it stands up the first agent group, promotes the operator to owner, and verifies delivery end-to-end by having the agent DM them. Then return here for any additional channels/groups.

## First Channel (No Agent Groups Exist)

**Delegate to `/init-first-agent`.** It handles: channel choice, operator identity lookup, DM platform id resolution (with cold-DM or pair-code fallback), agent group creation, wiring, and the welcome DM. Return here afterward for any additional channels.

## Wire New Channel

For each unwired channel:

1. Read its SKILL.md `## Channel Info` for terminology, how-to-find-id, typical-use, and default-isolation
2. Ask for the platform ID using the platform's terminology
3. Ask the isolation question (see below)
4. Ask the permission question (see below)
5. Register with the appropriate flags

### Isolation Question

Present a multiple-choice with a contextual recommendation. The three options:

- **Same conversation** (`--session-mode "agent-shared"` + existing folder) — all messages land in one session. Recommend for webhook + chat combos (GitHub + Slack).
- **Same agent, separate conversations** (`--session-mode "shared"` + existing folder) — shared workspace/memory, independent threads. Recommend for same user across platforms.
- **Separate agent** (new `--folder`) — full isolation. Recommend when different people are involved.

Use the channel's `typical-use` and `default-isolation` fields to pick the recommendation. Offer to explain more if the user is unsure — reference `docs/isolation-model.md` for the detailed explanation.

### Permission Question

Channel permission controls which direction a wiring allows. Three values:

- **`read+write`** (default) — agent receives inbound from the channel and may reply. The classic both-ways wiring.
- **`read`** — *monitor-only*. Agent sees messages but cannot send back. Use for surveillance / digest channels where the agent should observe but never disturb. Pair with a separate `write` channel where it actually responds.
- **`write`** — *post-only*. Agent can send here but messages from this channel are never delivered to it. Use for the response side of a monitor-only setup, or for one-way notification channels (e.g. an alerts log the agent posts to).

Recommend `read+write` unless the user describes a one-way use case. If they want "monitor in one channel and reply in another," wire the same agent to two messaging groups: the monitor channel as `--permission read` and the response channel as `--permission write` (or `read+write` if they also want the agent to see replies there).

### Register Command

```bash
pnpm exec tsx setup/index.ts --step register -- \
  --platform-id "<id>" --name "<name>" \
  --folder "<folder>" --channel "<type>" \
  --session-mode "<shared|agent-shared|per-thread>" \
  --permission "<read|write|read+write>" \
  --assistant-name "<name>"
```

`--permission` defaults to `read+write` when omitted, so existing setup flows behave exactly as before. The `register` step creates the agent group (reusing it if the folder already exists), the messaging group, and the wiring row. `createMessagingGroupAgent` auto-creates the companion `agent_destinations` row so the agent can address the channel by name — no separate destination step needed. The destinations row is created for `read`-only wirings too (it's used to project the channel name into the container) but the runtime delivery check in `src/delivery.ts` skips the actual write with a `log.warn`.

For separate agents, also ask for a folder name and optionally a different assistant name.

## Add Channel Group

When adding another group/chat on an already-configured platform (e.g. a second Telegram group):

1. **Telegram:** ask the isolation question first to determine intent (`wire-to:<folder>` for an existing agent, `new-agent:<folder>` for a fresh one). Run `pnpm exec tsx setup/index.ts --step pair-telegram -- --intent <intent>`, show the CODE (follow the `REMINDER_TO_ASSISTANT` line in the `PAIR_TELEGRAM_ISSUED` block) and tell the user to post `@<botname> CODE` in the target group (or DM the bot for a private chat). Wait for the `PAIR_TELEGRAM` block. The inbound interceptor has already created the `messaging_groups` row with `unknown_sender_policy = 'strict'` and upserted the paired user — `register` only needs to add the wiring:

   ```bash
   pnpm exec tsx setup/index.ts --step register -- \
     --platform-id "<PLATFORM_ID>" --name "<group-name>" \
     --folder "<folder>" --channel "telegram" \
     --session-mode "<shared|agent-shared|per-thread>" \
     --assistant-name "<name>"
   ```

2. **Other channels:** read the channel's SKILL.md `## Channel Info` for terminology and how-to-find-id. Ask for the new group/chat ID, ask the isolation question, then register. No package or credential changes needed.

## Change Wiring

1. Show current wiring (agent_groups × messaging_group_agents)
2. Ask which channel to move and to which agent group
3. Delete the old `messaging_group_agents` entry, create a new one
4. Note: existing sessions stay with the old agent group; new messages route to the new one. The `agent_destinations` row created for the old wiring is NOT automatically removed — if you want the old agent to stop seeing the channel as a named target, delete it from `agent_destinations` manually.

## Change Channel Permission

To flip an existing wiring between `read`, `write`, and `read+write` without re-creating it, update the row in place:

```bash
# Inspect current permissions
sqlite3 data/v2.db "SELECT mga.id, mg.channel_type, mg.platform_id, mga.permission \
                    FROM messaging_group_agents mga \
                    JOIN messaging_groups mg ON mg.id = mga.messaging_group_id \
                    WHERE mga.agent_group_id = '<agent-group-id>';"

# Flip to monitor-only on a specific wiring
sqlite3 data/v2.db "UPDATE messaging_group_agents SET permission='read' WHERE id='<mga-id>';"
```

The host re-reads the wiring on every inbound and every outbound message, so changes take effect on the next message — no service restart needed.

## Show Configuration

Display a readable summary showing:

- **Agent groups** with their wired channels (from `messaging_group_agents`)
- **Configured-but-unwired** channels (credentials present, no DB entities)
- **Unconfigured** channels
- **Privileged users**: `SELECT user_id, role, agent_group_id FROM user_roles ORDER BY role='owner' DESC`
