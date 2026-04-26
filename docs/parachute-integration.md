# Parachute integration

Paraclaw is the Parachute distribution of NanoClaw — same trunk, plus a small additive layer that grants each agent group access to a [Parachute Vault](https://github.com/ParachuteComputer/parachute-vault) over MCP.

## What's added

| File | Purpose |
|---|---|
| `src/container-config.ts` | `McpServerConfig` widened to a discriminated union supporting `type: 'http'` (for vault) alongside the existing stdio shape. Back-compat preserved via the `LegacyMcpServerConfig` variant. **The only edit to an existing NanoClaw file.** |
| `src/parachute/types.ts` | `VaultScope`, `VaultAttachment`, `BuildVaultMcpOpts`. |
| `src/parachute/vault-mcp.ts` | Helpers: `buildVaultMcpServer`, `attachVaultToGroup`, `detachVaultFromGroup`, `readVaultAttachment`. |
| `src/parachute/README.md` | What this directory is for, and what it deliberately doesn't do. |
| `scripts/parachute.ts` | CLI: `pnpm run parachute attach-vault <group>` / `detach-vault` / `status`. |

That's the whole footprint today. Everything else in the repo is untouched.

## Workflow

Pre-reqs: a running [Parachute Vault](https://github.com/ParachuteComputer/parachute-vault) (`parachute install vault` from the [Parachute CLI](https://github.com/ParachuteComputer/parachute-cli)) and a NanoClaw agent group already created.

```sh
# 1. Mint a scoped vault token for this claw.
parachute vault tokens create --scope vault:read --label claw-research-bot
# → pvt_...

# 2. Attach the vault to the agent group's container.json.
pnpm run parachute attach-vault research-bot --token pvt_... --scope vault:read

# 3. Send a message to the claw — NanoClaw spawns the container, which now
#    has the vault MCP available with the nine vault tools (query-notes,
#    create-note, update-note, delete-note, list-tags, update-tag,
#    delete-tag, find-path, vault-info).

# Inspect:
pnpm run parachute status               # all groups
pnpm run parachute status research-bot  # just one

# Detach (does NOT revoke the token):
pnpm run parachute detach-vault research-bot
parachute vault tokens revoke claw-research-bot
```

## What gets written

`groups/<folder>/container.json` — the existing NanoClaw config gains a new entry under `mcpServers`:

```json
{
  "mcpServers": {
    "parachute-vault": {
      "type": "http",
      "url": "http://127.0.0.1:1940/vault/default/mcp",
      "headers": { "Authorization": "Bearer pvt_..." },
      "instructions": "You have access to a Parachute Vault at ..."
    }
  }
}
```

`groups/<folder>/parachute.json` — a sibling record (separate from `container.json` so upstream NanoClaw never sees fields it doesn't know):

```json
{
  "vault": {
    "parachute-vault": {
      "vaultBaseUrl": "http://127.0.0.1:1940/vault/default",
      "scope": "vault:read",
      "tokenLabel": "claw-research-bot",
      "attachedAt": "2026-04-26T..."
    }
  }
}
```

The container reads `container.json` and uses the new entry as part of its normal MCP setup. The agent runner inside the container passes the `mcpServers` object straight through to Claude Agent SDK's `query()`, which already supports HTTP-transport MCPs natively.

## What the integration deliberately does NOT impose

- **No vault note path layout.** The agent group has access to vault; what it writes (and where) is the agent's business. We don't bake in a `claws/<name>` tree, we don't auto-mirror runs to vault, we don't auto-sync CLAUDE.md to a note. Those would impose a vault organization on every user; we don't.
- **No replacement of OneCLI.** Third-party API credentials (Telegram, Slack, OpenAI, etc.) keep flowing through OneCLI's gateway exactly as in upstream NanoClaw. Vault is for the user's knowledge graph; OneCLI is for outbound credential injection. They're complementary.
- **No replacement of the SQLite session-DB pattern.** Per-session `inbound.db` / `outbound.db` are right for transient message handling. Vault is for durable, queryable, user-facing state — different concern.
- **No web UI yet.** That's the next layer (a real Phase B add); see the top-level README's roadmap.

## Threat model

- **Token scope is the boundary.** A `vault:read` claw physically cannot create or delete vault notes. A `vault:write` claw cannot delete the vault itself or revoke other tokens. A `vault:admin` claw is fully trusted; use sparingly.
- **Token is in the container's `container.json`.** Container-side it lives in `/workspace/agent/container.json` (read-only mount). Anyone with shell access to the container can read it. That's the same posture as any other MCP credential NanoClaw handles — OneCLI gives you a stronger "credentials never enter the container" guarantee for third-party APIs but vault MCP itself uses standard Bearer auth.
- **Revocation is per-token.** `parachute vault tokens revoke <label>` invalidates the claw's access immediately. Claw will start getting 401s from vault on the next request.

## Upstream-merge stance

Everything here is additive except the `McpServerConfig` widening, which is a back-compat-preserving union. Pulling upstream NanoClaw changes should produce zero merge conflicts in the parachute layer. The McpServerConfig edit could be contributed back upstream as a stand-alone improvement (HTTP MCP support is generally useful, not Parachute-specific) — that would shrink our diff to zero NanoClaw-source edits.

## Where this is heading

See [README.md §Where this is heading](../README.md). Short version:

1. **Today (this PR):** vault attached as an HTTP MCP via CLI. Working end-to-end (assuming a NanoClaw install).
2. **Next:** web UI for managing claws — list groups, create new ones with a wizard that includes scope selection + token minting in-flow.
3. **After that:** OAuth handoff (Paraclaw web UI is an OAuth client of vault — user approves once; per-claw scoped tokens get minted automatically without ever showing a `pvt_…` to the user).
