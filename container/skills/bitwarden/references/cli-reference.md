# Bitwarden CLI Reference

## Install

```bash
# macOS
brew install bitwarden-cli

# Ubuntu/Debian (snap)
sudo snap install bw

# Any OS (npm)
npm install -g @bitwarden/cli
```

## Authentication

### API Key login (non-interactive, for machines/agents)

```bash
export BW_CLIENTID="user.xxxxx"
export BW_CLIENTSECRET="xxxxx"
bw login --apikey
```

Get API key from: Web Vault → Settings → Security → Keys → API Key

### Email login (interactive)

```bash
bw login user@example.com
```

### Unlock (required after login)

```bash
# Interactive (preferred)
bw unlock

# Non-interactive via env var
# ⚠️ Never pass master password as a CLI argument — visible in `ps aux`
read -s BW_MASTER_PASSWORD && export BW_MASTER_PASSWORD
export BW_SESSION=$(bw unlock --passwordenv BW_MASTER_PASSWORD --raw)
unset BW_MASTER_PASSWORD  # Don't leave this set
```

## Common Operations

```bash
# List all items
bw list items | jq '.[] | .name'

# Get item by name
bw get item "my-secret" | jq -r '.notes'

# Get item by ID
bw get item <uuid>

# Search
bw list items --search "discord"

# List by collection
bw list items --collectionid <uuid>

# List collections
bw list collections

# List organizations
bw list organizations

# Sync from server
bw sync

# Lock vault
bw lock

# Logout
bw logout
```

## Item Types

| Type        | Value | Description       |
| ----------- | ----- | ----------------- |
| Login       | 1     | Username/password |
| Secure Note | 2     | Free-text notes   |
| Card        | 3     | Credit card       |
| Identity    | 4     | Personal info     |

## Creating Items

```bash
# Get template
bw get template item

# Create secure note
bw get template item | jq \
  --arg notes "export MY_KEY=my_value" \
  --arg name "my-note" \
  '.type = 2 | .secureNote.type = 0 | .notes = $notes | .name = $name' \
  | bw encode | bw create item

# Create in org collection
bw get template item | jq \
  --arg notes "export MY_KEY=my_value" \
  --arg name "my-note" \
  --arg orgId "<org-uuid>" \
  --argjson colIds '["<collection-uuid>"]' \
  '.type = 2 | .secureNote.type = 0 | .notes = $notes | .name = $name | .organizationId = $orgId | .collectionIds = $colIds' \
  | bw encode | bw create item
```

## Environment Variables

| Variable             | Purpose                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `BW_SESSION`         | Session token (from unlock)                                                |
| `BW_CLIENTID`        | API key client ID                                                          |
| `BW_CLIENTSECRET`    | API key client secret                                                      |
| `BW_MASTER_PASSWORD` | Master password (for `--passwordenv`) — **unset immediately after unlock** |
