---
name: add-group-auth
description: Per-group encrypted credential system with interactive scripted reauth flows. Each group can have its own Claude credentials, with fallback to a shared default scope.
---

# Add Per-Group Auth

This skill adds per-group encrypted credential management. Instead of a single set of .env credentials shared by all groups, each group can have its own encrypted credentials stored at `~/.config/nanoclaw/credentials/{scope}/`. Interactive reauth is triggered automatically when credentials are missing or expired.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `group-auth` is in `applied_skills`, skip to Phase 3 (Verify).

### Check current auth method

Check if `.env` has Claude credentials:

```bash
grep -q 'CLAUDE_CODE_OAUTH_TOKEN\|ANTHROPIC_API_KEY' .env && echo "Env credentials found" || echo "No env credentials"
```

Existing `.env` credentials will be automatically imported into the default scope at first startup after applying.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-group-auth
```

This deterministically:
- Adds `src/auth/` module (types, store, registry, exec, gpg, guard, provision, reauth, providers)
- Adds `container/shims/xdg-open` (blocks browser opening for console-friendly OAuth)
- Modifies `src/config.ts` to read `NEW_GROUPS_USE_DEFAULT_CREDENTIALS`
- Modifies `src/credential-proxy.ts` to make the proxy group-aware (container IP → group scope, `/claude/` service prefix, pluggable credential resolver)
- Modifies `src/container-runner.ts` to register container IP with proxy after spawn and set `ANTHROPIC_BASE_URL` with `/claude` service prefix
- Modifies `src/index.ts` to integrate auth checks, reauth, credential resolver wiring, and initialization
- Modifies `src/types.ts` to add `useDefaultCredentials` to `ContainerConfig`
- Adds `NEW_GROUPS_USE_DEFAULT_CREDENTIALS` to `.env.example`

If merge conflicts occur, read the intent files:
- `modify/src/config.ts.intent.md`
- `modify/src/container-runner.ts.intent.md`
- `modify/src/credential-proxy.ts.intent.md`
- `modify/src/index.ts.intent.md`
- `modify/src/types.ts.intent.md`

### Validate

```bash
npm run build
npx vitest run src/auth/
```

Build must be clean and all auth tests must pass before proceeding.

## Phase 3: Verify

### Restart the service

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw
```

### Check initialization

Verify the encryption key was created:

```bash
ls -la ~/.config/nanoclaw/encryption-key
```

If `.env` had credentials, check they were imported into the default scope:

```bash
ls ~/.config/nanoclaw/credentials/default/
```

### Test messaging

Send a message to a registered group. It should work identically to before — the default scope credentials are used automatically.

## Phase 4: Per-Group Credentials (Optional)

### Trigger reauth for a specific group

To give a group its own credentials, either:

1. **Remove default access**: Edit the group's registration to set `useDefaultCredentials: false`, then message the group — it will trigger an interactive reauth menu.
2. **Wait for auth failure**: If a group's credentials expire, the system automatically detects the error and prompts for reauth through the messaging channel.

### Configure default for new groups

To require per-group credentials for new groups, set in `.env`:

```
NEW_GROUPS_USE_DEFAULT_CREDENTIALS=false
```

## How It Works

**Credential proxy**: Containers route all API traffic through a host-side HTTP proxy. Two-axis identification: the URL path prefix identifies the service (`/claude/`, stripped before forwarding upstream), and the container's Docker bridge IP (`req.socket.remoteAddress`) identifies the group. The container-runner registers the IP → group mapping after spawn and unregisters on exit. The proxy looks up the group, resolves credentials from the encrypted store (falling back to `.env`-imported defaults), and injects them into the upstream request. Containers never see real credentials.

**Credential scoping**: Each group's scope is its folder name (e.g., `whatsapp_main`). The `default` scope holds credentials imported from `.env`. Resolution: group-specific → default (if allowed).

**Encryption**: AES-256-GCM with a machine-local key at `~/.config/nanoclaw/encryption-key`. Auto-generated on first run (256-bit, hex, mode 0600).

**Reauth flow**: When credentials are missing or an auth error is detected, a numbered menu is sent to the user through the messaging channel. Options: API key (GPG-encrypted), Setup token (OAuth), Auth login (OAuth).

## Troubleshooting

**Encryption key lost**: Delete credentials and re-authenticate:
```bash
rm -rf ~/.config/nanoclaw/credentials/
```

**Reauth not triggering**: Check that the channel is connected and the bot can send messages. Check logs: `tail -f logs/nanoclaw.log | grep -i auth`

**Container auth errors not detected**: Check `isAuthError()` patterns in `src/auth/providers/claude.ts`.
