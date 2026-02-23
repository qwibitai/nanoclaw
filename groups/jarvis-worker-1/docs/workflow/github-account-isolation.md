# GitHub Account Isolation & Environment

Canonical reference for Jarvis's secrets, tokens, and environment setup.

## Accounts

| Account | Owner | Default context |
|---------|-------|----------------|
| `ingpoc` | User (personal) | Personal shell |
| `openclaw-gurusharan` | Jarvis | Jarvis workspace |

---

## Environment Map — What Jarvis Has, Where It Comes From

| Variable | Source | How loaded | When used |
|----------|--------|-----------|-----------|
| `GH_CONFIG_DIR` | Static path `~/.jarvis/gh-config` | `.envrc` → direnv | All gh/git operations |
| `GH_TOKEN` | gh keyring (`openclaw-gurusharan`) | `.envrc` → direnv | All git push/pull/gh CLI |
| `GITHUB_TOKEN` | Same as `GH_TOKEN` | `.envrc` → direnv | GitHub API calls |
| `ANTHROPIC_API_KEY` | macOS keychain (`jarvis-anthropic`, `openclaw-gurusharan`) | `.envrc` → direnv | Set repo secrets for `@claude` review |

**Rule:** Never hardcode tokens. Always pull from keychain dynamically.

---

## direnv — How It Works

direnv auto-loads `~/.jarvis/workspaces/.envrc` whenever Jarvis enters the workspace directory. OpenCode inherits all vars automatically.

```
cd ~/.jarvis/workspaces/
    └─► direnv loads .envrc
            ├─► GH_CONFIG_DIR=~/.jarvis/gh-config
            ├─► GH_TOKEN ← pulled live from gh keyring
            ├─► GITHUB_TOKEN=$GH_TOKEN
            └─► ANTHROPIC_API_KEY ← pulled live from macOS keychain
```

**`.envrc` contents:**

```bash
export GH_CONFIG_DIR="$HOME/.jarvis/gh-config"
export GH_TOKEN=$(GH_CONFIG_DIR="$HOME/.jarvis/gh-config" GH_TOKEN= GITHUB_TOKEN= gh auth token --hostname github.com 2>/dev/null)
export GITHUB_TOKEN=$GH_TOKEN
export ANTHROPIC_API_KEY=$(security find-generic-password -s "jarvis-anthropic" -a "openclaw-gurusharan" -w 2>/dev/null)
```

---

## Keychain Secrets

| Service | Account | Contains | Used for |
|---------|---------|---------|---------|
| `jarvis-anthropic` | `openclaw-gurusharan` | Anthropic OAuth token | GitHub Actions `@claude` review |
| macOS gh keyring | `openclaw-gurusharan` | gh OAuth token | All git/gh operations |

**Fetch manually:**

```bash
# Anthropic token
security find-generic-password -s "jarvis-anthropic" -a "openclaw-gurusharan" -w

# gh token
GH_CONFIG_DIR=~/.jarvis/gh-config gh auth token
```

---

## GitHub Isolation

- `~/.jarvis/gh-config/` contains only `openclaw-gurusharan` — `ingpoc` does not exist here
- `gh auth switch --user ingpoc` fails in Jarvis context: "no accounts matched"
- Personal shell (`~/.config/gh/`) has both accounts, `ingpoc` active

---

## Maintenance

| Issue | Fix |
|-------|-----|
| `GH_TOKEN` expired | `GH_CONFIG_DIR=~/.jarvis/gh-config gh auth refresh && direnv reload` |
| `ANTHROPIC_API_KEY` rotated | `security add-generic-password -s "jarvis-anthropic" -a "openclaw-gurusharan" -w "<new-token>" -U` |
| direnv not loading | `direnv allow ~/.jarvis/workspaces` |
| Verify env in workspace | `direnv exec ~/.jarvis/workspaces env \| grep -E "GH_|ANTHROPIC"` |

---

## Rules

- Never add `ingpoc` to `~/.jarvis/gh-config/`
- Never set `GH_TOKEN` / `GITHUB_TOKEN` / `ANTHROPIC_API_KEY` in `~/.zshrc`
- All gh operations in Jarvis context automatically use `openclaw-gurusharan`
- Tokens are always pulled dynamically — never stale, never hardcoded
