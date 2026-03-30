---
name: add-1password
description: Add 1Password credential management so agents can securely retrieve, create, and update passwords.
---

# Add 1Password

Adds a 1Password MCP server to container agents for secure credential retrieval and management. Agents can look up, create, and update passwords without credentials appearing in chat history.

## Prerequisites

- A 1Password account with [Service Accounts](https://developer.1password.com/docs/service-accounts/) enabled
- A service account token with access to the vaults you want agents to use

## Step 1: Merge the skill branch

```bash
git fetch upstream skill/1password
git merge upstream/skill/1password
```

Resolve any conflicts if prompted.

## Step 2: Set up the service account token

```bash
mkdir -p ~/.1password-mcp
```

Save your 1Password service account token to `~/.1password-mcp/token`. The file should contain just the token string.

## Step 3: Rebuild

```bash
npm run build
./container/build.sh
```

## Step 4: Verify

Restart NanoClaw and ask the agent to list 1Password vaults. It should have access to these tools:

| Tool | Purpose |
|------|---------|
| `list_vaults` | List all accessible vaults |
| `search_items` | Search by title, URL, tag, or field label |
| `get_secret` | Retrieve a secret value (`op://vault/item/field`) |
| `create_item` | Create a new login item (auto-generates password if omitted) |
| `update_item` | Update, add, or remove fields on an existing item |

## How it works

- Token mounted read-only from `~/.1password-mcp/` into the container
- MCP server only registers if token file is present
- Credentials never appear in chat logs — retrieved at use time
- 5-minute cache reduces API calls for vault listings
- Only main group containers get 1Password access

## Uninstalling

```bash
git log --merges --oneline | grep 1password
git revert -m 1 <merge-commit>
npm run build && ./container/build.sh
```
