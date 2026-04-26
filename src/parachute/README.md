# src/parachute/

Parachute integration for Paraclaw — additive on top of NanoClaw's trunk.

## What this brings

Each NanoClaw agent-group gets optional access to a [Parachute Vault](https://github.com/ParachuteComputer/parachute-vault). The vault is the user's open knowledge graph — notes, tags, links, structured metadata — already running on their machine and already used by every other AI client they've connected (Claude Code, Notes, etc.).

Composing the two:

- **Each claw gets a scoped vault token** (`vault:read` / `vault:write` / `vault:admin`) at attach time. Token-as-capability is the boundary; the agent literally can't exceed its scope.
- **The vault MCP server is wired into the agent's container** as an `http` transport entry in `container.json`. The agent uses the same nine MCP tools any other Parachute client gets (`query-notes`, `create-note`, `update-note`, etc.).
- **What the claw does with vault access is up to the claw.** This integration grants capability; it doesn't dictate convention. A claw might write nothing to vault (read-only researcher); another might capture every message into structured note paths; another might not use vault at all even though it has access. The framework is opinion-free here.

## Files

- **`vault-mcp.ts`** — pure helpers: `buildVaultMcpServer(opts)` constructs the `McpServerConfig` for a vault attach, `attachVaultToGroup(folder, opts)` upserts that entry into the group's `container.json`, `detachVaultFromGroup(folder, name)` removes it.
- **`types.ts`** — narrow types for vault attachments + scope strings.

The matching CLI surface lives in [`scripts/parachute.ts`](../../scripts/parachute.ts) (`pnpm run parachute attach-vault <group>` etc.).

## What we deliberately do NOT do here

- **No vault note path conventions.** No `claws/<name>` tree, no auto-mirroring of agent runs to vault, no auto-CLAUDE.md sync. Those would impose a vault layout on every user; we don't.
- **No replacement of OneCLI.** Third-party API credentials (Telegram bot tokens, OpenAI keys, etc.) keep flowing through OneCLI's gateway exactly as in upstream NanoClaw. Vault is for the user's knowledge graph; OneCLI is for outbound credential injection. They're complementary, not competing.
- **No replacement of NanoClaw's SQLite session queues.** Per-session inbound.db / outbound.db are the right pattern for transient message handling. Vault is for durable, queryable, user-facing state — different concern.

## Upstream-merge stance

Everything in this directory is **additive** — new files, no edits to existing NanoClaw source files. The one exception is the type widening in [`src/container-config.ts`](../container-config.ts) that adds `HttpMcpServerConfig` to the `McpServerConfig` union (back-compat preserved via the `LegacyMcpServerConfig` variant). That edit is small enough to merge upstream cleanly, and could be contributed back to qwibitai/nanoclaw as a stand-alone improvement (HTTP MCP support is generally useful, not Parachute-specific).
