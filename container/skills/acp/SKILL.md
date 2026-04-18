---
name: acp
description: Delegate sub-tasks to remote ACP (Agent Client Protocol) peers such as Claude Code or Codex via the built-in acp_* host actions. Use when the user asks to hand work to another agent, wants a second opinion, or needs long / sandboxed execution that shouldn't block this chat.
---

# /acp — Delegate to remote agents

Five host-side actions are registered automatically when the AgentLite host has ACP peers configured:

- `acp_list_remote_agents`
- `acp_new_session`
- `acp_prompt`
- `acp_cancel`
- `acp_close_session`

These are **host actions**, not direct MCP tools. Reach them through `mcp__agentlite__call_action` (and `mcp__agentlite__search_actions` to discover / introspect). If `search_actions` with query `"+acp"` returns nothing, no peers are configured and this skill does not apply.

## When to use

- User says "ask codex", "hand this to claude code", "have <peer> do X".
- A coding task is long, needs a sandboxed runner, or benefits from a second agent's judgment.
- You want parallel work on a sibling directory without blocking this conversation.

Do **not** use ACP for anything you can finish in this turn — delegation has a round-trip cost and the result arrives as a later chat message, not inline.

## Flow

Each step is a `call_action` invocation: `call_action({ name: "<action>", payload: {...} })`.

1. **Discover** — `call_action({ name: "acp_list_remote_agents" })` returns `{ agents: [{ name, description?, agent_info? }] }`. Skip if the user already named a peer.
2. **Open** — `call_action({ name: "acp_new_session", payload: { peer, cwd? } })` → `{ session_id }`. `cwd` defaults to the caller group's workdir; override only when the user points at a specific path.
3. **Prompt** — `call_action({ name: "acp_prompt", payload: { session_id, prompt: ContentBlock[] } })` → `{ ok: true }`. Returns immediately. The peer runs in the background; AgentLite writes an artifact and injects a completion notice into this chat when it finishes. **Do not poll.**
4. **Cancel (optional)** — `call_action({ name: "acp_cancel", payload: { session_id } })` if the user changes their mind while a prompt is in-flight. You'll still get a terminal notice with `stop_reason: "cancelled"`.
5. **Close** — `call_action({ name: "acp_close_session", payload: { session_id } })` when the conversation is over. The peer child process stays alive for reuse; only local tracking is dropped.

Acknowledge the hand-off in one line ("Sent to codex — I'll ping when it's back") and stop. The completion notice arrives as its own message.

## ContentBlock shape

`prompt` is the ACP spec array. Most of the time you just want:

```json
[{ "type": "text", "text": "Summarize README.md in three bullets." }]
```

Other block types (`image`, `audio`, `resource_link`) are only valid if the peer's `agent_info` advertised the matching `promptCapabilities`.

## Pitfalls

- **Session / peer mismatch** — a `session_id` belongs to exactly one peer. Don't reuse it across peers.
- **Polling** — there is no `acp_get_result`. The notice will arrive on its own; asking the user "any update?" is wrong.
- **Forgetting cwd** — if the user names a subproject, pass its absolute path as `cwd` in `acp_new_session`; otherwise the peer runs in the group folder and can't see the code.
- **Synchronous assumptions** — `acp_prompt` returning `{ ok: true }` means "queued", not "done".
- **Skipping search_actions** — if you're unsure whether ACP is wired up on this host, `search_actions({ query: "+acp" })` is the authoritative check.

**See also:** `/capabilities` for the full MCP tool surface; `/status` for a quick health check.
