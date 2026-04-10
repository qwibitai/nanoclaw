---
name: bitwarden
description: >
  Manage secrets via Bitwarden CLI (bw). Use when pulling secrets into a shell session,
  creating/updating Secure Notes from .env files, listing vault items, or setting up
  Bitwarden on a new machine. Secrets live in Bitwarden, get loaded into memory on demand,
  and die with the shell session — no files on disk.
homepage: https://bitwarden.com/help/cli/
metadata:
  {
    "openclaw":
      {
        "emoji": "🔐",
        "requires": { "bins": ["bw", "jq"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "bitwarden-cli",
              "bins": ["bw"],
              "label": "Install Bitwarden CLI (brew)",
            },
            {
              "id": "snap",
              "kind": "shell",
              "command": "sudo snap install bw",
              "bins": ["bw"],
              "label": "Install Bitwarden CLI (snap)",
            },
            {
              "id": "npm",
              "kind": "shell",
              "command": "npm install -g @bitwarden/cli",
              "bins": ["bw"],
              "label": "Install Bitwarden CLI (npm)",
            },
          ],
      },
  }
---

# Bitwarden CLI — Secrets Management

## Core Concept

Secrets are stored as Bitwarden **Secure Notes** with `export KEY='value'` lines in the notes field.
One `eval` call loads them into the current shell. No files on disk. Secrets die with the session.

## Shell Functions

All functions ship in **`lib/bw-functions.sh`** — source it in your shell profile. No copy-pasting, no dotfiles dependency.

### Setup on a new machine

```bash
# 1. Install bw CLI
brew install bitwarden-cli    # macOS
sudo snap install bw          # Ubuntu
npm i -g @bitwarden/cli       # any OS

# 2. Install skill (choose one)
npx clawhub install bitwarden-bwe            # via ClawHub
# or: git clone https://github.com/stevengonsalvez/clawdbot /path/to/clawdbot

# 3. Source functions in your shell profile
echo 'source /path/to/skills/bitwarden-bwe/lib/bw-functions.sh' >> ~/.bashrc
source ~/.bashrc

# 4. Login + unlock
export BW_CLIENTID="user.xxxxx"
export BW_CLIENTSECRET="xxxxx"
bw login --apikey
bwss   # unlock (prompts for master password)

# 5. Verify
bwl    # list vault items
```

### What's in `lib/bw-functions.sh`

| Function            | Purpose                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `bwss`              | Unlock vault, set `BW_SESSION` interactively                                              |
| `bwe <name>`        | Load secrets from Secure Note into env via `eval`                                         |
| `bwe_safe <name>`   | Same, but only evals lines matching `export VAR=value` — defence-in-depth for shared orgs |
| `bwc <name> [file]` | Create Secure Note from `.env` file (auto-quotes values, uses `mktemp` + `chmod 600`)     |
| `bwce <name>`       | Create Secure Note from current shell exports                                             |
| `bwdd <name>`       | Delete item by name                                                                       |
| `bwl`               | Alias: list all item names                                                                |
| `bwll <grep>`       | Alias: search item names                                                                  |
| `bwg <name>`        | Alias: get full item JSON                                                                 |

**Notes on `bwe_safe`:** Guards against non-export lines being injected but does **not** sanitize values — a value containing `$(cmd)` or backticks would still execute during `eval`. If someone has write access to your Bitwarden vault, you have bigger problems. Use on shared org accounts as a defence-in-depth layer.

## References

- `lib/bw-functions.sh` — sourceable shell functions (the canonical implementation)
- `references/cli-reference.md` — Bitwarden CLI install, auth, and common operations

## Workflow

### Daily use

```bash
bwss                     # Unlock vault (once per terminal session)
bw sync                  # Pull latest from server (if secrets were updated in web vault)
bwe agent-fleet          # Load all agent secrets
echo $ANTHROPIC_API_KEY  # Verify — should be set
```

### Creating / updating secrets

```bash
# From a .env file
bwc my-new-project .env

# From current shell
bwce snapshot-2026-03-03

# Update an existing note (delete + recreate)
bwdd old-note
bwc old-note .env.updated

# Or edit in web vault — notes field, one `export KEY='value'` per line
```

### Org + Collection pattern (team/fleet use)

For sharing secrets with a machine account (e.g., GCP VM):

1. **Create a Bitwarden Organization** (free tier = 2 users)
2. **Create a Collection** in the org (e.g., `popa-secrets`)
3. **Create a machine account** — separate Bitwarden account, invited to org, assigned to the collection
4. **Add Secure Notes** to the collection with `export KEY='value'` format
5. **On the target machine:** install skill, source `lib/bw-functions.sh`, login with machine account API key, `bwss`, `bwe <note>`

The machine account sees ONLY items in its assigned collection. Revoke access = remove from org. One click.

### Creating items in a collection (programmatic)

```bash
COLLECTION_ID="<collection-uuid>"
ORG_ID="<org-uuid>"
NOTES=$(cat .env | awk '{print "export " $0}')

bw get template item | jq \
  --arg notes "$NOTES" \
  --arg name "my-item" \
  --arg orgId "$ORG_ID" \
  --argjson colIds "[\"$COLLECTION_ID\"]" \
  '.type = 2 | .secureNote.type = 0 | .notes = $notes | .name = $name | .organizationId = $orgId | .collectionIds = $colIds' \
  | bw encode | bw create item
```

### Listing collections and orgs

```bash
bw list organizations | jq '.[] | {id, name}'
bw list collections | jq '.[] | {id, name}'
bw list items --collectionid <id> | jq '.[] | .name'
```

## Secure Note Format

Each Secure Note's `notes` field contains one secret per line:

```
export ANTHROPIC_API_KEY='sk-ant-...'
export OPENAI_API_KEY='sk-proj-...'
export DISCORD_TOKEN='MTQ3...'
```

**Rules:**

- One `export KEY='value'` per line
- **Always single-quote values.** Unquoted values containing `|`, `!`, `#`, `$`, backticks, or other shell metacharacters will break or execute during `eval`. Single quotes prevent this.
- No comments, no blank lines (they get eval'd)
- Keys should be `UPPER_SNAKE_CASE`
- If a value itself contains a single quote, use `'\''` to escape it: `export KEY='value'\''s edge case'`
- Never put shell commands in values

## Guardrails

- **Never paste secrets into chat, logs, or code.** Use `bwe` to load into memory only.
- **Never write secrets to disk** unless absolutely necessary (and chmod 600 if you must).
- **Prefer `bwe` over `~/.secrets/` files.** Secrets in memory > secrets on disk.
- **Use `bwe_safe` on shared/org accounts.** Defence in depth against note tampering.
- **`bwss` once per terminal session.** The session token persists until the shell exits.
- **Sync before pulling:** `bw sync` if you've recently updated secrets in the web vault.
- **Lock when done:** `bw lock` to clear the session token.

## Tmux Considerations

If using `bw` inside tmux (common for agents), the `BW_SESSION` env var must be available in the tmux pane. Either:

- Run `bwss` inside the tmux pane, or
- Export `BW_SESSION` before creating the tmux session

```bash
# Option 1: unlock inside tmux (preferred — interactive, no password in process list)
tmux new-session -d -s work
tmux send-keys -t work 'bwss' Enter
# ... wait for unlock prompt, enter master password ...
tmux send-keys -t work 'bwe agent-fleet' Enter

# Option 2: pass session token via env var (non-interactive)
# ⚠️ Never pass the master password as a CLI argument — it's visible in `ps aux`.
# Use --passwordenv instead:
read -s BW_MASTER_PASSWORD && export BW_MASTER_PASSWORD
export BW_SESSION=$(bw unlock --passwordenv BW_MASTER_PASSWORD --raw)
unset BW_MASTER_PASSWORD
tmux new-session -d -s work -e "BW_SESSION=$BW_SESSION"
tmux send-keys -t work 'bwe agent-fleet' Enter
```

## Quick Reference

| Command             | What it does                     |
| ------------------- | -------------------------------- |
| `bwss`              | Unlock vault, set BW_SESSION     |
| `bwe <name>`        | Load secrets from note into env  |
| `bwe_safe <name>`   | Same, with input validation      |
| `bwc <name> [file]` | Create note from .env file       |
| `bwce <name>`       | Create note from current exports |
| `bwdd <name>`       | Delete item by name              |
| `bwl`               | List all item names              |
| `bwll <grep>`       | Search item names                |
| `bwg <name>`        | Get full item JSON               |
| `bw sync`           | Pull latest from server          |
| `bw lock`           | Clear session token              |
