---
name: host-actions
description: Recognize when a user is requesting something that requires host-side action — new channels, groups, mounts, credentials, access control — and guide them to the correct host command. Use when the user's request can't be fulfilled from inside the container.
---

# Host Actions

Some things can't be done from inside your container — they require the user (or an admin) to run a command on the host where NanoClaw is installed. Your job is to recognize these requests, ask the right clarifying questions, and give the user a clear next step.

## How to direct the user

All host actions are skills run in the NanoClaw project directory using the coding agent on the host. Tell the user:

> Open your coding agent in the NanoClaw directory and run `/<skill-name>`.

If the user doesn't know what that means, they can SSH into (or open a terminal on) the machine running NanoClaw, `cd` to the project folder, open their coding agent, and type the skill command.

Don't try to run these yourself — you don't have access to the host.

---

## 1. Channel & Group Management

### Recognize

The user wants to change where or how you're reachable. Phrasings vary widely:

- "Add you to another group / chat / channel"
- "I want my friend to talk to you but not see our messages"
- "Can you join this Telegram group?"
- "I want a separate conversation for work stuff"
- "Register a new group"
- "Start a new agent for X"
- "I want to add you to a group with a specific use case"

The underlying intent is one of: **(a)** wire an existing agent to a new messaging group, **(b)** create a new agent group and wire it to a new messaging group, or **(c)** change how an existing wiring works (isolation, trigger rules).

### Clarify

Before routing, narrow down what they need:

1. **Same agent or new agent?** — Same agent means shared personality, memory, and container config. New agent means a fresh slate — separate memory, separate CLAUDE.md, potentially different behavior.
2. **Privacy** — Should the new group see this conversation's history or context? If not, a new agent group gives clean isolation. If shared context is fine, wiring the existing agent group to a new messaging group works.
3. **Channel** — Is this on the same platform (e.g., another Telegram group) or a different one (e.g., adding Discord)?

### Route

→ **`/manage-channels`** on the host. It gives an overview of current wiring and lets the user add, modify, or remove channel-to-agent mappings.

If the user wants a platform that isn't installed yet, see **New Channel Type** below — that comes first.

---

## 2. New Channel Type

### Recognize

The user wants to reach you on a platform that isn't currently set up:

- "Can you be on Discord / Slack / WhatsApp too?"
- "I want to talk to you from my phone" (implies a mobile-friendly channel)
- "Do you support X?"
- "Add Telegram"

### Clarify

1. **Which platform?** — If ambiguous ("from my phone"), help them pick: Telegram and WhatsApp are common for mobile; Slack and Discord for team use; iMessage for Apple users.
2. **Who will use it?** — Just them, or others too? This affects whether it wires to their existing agent group or needs a new one (which becomes a `/manage-channels` question after install).

### Route

→ **`/add-<channel>`** on the host (e.g., `/add-discord`, `/add-telegram`, `/add-whatsapp`). This installs the channel adapter, sets up credentials, and builds.

After the adapter is installed, they'll likely also need **`/manage-channels`** to wire it to an agent group.

---

## 3. File & Directory Access (Mounts)

### Recognize

The user wants you to access files on the host machine:

- "Can you see my project files?"
- "I need you to work on code in /home/user/myproject"
- "Access my documents"
- "Mount my repo"
- "Can you read/edit files outside your workspace?"

### Clarify

1. **Which directory?** — Get the full path on the host.
2. **Read-only or read-write?** — If they want you to edit files, it needs to be read-write. If just referencing or searching, read-only is safer.
3. **Which agent?** — For this agent group only, or all agents?

### Route

→ **`/manage-mounts`** on the host. It shows current mounts and lets the user add or remove directory access for agent containers.

After a mount is added, the container needs to restart for the new mount to take effect.

---

## 4. Credentials & Authentication

### Recognize

The user wants you to access an external service, or something that should work is returning auth errors:

- "Use my GitHub / OpenAI / Vercel token"
- "Why can't you access X API?"
- "Auth isn't working" / "I'm getting 401 errors"
- "Connect to my account on X"
- "I want you to be able to post to X service"
- "How do I give you access to Y?"

Also recognize **your own symptoms**: if you hit a 401/403 from an API and the user hasn't mentioned credentials, proactively explain that the credential likely needs to be added on the host.

### Clarify

1. **Which service?** — Identify the API or platform.
2. **Do they have the credential?** — API key, token, OAuth setup — do they already have it, or do they need to create one first?
3. **First time or broken?** — If credentials were working before and stopped, it might be an expiry issue or secret-mode misconfiguration rather than a missing credential.

### Route

Three possible paths depending on the situation:

- **Adding a new credential** → `onecli secrets create` on the host. The user provides the API key/token and the host pattern it applies to. Once added, no container restart is needed — the proxy picks it up on the next request.
- **Credential exists but agent can't see it** → `onecli agents set-secret-mode` on the host. New agents start in `selective` mode, meaning no secrets are assigned by default even if they exist in the vault. The user needs to either switch to `all` mode or assign specific secrets.
- **OneCLI not set up yet** → `/init-onecli` on the host to install the vault and migrate any `.env` credentials.

**Tip for the user:** they can also open the OneCLI web UI at `http://127.0.0.1:10254` for a visual interface to manage secrets and agent permissions.

---

## 5. Access Control

### Recognize

The user wants to manage who can interact with you:

- "Let my friend / coworker talk to you"
- "Make X an admin"
- "Who has access to you?"
- "Remove access for Y"
- "I don't want Z to be able to message you"
- "Can someone else approve things while I'm away?"

### Clarify

1. **Add or remove?** — Are they granting or revoking access?
2. **What level?** — Regular access (can message the agent) vs. admin (can approve installs, credential use, etc.) vs. owner.
3. **Which agent group?** — All agents or a specific one? Admin roles can be scoped to a single agent group or global.
4. **Which channel?** — The person needs to be reachable on a channel the agent is wired to. If they're on a different platform, channel setup comes first.

### Route

→ **`/manage-channels`** on the host covers the wiring side (making sure the person's chat is connected to an agent group).

User roles (admin, owner) are managed in the central database. The user can manage these through the host CLI.

---

## General Guidance

- **Don't guess which action the user needs.** Many requests sound similar ("add my friend" could be access control, channel wiring, or both). Ask one or two clarifying questions before routing.
- **Combine when needed.** A request like "I want my coworker to use you on Slack" might need all three: `/add-slack` (new channel), `/manage-channels` (wire it), and access control (grant the coworker access). Walk through the steps in order.
- **Be specific about what happens.** Don't just say "run /manage-channels" — explain what it will let them do in the context of their request. "Run /manage-channels on the host — it'll let you wire this Telegram group to a new agent so your friend gets a clean, private conversation."
