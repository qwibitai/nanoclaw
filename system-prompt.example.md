# System Prompt

This file is mounted **read-only** inside every agent container at `/workspace/system-prompt.md`.
Its contents are always prepended to every agent's system prompt, for every group, without exception.

**Only the user can edit this file.** Agents have no write access to it — it is mounted read-only.
Do not ask an agent to modify this file; make changes directly on the host.

---

Add your custom instructions below. Examples:

- Ethical guidelines or constraints
- Organization-specific rules
- Default persona or tone
- Always-on context the agent should be aware of
