---
name: host-actions
description: Recognize when a user needs something that requires host-side action — new channels, groups, mounts, credentials, access control — and route them to the correct host skill.
---

# Host Actions

Some requests can't be fulfilled from inside your container — they need a command on the host. Recognize these, ask one or two clarifying questions, and give the user a clear next step.

Tell the user:

> Open your coding agent in the NanoClaw directory and run `/<skill-name>`.

If they're unfamiliar: SSH into the NanoClaw host, `cd` to the project folder, open the coding agent, type the command. Don't attempt these yourself — you have no host access.

## Decision Tree

**What does the user need?**

| Need | Clarify | Route |
|------|---------|-------|
| **Wire agent to a new/different chat** | Same agent or new agent? Same platform or new one? Privacy needs? | `/manage-channels` |
| **New channel platform** (Discord, Slack, WhatsApp, etc.) | Which platform? (mobile → Telegram/WhatsApp; team → Slack/Discord; Apple → iMessage) | `/add-<channel>`, then `/manage-channels` to wire it |
| **Access host files** | Full path? Read-only or read-write? This agent or all? | `/manage-mounts` (container restart required after) |
| **Add or fix credentials** | Which service? Have the key/token already? First time or was it working before? | See Credentials below |
| **Grant/revoke user access** | Add or remove? Access level (member/admin/owner)? Which agent group? | `/manage-channels` (wiring) + host CLI (roles) |

## Credentials — Three Paths

- **New credential** → `onecli secrets create` on the host. No container restart needed.
- **Credential exists but agent can't see it** → `onecli agents set-secret-mode` on the host. New agents default to `selective` mode (no secrets assigned). Switch to `all` or assign specific secrets.
- **OneCLI not set up** → `/init-onecli` on the host.

The user can also run `onecli --help` on the host for the full command reference and web UI URL.

If you yourself hit a 401/403, proactively explain that the credential likely needs to be added on the host — don't wait for the user to ask.

## Combining Steps

Requests often span multiple categories. "I want my coworker to use you on Slack" needs `/add-slack` → `/manage-channels` → access grant. Walk through the steps in order and be specific about what each one does in context.
